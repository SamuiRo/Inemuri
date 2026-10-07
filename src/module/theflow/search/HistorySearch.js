import { FLOW_SEARCH } from "../../../config/app.config.js";
import { DAY } from "../../../shared/time.js";
import database from "../../teapot/sqlite/sqlite_db.js";
import { Source, Cluster } from "../../teapot/models/index.js";
import { toSqliteDate } from "../../teapot/models/Post.js";
import { decodeEmbedding, cosine } from "../dedup/DedupCore.js";

/**
 * TheFlow — пошук по історії (ROADMAP §9.1).
 *
 * Два рівні:
 *
 *   keyword   FTS5 над text_en / raw_text / title (міграція 012). Нуль
 *             запитів до провайдера, працює з вичерпаною квотою — і чесно
 *             покриває більшість реальних питань: «що було про Hamster»,
 *             «згадки $ARB» — це пошук сутностей, де слова б'ють семантику.
 *   semantic  один embed() запиту з пріоритетом `low`, далі косинус по
 *             постах тієї ж моделі (§13.2 — не порівнювати моделі).
 *             Повтор того самого запиту — з кешу gateway, безкоштовно.
 *
 * Фільтри (topic, signal, days, source) — звичайний SQL по індексу
 * (topic, signal_type, posted_at). Результати згортаються по кластеру: одна
 * подія — один рядок, «×N» — скільки каналів про неї писали.
 *
 * Модуль не знає Discord: `/search` питає його через EventBus
 * ("theflow.search"), CLI викликає напряму.
 */

const SNIPPET = 160;
const MAX_LIMIT = 25;
// Без фільтра days семантика перебирає FLOW_SEARCH.semanticMaxRows найсвіжіших
// векторів. Дефолтного вікна в днях немає: корпус може бути історією каналу
// (пілот — пости за травень–липень), і вікно «30 днів» відсікало все.
// Косинус по 20k векторах — десятки мілісекунд.
// Нижче цього схожість — шум: краще «нічого не знайдено», ніж випадкові пости.
const MIN_SEMANTIC_S = 0.5;

/**
 * Текст користувача → запит FTS5. Кожне слово — префікс у лапках
 * (`"розыгр"*`): лапки роблять будь-який символ безпечним для синтаксису
 * FTS, префікс ловить відмінки й закінчення. Слова через пробіл — AND.
 * `$ARB` → `"arb"*`: unicode61 і так ріже `$`.
 *
 * @returns {string|null}  null — нічого шукати.
 */
export function buildFtsQuery(text) {
  const tokens = String(text ?? "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const useful = [...new Set(tokens.filter((t) => t.length >= 2))].slice(0, 8);
  if (useful.length === 0) return null;
  return useful.map((t) => `"${t}"*`).join(" ");
}

/**
 * Посилання на оригінал: для Telegram — t.me/c/… (для учасника каналу; id
 * повідомлення — external_id), для Reddit/RSS — external_url. Інакше null.
 */
export function telegramLink(post) {
  if ((post.platform ?? "telegram") !== "telegram") return post.external_url ?? null;
  const ch = String(post.channel_id ?? "");
  const msg = String(post.external_id ?? "");
  if (!/^-100\d+$/.test(ch) || !/^\d+$/.test(msg)) return null;
  return `https://t.me/c/${ch.slice(4)}/${msg}`;
}

export function snippet(text, max = SNIPPET) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Одна подія — один рядок: з кожного кластера лишається найкращий за
 * рангом пост. Пости без кластера — кожен сам по собі.
 */
export function collapseByCluster(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.cluster_id != null) {
      if (seen.has(r.cluster_id)) continue;
      seen.add(r.cluster_id);
    }
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function clampLimit(n, fallback = 10) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_LIMIT) : fallback;
}

/**
 * Результат → текст (Discord і CLI). Чиста функція.
 * @param {object} res  Результат HistorySearch.search().
 */
export function formatResults(res) {
  const head = `🔎 ${res.mode} · "${res.query}"` + (res.filtersText ? ` · ${res.filtersText}` : "");
  if (res.error) return `${head}\n❌ ${res.error}`;
  if (res.results.length === 0) return `${head}\nNothing found.${res.note ? ` ${res.note}` : ""}`;
  const lines = [head];
  for (const r of res.results) {
    const when = r.when ? r.when.slice(0, 10) : "????-??-??";
    const axes = r.topic ? `${r.topic}/${r.signal_type}` : r.status;
    const score = res.mode === "semantic" ? ` · s=${r.score.toFixed(2)}` : "";
    const cluster = r.members > 1 ? ` · ×${r.members}` : "";
    lines.push(`**#${r.id}** ${when} · ${axes} · ${r.source ?? "?"}${cluster}${score}`);
    lines.push(`> ${r.snippet}`);
    if (r.link) lines.push(`<${r.link}>`);
  }
  if (res.note) lines.push(`_${res.note}_`);
  return lines.join("\n");
}

function filtersText(f) {
  const parts = [];
  if (f.topic) parts.push(`topic ${f.topic}`);
  if (f.signal) parts.push(`signal ${f.signal}`);
  if (f.days) parts.push(`${f.days}d`);
  if (f.sourceId) parts.push(`source #${f.sourceId}`);
  return parts.join(", ");
}

export class HistorySearch {
  /**
   * @param {{ gateway?: object|null, now?: () => number }} [deps]
   *   `gateway` — LLMGateway для semantic; без нього доступний лише keyword.
   */
  constructor({ gateway = null, now = Date.now, semanticMaxRows = FLOW_SEARCH.semanticMaxRows } = {}) {
    this.gateway = gateway;
    this.now = now;
    this.semanticMaxRows = semanticMaxRows;
  }

  /**
   * @param {{ query: string, mode?: "keyword"|"semantic", topic?: string,
   *           signal?: string, days?: number, sourceId?: number, limit?: number }} input
   */
  async search(input = {}) {
    const query = String(input.query ?? "").trim();
    const mode = input.mode === "semantic" ? "semantic" : "keyword";
    const filters = {
      topic: input.topic || null,
      signal: input.signal || null,
      days: Number(input.days) > 0 ? Number(input.days) : null,
      sourceId: Number(input.sourceId) > 0 ? Number(input.sourceId) : null,
    };
    const limit = clampLimit(input.limit);
    const base = { mode, query, filtersText: filtersText(filters), results: [] };

    let res;
    if (!query) res = { ...base, error: "empty query" };
    else if (mode === "semantic") res = await this._semantic(base, filters, limit);
    else res = await this._keyword(base, filters, limit);
    return { ...res, text: formatResults(res) };
  }

  _where(filters, alias = "p") {
    const sql = [`${alias}.status NOT LIKE 'skipped%'`];
    const params = [];
    if (filters.topic) { sql.push(`${alias}.topic = ?`); params.push(filters.topic); }
    if (filters.signal) { sql.push(`${alias}.signal_type = ?`); params.push(filters.signal); }
    if (filters.sourceId) { sql.push(`${alias}.source_id = ?`); params.push(filters.sourceId); }
    if (filters.days) {
      sql.push(`COALESCE(${alias}.posted_at, ${alias}.createdAt) >= ?`);
      params.push(toSqliteDate(new Date(this.now() - filters.days * DAY)));
    }
    return { sql: sql.join(" AND "), params };
  }

  async _keyword(base, filters, limit) {
    const match = buildFtsQuery(base.query);
    if (!match) return { ...base, error: "the query has no searchable words" };
    const where = this._where(filters);
    // bm25: заголовок і text_en важать більше за оригінал — raw_text часто
    // дублює те саме іншою мовою і роздуває ранг довгих постів.
    const [rows] = await database.sequelize.query(
      "SELECT p.id, p.source_id, p.platform, p.channel_id, p.external_id, p.external_url, " +
        "p.posted_at, p.createdAt, p.topic, p.signal_type, p.status, p.cluster_id, p.text_en, p.raw_text, " +
        "bm25(posts_fts, 3.0, 1.0, 4.0) AS rank " +
        "FROM posts_fts JOIN posts p ON p.id = posts_fts.rowid " +
        `WHERE posts_fts MATCH ? AND ${where.sql} ORDER BY rank LIMIT ?`,
      { replacements: [match, ...where.params, limit * 4] },
    );
    const picked = collapseByCluster(rows, limit);
    return { ...base, results: await this._present(picked, (r) => -r.rank) };
  }

  async _semantic(base, filters, limit) {
    if (!this.gateway) {
      return { ...base, error: "semantic search needs the LLM gateway (no provider key, or the enrich worker is off) — try keyword" };
    }
    let emb;
    try {
      emb = await this.gateway.embed(base.query, { priority: "low" });
    } catch (error) {
      return { ...base, error: `embedding failed: ${error.message} — try keyword` };
    }
    if (!emb) return { ...base, error: "no embedding provider configured — try keyword" };
    if (emb.shed) return { ...base, error: "quota is reserved for enrichment right now — try keyword" };

    const where = this._where(filters);
    const [rows] = await database.sequelize.query(
      "SELECT p.id, p.source_id, p.platform, p.channel_id, p.external_id, p.external_url, " +
        "p.posted_at, p.createdAt, p.topic, p.signal_type, p.status, p.cluster_id, p.text_en, p.raw_text, " +
        "p.embedding, p.embedding_dim FROM posts p " +
        `WHERE p.embedding IS NOT NULL AND p.embedding_model = ? AND ${where.sql} ` +
        "ORDER BY COALESCE(p.posted_at, p.createdAt) DESC LIMIT ?",
      { replacements: [emb.model, ...where.params, this.semanticMaxRows] },
    );

    const scored = [];
    for (const r of rows) {
      const s = cosine(emb.vector, decodeEmbedding(r.embedding, r.embedding_dim));
      if (s !== null && s >= MIN_SEMANTIC_S) scored.push({ ...r, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = collapseByCluster(scored, limit);
    const note = rows.length >= this.semanticMaxRows
      ? `searched the ${this.semanticMaxRows} most recent posts; set days or a topic to narrow`
      : null;
    return { ...base, note, results: await this._present(picked, (r) => r.score) };
  }

  async _present(rows, scoreOf) {
    if (rows.length === 0) return [];
    const sourceIds = [...new Set(rows.map((r) => r.source_id).filter(Boolean))];
    const clusterIds = [...new Set(rows.map((r) => r.cluster_id).filter(Boolean))];
    const [sources, clusters] = await Promise.all([
      sourceIds.length ? Source.findAll({ where: { id: sourceIds }, attributes: ["id", "channel_name"] }) : [],
      clusterIds.length ? Cluster.findAll({ where: { id: clusterIds }, attributes: ["id", "members_count"] }) : [],
    ]);
    const names = new Map(sources.map((s) => [s.id, s.channel_name]));
    const members = new Map(clusters.map((c) => [c.id, c.members_count]));

    return rows.map((r) => ({
      id: r.id,
      when: r.posted_at || r.createdAt ? new Date(r.posted_at ?? r.createdAt).toISOString() : null,
      topic: r.topic,
      signal_type: r.signal_type,
      status: r.status,
      source: names.get(r.source_id) ?? null,
      members: members.get(r.cluster_id) ?? 1,
      score: scoreOf(r),
      snippet: snippet(r.text_en || r.raw_text),
      link: telegramLink(r),
    }));
  }
}

export default HistorySearch;

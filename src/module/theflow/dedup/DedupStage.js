import { Op } from "sequelize";

import database from "../../teapot/sqlite/sqlite_db.js";
import { Post, Cluster } from "../../teapot/models/index.js";
import {
  tier1Keys,
  normalizeUrl,
  decodeEmbedding,
  cosine,
  richness,
  windowHours,
  maxWindowHours,
  clusterAccepts,
  decide,
} from "./DedupCore.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Поля поста, потрібні дедуплікації. Без raw_text / text_md / entities:
// пул тримає тисячі рядків, а текст оригіналу тут не потрібен.
const POOL_ATTRS = [
  "id", "source_id", "topic", "signal_type", "text_en", "candidates", "analysis",
  "has_media", "text_hash", "external_url", "embedding", "embedding_model",
  "embedding_dim", "posted_at", "createdAt", "cluster_id", "link_role", "status",
];

const timeOf = (row) => new Date(row.posted_at ?? row.createdAt).getTime();

/**
 * TheFlow — стадія дедуплікації, tiers 1 і 2 (ROADMAP §6.1–6.5, 6.7).
 *
 * Бере `enriched` пости без рішення (`dedup IS NULL`) у хронологічному
 * порядку — first-wins: канонічним стає найраніший — і для кожного:
 *
 *   tier 1  точний збіг ключа (перевірений промокод, посилання,
 *           external_url, text_hash) з членом відкритого кластера у вікні;
 *   tier 2  косинус ембеддинга проти членів того ж топіка й тієї ж моделі;
 *   гейт    richness + нові сутності: дубль, що нічого не додає, —
 *           `suppressed`; решта — `linked` (що саме додає, скаже
 *           delta-виклик §6.6, якого ще немає).
 *
 * Сіра зона (LOW < s < HIGH) — нова подія з позначкою `gray`, доки tier 3
 * не існує. Кожне рішення лишає журнал у `posts.dedup` (§6.7) — без нього
 * пороги нема з чого калібрувати (§6.8).
 *
 * Не робить мережевих викликів і не знає ні Telegram, ні gateway.
 */
export class DedupStage {
  /**
   * @param {{
   *   taxonomy: object,
   *   thresholds: { high: number, low: number, gateFactor: number, replaceFactor: number },
   *   flowFor?: (post: object) => Promise<object|null>,
   *   batchSize?: number,
   *   boilerplateMin?: number,
   *   boilerplateDays?: number,
   *   now?: () => number,
   *   log?: (msg: string, level?: string) => void,
   * }} deps
   */
  constructor({
    taxonomy, thresholds, flowFor = async () => null,
    batchSize = 50, boilerplateMin = 3, boilerplateDays = 14,
    now = Date.now, log = () => {},
  }) {
    this.taxonomy = taxonomy;
    this.thresholds = thresholds;
    this.flowFor = flowFor;
    this.batchSize = batchSize;
    this.boilerplateMin = boilerplateMin;
    this.boilerplateDays = boilerplateDays;
    this.now = now;
    this.log = log;
  }

  /** Обробляє один пакет. Повертає кількість постів, що отримали рішення. */
  async runOnce(limit = this.batchSize) {
    const batch = await Post.findAll({
      where: { status: "enriched", dedup: null, cluster_id: null },
      order: [
        [database.sequelize.fn("COALESCE", database.sequelize.col("posted_at"), database.sequelize.col("createdAt")), "ASC"],
        ["id", "ASC"],
      ],
      limit,
    });

    // Закриваємо кластери, чиє вікно минуло, — але відносно найстарішого
    // поста в черзі, не годинника: бекфіл старих постів мусить ще мати змогу
    // приєднатися до кластерів свого часу.
    const refT = batch.length ? timeOf(batch[0]) : this.now();
    await this.closeExpired(refT);
    if (batch.length === 0) return 0;

    // Спершу шаблонні URL: ключі членів пулу рахуються вже з ними.
    const boilerplate = await this._loadBoilerplate();
    const pool = await this._loadPool(timeOf(batch[0]), boilerplate);

    let done = 0;
    for (const row of batch) {
      try {
        await this._process(row, pool, boilerplate);
        done += 1;
      } catch (error) {
        // Рішення з помилкою, а не повтор без кінця: пост видно у звіті.
        this.log(`[DEDUP] posts#${row.id} failed: ${error.message}`, "warning");
        await row.update({ dedup: { error: String(error.message).slice(0, 300), at: new Date().toISOString() } });
        done += 1;
      }
    }
    return done;
  }

  /**
   * Стирає всі рішення дедуплікації, щоб перерахувати їх з іншими порогами
   * (§6.8): пости — назад у `enriched` без кластера, кластери видаляються.
   * Відмовляє, якщо хоч один кластер уже доставлено: його повідомлення
   * живуть у каналах, і перерахунок зламав би зв'язок із ними.
   *
   * @returns {Promise<{ posts: number, clusters: number }>}
   */
  static async reset() {
    await DedupStage.assertResettable();
    return await database.sequelize.transaction(async (transaction) => {
      const [suppressed] = await Post.update(
        { status: "enriched" },
        { where: { status: "suppressed" }, transaction },
      );
      const [posts] = await Post.update(
        { cluster_id: null, link_role: null, dedup: null },
        { where: { [Op.or]: [{ cluster_id: { [Op.ne]: null } }, { dedup: { [Op.ne]: null } }] }, transaction },
      );
      const clusters = await Cluster.destroy({ where: {}, transaction });
      return { posts: Math.max(posts, suppressed), clusters };
    });
  }

  /** Кидає, якщо хоч один кластер уже доставлено — тоді reset() заборонений. */
  static async assertResettable() {
    const delivered = (await Cluster.findAll({ attributes: ["id", "delivered"] }))
      .filter((c) => Array.isArray(c.delivered) && c.delivered.length > 0);
    if (delivered.length) {
      throw new Error(`${delivered.length} cluster(s) already delivered — refusing to reset deduplication`);
    }
  }

  /** Закриває відкриті кластери, неактивні довше за вікно свого сигналу. */
  async closeExpired(refT) {
    const minWindow = Math.min(
      ...Object.keys(this.taxonomy?.signals ?? {}).map((s) => windowHours(s, this.taxonomy)),
      48,
    );
    const open = await Cluster.findAll({
      where: { closed: false, last_seen_at: { [Op.lt]: new Date(refT - minWindow * HOUR) } },
      attributes: ["id", "signal_type", "last_seen_at"],
    });
    const ids = open
      .filter((c) => refT - new Date(c.last_seen_at).getTime() > windowHours(c.signal_type, this.taxonomy) * HOUR)
      .map((c) => c.id);
    if (ids.length) await Cluster.update({ closed: true }, { where: { id: ids } });
    return ids.length;
  }

  // ── пул кандидатів ─────────────────────────────────────────────────

  async _loadPool(oldestT, boilerplate) {
    const since = new Date(oldestT - maxWindowHours(this.taxonomy) * HOUR);
    // createdAt >= posted_at, тож фільтр по createdAt — надмножина потрібного.
    const rows = await Post.findAll({
      where: { cluster_id: { [Op.ne]: null }, createdAt: { [Op.gte]: since } },
      attributes: POOL_ATTRS,
    });
    const clusterIds = [...new Set(rows.map((r) => r.cluster_id))];
    const clusters = clusterIds.length ? await Cluster.findAll({ where: { id: clusterIds } }) : [];

    const pool = { members: [], clusters: new Map(), byKey: new Map() };
    for (const c of clusters) pool.clusters.set(c.id, this._clusterView(c));
    for (const r of rows) this._addMember(pool, this._memberView(r), boilerplate);
    return pool;
  }

  _clusterView(c) {
    return {
      id: c.id,
      canonical_post_id: c.canonical_post_id,
      topic: c.topic,
      signal_type: c.signal_type,
      richness: c.richness,
      members_count: c.members_count,
      last_seen_at: c.last_seen_at ? new Date(c.last_seen_at).getTime() : 0,
      closed: Boolean(c.closed),
    };
  }

  _memberView(r) {
    return {
      id: r.id,
      source_id: r.source_id,
      topic: r.topic,
      signal_type: r.signal_type,
      text_en: r.text_en,
      candidates: r.candidates,
      analysis: r.analysis,
      has_media: r.has_media,
      text_hash: r.text_hash,
      external_url: r.external_url,
      embedding_model: r.embedding_model,
      vector: decodeEmbedding(r.embedding, r.embedding_dim),
      t: timeOf(r),
      cluster_id: r.cluster_id,
    };
  }

  _addMember(pool, m, boilerplate) {
    pool.members.push(m);
    // Ключі члена рахуються з шаблонними URL його ж джерела.
    m.keys = tier1Keys(m, boilerplate?.get(m.source_id));
    for (const k of m.keys) {
      if (!pool.byKey.has(k)) pool.byKey.set(k, []);
      pool.byKey.get(k).push(m);
    }
  }

  /**
   * Шаблонні посилання: те, що джерело вставляє в багато постів (підпис,
   * реферал, свій YouTube-канал). Як ключ tier 1 вони склеїли б усе, що
   * джерело пише. Поріг — `boilerplateMin` різних постів за
   * `boilerplateDays` днів одного джерела.
   */
  async _loadBoilerplate() {
    const rows = await Post.findAll({
      where: { createdAt: { [Op.gte]: new Date(this.now() - this.boilerplateDays * DAY) } },
      attributes: ["source_id", "candidates"],
      raw: true,
    });
    const counts = new Map(); // source_id -> Map(url -> n)
    for (const r of rows) {
      let cand = r.candidates;
      if (typeof cand === "string") {
        try { cand = JSON.parse(cand); } catch { cand = null; }
      }
      const urls = new Set((Array.isArray(cand?.urls) ? cand.urls : []).map(normalizeUrl).filter(Boolean));
      if (!urls.size) continue;
      if (!counts.has(r.source_id)) counts.set(r.source_id, new Map());
      const m = counts.get(r.source_id);
      for (const u of urls) m.set(u, (m.get(u) ?? 0) + 1);
    }
    const out = new Map();
    for (const [sid, m] of counts) {
      out.set(sid, new Set([...m].filter(([, n]) => n >= this.boilerplateMin).map(([u]) => u)));
    }
    return out;
  }

  // ── один пост ──────────────────────────────────────────────────────

  async _process(row, pool, boilerplate) {
    const post = this._memberView(row);
    post.status = row.status;
    post.embedding = row.embedding;
    post.embedding_dim = row.embedding_dim;
    const flow = await this.flowFor(row);
    const accepts = (cluster) =>
      clusterAccepts(cluster, post.t, windowHours(cluster.signal_type, this.taxonomy, flow));

    // Tier 1 — найсвіжіший кластер, що приймає, серед спільних ключів.
    let tier1 = null;
    for (const key of tier1Keys(post, boilerplate.get(post.source_id))) {
      for (const m of pool.byKey.get(key) ?? []) {
        const cluster = pool.clusters.get(m.cluster_id);
        if (!cluster || !accepts(cluster)) continue;
        if (!tier1 || cluster.last_seen_at > tier1.cluster.last_seen_at) tier1 = { cluster, post: m, key };
      }
    }

    // Tier 2 — рахується завжди, коли є вектор: навіть коли вирішив tier 1,
    // `s` у журналі — матеріал для калібрування (§6.8). Члени того ж джерела
    // не кандидати (якщо не ввімкнено `tier2SameSource`), але їхній
    // найближчий `s` теж пишеться — видно, що саме було відкинуто.
    let tier2 = null;
    let sameSourceS = null;
    if (post.vector && post.embedding_model) {
      for (const m of pool.members) {
        if (!m.vector || m.embedding_model !== post.embedding_model || m.topic !== post.topic) continue;
        const cluster = pool.clusters.get(m.cluster_id);
        if (!cluster || !accepts(cluster)) continue;
        const s = cosine(post.vector, m.vector);
        if (s === null) continue;
        if (m.source_id === post.source_id && !this.thresholds.tier2SameSource) {
          if (sameSourceS === null || s > sameSourceS) sameSourceS = s;
          continue;
        }
        if (!tier2 || s > tier2.s) tier2 = { cluster, post: m, s };
      }
    }

    const target = tier1 ?? (tier2 && tier2.s >= this.thresholds.high ? tier2 : null);
    const canonicalOf = target ? await this._canonical(pool, target.cluster) : null;
    const d = decide({ post, tier1, tier2, canonicalOf, thresholds: this.thresholds });
    const log = {
      ...d.log,
      s_same_source: sameSourceS === null ? null : Math.round(sameSourceS * 10_000) / 10_000,
      t: new Date(post.t).toISOString(),
      at: new Date(this.now()).toISOString(),
    };

    await database.sequelize.transaction(async (transaction) => {
      if (d.decision === "new") {
        const c = await Cluster.create({
          canonical_post_id: row.id,
          topic: row.topic,
          signal_type: row.signal_type,
          centroid: row.embedding ?? null,
          embedding_model: row.embedding_model ?? null,
          embedding_dim: row.embedding_dim ?? null,
          members_count: 1,
          richness: richness(post),
          first_seen_at: new Date(post.t),
          last_seen_at: new Date(post.t),
          delivered: [],
        }, { transaction });
        log.cluster_id = c.id;
        await row.update({ cluster_id: c.id, link_role: "canonical", dedup: log }, { transaction });
        post.cluster_id = c.id;
        pool.clusters.set(c.id, this._clusterView(c));
      } else {
        const cluster = d.cluster;
        const patch = {
          members_count: cluster.members_count + 1,
          last_seen_at: new Date(Math.max(cluster.last_seen_at, post.t)),
        };
        if (d.replaceCanonical) {
          // B значно багатший за A — стає канонічним (DEDUPLICATION.md
          // «Replacing the canonical post»). A лишається в кластері як linked.
          patch.canonical_post_id = row.id;
          patch.richness = richness(post);
          if (row.embedding) {
            patch.centroid = row.embedding;
            patch.embedding_model = row.embedding_model;
            patch.embedding_dim = row.embedding_dim;
          }
          if (cluster.canonical_post_id) {
            await Post.update({ link_role: "linked" }, { where: { id: cluster.canonical_post_id }, transaction });
          }
          log.replaced_canonical_post_id = cluster.canonical_post_id;
        }
        await Cluster.update(patch, { where: { id: cluster.id }, transaction });
        await row.update({
          cluster_id: cluster.id,
          link_role: d.role,
          status: d.suppress ? "suppressed" : row.status,
          dedup: log,
        }, { transaction });

        cluster.members_count = patch.members_count;
        cluster.last_seen_at = patch.last_seen_at.getTime();
        if (d.replaceCanonical) {
          cluster.canonical_post_id = row.id;
          cluster.richness = patch.richness;
        }
        post.cluster_id = cluster.id;
      }
    });

    this._addMember(pool, post, boilerplate);
    return d;
  }

  async _canonical(pool, cluster) {
    if (!cluster.canonical_post_id) return null;
    const inPool = pool.members.find((m) => m.id === cluster.canonical_post_id);
    if (inPool) return inPool;
    const row = await Post.findByPk(cluster.canonical_post_id, { attributes: POOL_ATTRS });
    return row ? this._memberView(row) : null;
  }
}

export default DedupStage;

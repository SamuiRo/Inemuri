import { Op } from "sequelize";

import database from "../../teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../../teapot/models/index.js";
import { telegramLink } from "../search/HistorySearch.js";
import { TEMPLATE } from "../delivery/render.js";

/**
 * TheFlow — дайджест (ROADMAP §9, фаза 5).
 *
 * Що потрапляє — вирішують правила, не оцінка:
 *   - один рядок на подію: канонічний пост кластера (або пост без кластера);
 *   - статус enriched / routed (unsorted, suppressed, failed — ні);
 *   - не `other`, не нижче `min_confidence` джерела, не реклама (`is_ad`),
 *     не сигнали, що «класифікуються і нікуди не йдуть» (TAXONOMY.md).
 *
 * Числова оцінка лише ВПОРЯДКОВУЄ рядки всередині секції (ROADMAP §9: «never
 * used to decide whether to deliver»). Вона детермінована — розмір кластера,
 * вага сигналу, впевненість, — а не число від LLM, яке між викликами гуляє.
 *
 * `security` — окрема секція першою: це категорія, де пропущений пост коштує
 * більше за незручність.
 */

const SIGNAL_WEIGHT = {
  security: 5, outage: 3, promo_code: 3, freebie: 3,
  launch: 2, event: 2, patch: 2, analysis: 2, research: 2, report: 2, opinion: 0,
};
const LIMIT = 3_900; // з запасом під 4096 обох платформ

/** Порядок усередині секції. Не фільтр. */
export function digestScore(p) {
  const members = Math.max(1, Number(p.members ?? 1));
  return (members - 1) * 3 + (SIGNAL_WEIGHT[p.signal_type] ?? 1) + Number(p.confidence ?? 0);
}

/**
 * Відбір і групування. Чиста функція.
 *
 * @param {object[]} rows  Пости з полями posts плюс `members`, `min_confidence`, `source`.
 * @param {{ perTopic?: number, excludeSignals?: string[], topicOrder?: string[] }} opts
 * @returns {Array<{ section: string, items: object[], more: number }>}
 */
export function selectDigest(rows, { perTopic = 5, excludeSignals = [], topicOrder = [] } = {}) {
  const exclude = new Set(excludeSignals);
  const eligible = rows.filter((p) =>
    (p.status === "enriched" || p.status === "routed") &&
    (p.link_role == null || p.link_role === "canonical") &&
    p.topic && p.topic !== "other" &&
    !exclude.has(p.signal_type) &&
    p.analysis?.is_ad !== true &&
    Number(p.confidence ?? 0) >= Number(p.min_confidence ?? 0));

  const sections = new Map();
  for (const p of eligible) {
    const key = p.signal_type === "security" ? "security" : p.topic;
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(p);
  }
  const order = ["security", ...topicOrder.filter((t) => t !== "other")];
  const keys = [...sections.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((section) => {
    const list = sections.get(section).sort((a, b) => digestScore(b) - digestScore(a) || b.id - a.id);
    return { section, items: list.slice(0, perTopic), more: Math.max(0, list.length - perTopic) };
  });
}

const oneLine = (s, max) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
};

/**
 * Секції → текст. Один результат для обох платформ, як у cron-звіту:
 * `rawText` + `entities` (жирні заголовки) для Telegram, `text` (Markdown) —
 * для Discord. Не довше LIMIT: що не влізло — «…і ще N».
 *
 * @returns {{ rawText: string, text: string, entities: object[], count: number }}
 */
export function renderDigest(sections, { title }) {
  let raw = "";
  let md = "";
  const entities = [];
  let count = 0;
  let dropped = 0;

  const bold = (s) => {
    entities.push({ className: "MessageEntityBold", offset: raw.length, length: s.length });
    raw += s;
    md += `**${s}**`;
  };
  const plain = (s) => {
    raw += s;
    md += s;
  };

  bold(title);
  for (const sec of sections) {
    const head = sec.section === "security"
      ? "⚠️ security"
      : `${TEMPLATE.topicEmoji[sec.section] ?? TEMPLATE.topicEmoji.other} ${sec.section}`;
    const lines = sec.items.map((p) => {
      const what = oneLine(p.analysis?.summary_uk || p.title || p.text_en || p.raw_text, 160);
      const also = p.members > 1 ? ` ×${p.members}` : "";
      const link = p.link ? `\n  ${p.link}` : "";
      return `• ${what}${also} (${p.source ?? "?"})${link}`;
    });
    const block = `\n\n${head}\n${lines.join("\n")}${sec.more ? `\n…+${sec.more}` : ""}`;
    if (raw.length + block.length > LIMIT) {
      dropped += sec.items.length + sec.more;
      continue;
    }
    plain("\n\n");
    bold(head);
    plain(`\n${lines.join("\n")}${sec.more ? `\n…+${sec.more}` : ""}`);
    count += sec.items.length;
  }
  if (dropped) plain(`\n\n…and ${dropped} more that did not fit`);
  return { rawText: raw, text: md, entities, count };
}

/**
 * Пости періоду з усім, що потрібно відбору: розмір кластера, назва й
 * min_confidence джерела, посилання.
 */
export async function collectDigestRows({ since, until }) {
  const posts = await Post.findAll({
    where: {
      status: ["enriched", "routed"],
      [Op.and]: [
        database.sequelize.where(
          database.sequelize.fn("COALESCE", database.sequelize.col("posted_at"), database.sequelize.col("createdAt")),
          { [Op.between]: [since, until] },
        ),
      ],
    },
    attributes: ["id", "source_id", "platform", "channel_id", "external_id", "external_url", "title", "raw_text",
      "text_en", "topic", "signal_type", "confidence", "analysis", "status", "link_role", "cluster_id", "posted_at"],
  });
  const sourceIds = [...new Set(posts.map((p) => p.source_id).filter(Boolean))];
  const clusterIds = [...new Set(posts.map((p) => p.cluster_id).filter(Boolean))];
  const [sources, clusters] = await Promise.all([
    sourceIds.length ? Source.findAll({ where: { id: sourceIds } }) : [],
    clusterIds.length ? Cluster.findAll({ where: { id: clusterIds }, attributes: ["id", "members_count"] }) : [],
  ]);
  const src = new Map(sources.map((s) => [s.id, s]));
  const members = new Map(clusters.map((c) => [c.id, c.members_count]));
  return posts.map((row) => {
    const p = row.get({ plain: true });
    const s = src.get(p.source_id);
    return {
      ...p,
      source: s?.channel_name ?? null,
      min_confidence: s?.getFlowConfig?.().min_confidence ?? 0,
      members: members.get(p.cluster_id) ?? 1,
      link: telegramLink(p),
    };
  });
}

/**
 * Готовий messageData для CronScheduler / MessageRouter, або null — за
 * період нема чого показати (порожній дайджест не надсилається).
 */
export async function buildDigestMessage({ now = Date.now(), hours = 24, perTopic = 5, excludeSignals = [], topicOrder = [], destinations = {} } = {}) {
  const until = new Date(now);
  const since = new Date(now - hours * 3_600_000);
  const rows = await collectDigestRows({ since, until });
  const sections = selectDigest(rows, { perTopic, excludeSignals, topicOrder });
  if (sections.length === 0) return null;
  const title = `🗞 TheFlow digest — ${until.toISOString().slice(0, 10)} (${hours}h)`;
  const r = renderDigest(sections, { title });
  return {
    platform: "theflow",
    // Заголовок уже в тексті; source.name лишається порожнім, щоб Telegram
    // не додав рядок назви джерела.
    source: { name: "", destinations },
    rawText: r.rawText,
    text: r.text,
    entities: r.entities,
    metadata: { source: "theflow-digest", posts: r.count, hours },
  };
}

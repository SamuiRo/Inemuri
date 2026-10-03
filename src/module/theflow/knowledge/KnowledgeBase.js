import { Op } from "sequelize";

import database from "../../teapot/sqlite/sqlite_db.js";
import { Post, PostFeedback, Source, KnowledgeExample } from "../../teapot/models/index.js";
import { snapshotFromPost } from "./snapshot.js";

/**
 * База знань TheFlow — операції над knowledge_examples (NEWS_INTAKE.md §3).
 *
 * Єдине місце, що пише в таблицю: review, backfill з post_feedback, імпорт.
 * Формат файлу — у exchange.js, знімок поста — у snapshot.js; тут лише
 * база.
 */

/** Назва джерела поста — у знімок іде вона, не id. */
async function sourceNameOf(sourceId, transaction) {
  if (sourceId == null) return null;
  const source = await Source.findByPk(sourceId, { attributes: ["channel_name"], transaction });
  return source?.channel_name ?? null;
}

/**
 * Мітка з `flow review`: рядок post_feedback і знімок у базі знань — однією
 * транзакцією, щоб журнал і база знань не розійшлися.
 *
 * @param {{ post: object, verdict: string, note?: string|null }} label
 * @returns {Promise<{ feedback: object, example: object|null }>}
 *   example null — у поста немає тексту (знімку нема на що спиратись).
 */
export async function recordLabel({ post, verdict, note = null }) {
  return database.sequelize.transaction(async (transaction) => {
    const feedback = await PostFeedback.create({ post_id: post.id, verdict, note }, { transaction });
    const snapshot = snapshotFromPost(post, {
      verdict,
      reason: note,
      origin: "review",
      sourceName: await sourceNameOf(post.source_id, transaction),
      feedbackId: feedback.id,
      createdAt: feedback.created_at,
    });
    const example = snapshot ? await KnowledgeExample.create(snapshot, { transaction }) : null;
    return { feedback, example };
  });
}

/**
 * Переносить у базу знань мітки post_feedback, яких там ще немає.
 * Ідемпотентно: зв'язок — feedback_id (UNIQUE), тож повторний запуск нічого
 * не дублює. Мітки без поста (`missed`, видалений пост) пропускаються —
 * без змісту приклад нічого не вчить.
 *
 * @returns {Promise<{ created: number, skipped: number }>}
 */
export async function backfillFromFeedback() {
  const done = new Set(
    (await KnowledgeExample.findAll({ where: { feedback_id: { [Op.ne]: null } }, attributes: ["feedback_id"] }))
      .map((r) => r.feedback_id),
  );
  const pending = (await PostFeedback.findAll({ order: [["id", "ASC"]] })).filter((f) => !done.has(f.id));
  if (!pending.length) return { created: 0, skipped: 0 };

  const postIds = [...new Set(pending.map((f) => f.post_id).filter((id) => id != null))];
  const posts = new Map((await Post.findAll({ where: { id: postIds } })).map((p) => [p.id, p]));
  const sources = new Map((await Source.findAll({ attributes: ["id", "channel_name"] })).map((s) => [s.id, s.channel_name]));

  const rows = [];
  for (const f of pending) {
    const post = posts.get(f.post_id);
    const snapshot = post && snapshotFromPost(post, {
      verdict: f.verdict,
      reason: f.note,
      origin: "review",
      sourceName: sources.get(post.source_id) ?? null,
      feedbackId: f.id,
      createdAt: f.created_at,
    });
    if (snapshot) rows.push(snapshot);
  }
  if (rows.length) await KnowledgeExample.bulkCreate(rows);
  return { created: rows.length, skipped: pending.length - rows.length };
}

/**
 * @param {{ levels?: string[], verdicts?: string[] }} [filter]
 * @returns {Promise<object[]>} Від найстаріших до найновіших — файл читається як історія.
 */
export async function exportKnowledge({ levels, verdicts } = {}) {
  const where = {};
  if (levels?.length) where.level = levels;
  if (verdicts?.length) where.verdict = verdicts;
  return KnowledgeExample.findAll({ where, order: [["created_at", "ASC"], ["id", "ASC"]] });
}

/** Які з uid уже є. Частинами: SQLite обмежує кількість параметрів запиту. */
async function existingUids(uids, chunk = 500) {
  const known = new Set();
  for (let i = 0; i < uids.length; i += chunk) {
    const rows = await KnowledgeExample.findAll({ where: { uid: uids.slice(i, i + chunk) }, attributes: ["uid"] });
    for (const r of rows) known.add(r.uid);
  }
  return known;
}

/**
 * Upsert за uid. Наявний uid лишається як є — рядки незмінні, тож імпорт
 * того самого файлу вдруге нічого не змінює. Повтор uid усередині файлу
 * рахується як наявний.
 *
 * @param {object[]} rows Значення з exchange.parse().
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{ created: number, existing: number }>}
 */
export async function importKnowledge(rows, { dryRun = false } = {}) {
  const known = await existingUids(rows.map((r) => r.uid));
  const fresh = [];
  for (const row of rows) {
    if (known.has(row.uid)) continue;
    known.add(row.uid);
    fresh.push(row);
  }
  if (!dryRun && fresh.length) {
    await database.sequelize.transaction((transaction) => KnowledgeExample.bulkCreate(fresh, { transaction }));
  }
  return { created: fresh.length, existing: rows.length - fresh.length };
}

/** Скільки прикладів за рівнем, вердиктом і походженням. */
export async function knowledgeStats() {
  const count = async (field) => {
    const rows = await KnowledgeExample.findAll({
      attributes: [field, [database.sequelize.fn("COUNT", database.sequelize.col("id")), "n"]],
      group: [field],
      raw: true,
    });
    return Object.fromEntries(rows.map((r) => [r[field], Number(r.n)]));
  };
  return {
    total: await KnowledgeExample.count(),
    level: await count("level"),
    verdict: await count("verdict"),
    origin: await count("origin"),
  };
}

/**
 * Приклади для few-shot, найновіші першими.
 *
 * @param {{ levels?: string[], verdicts?: string[], limit?: number }} [opts]
 */
export async function loadExamples({ levels = ["post"], verdicts = ["good", "wrong_topic"], limit = 200 } = {}) {
  const rows = await KnowledgeExample.findAll({
    where: { level: levels, verdict: verdicts },
    attributes: ["uid", "content_hash", "verdict", "reason", "body", "text_en", "topic", "signal_type", "created_at"],
    order: [["created_at", "DESC"], ["id", "DESC"]],
    limit,
  });
  return rows.map((r) => r.get({ plain: true }));
}

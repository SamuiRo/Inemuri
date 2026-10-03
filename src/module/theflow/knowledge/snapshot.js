import crypto from "crypto";

/**
 * Знімок змісту для бази знань (NEWS_INTAKE.md §3). Чистий, без I/O.
 *
 * Рядок knowledge_examples несе все, на що поставлено мітку, тож має
 * лишатися зрозумілим без `posts`: текст, класифікація, версія таксономії.
 */

const normalize = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Ідентичність змісту: той самий текст того самого рівня дає той самий хеш,
 * незалежно від пробілів і регістру. Мітки одного змісту групуються за ним.
 *
 * @param {{ level: string, title?: string|null, body: string }} content
 * @returns {string} sha256, 64 hex.
 */
export function contentHash({ level, title, body }) {
  return crypto.createHash("sha256")
    .update([level, normalize(title), normalize(body)].join("\n"))
    .digest("hex");
}

/** JSON-колонка зі SQLite інколи приходить рядком. */
function asObject(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" ? value : null;
}

/** Текст джерела: raw_text і транскрипція з картинок, як на вході enrich. */
function sourceText(post) {
  const parts = [post.raw_text, post.text_ocr].map((s) => String(s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join("\n\n") : String(post.text_en ?? "").trim();
}

/**
 * Кандидат triage (discovered_items) і мітка → рядок рівня `headline`:
 * те, що бачив triage, — заголовок і анонс, без статті.
 *
 * @param {object} row discovered_items
 * @param {{ verdict: string, reason?: string|null, sourceName?: string|null, createdAt?: Date }} label
 * @returns {object|null} null — немає ні заголовка, ні анонсу.
 */
export function snapshotFromCandidate(row, { verdict, reason = null, sourceName = null, createdAt = new Date() }) {
  const title = String(row.title ?? "").trim() || null;
  const body = String(row.teaser ?? "").trim() || title;
  if (!body) return null;

  const level = "headline";
  return {
    uid: crypto.randomUUID(),
    content_hash: contentHash({ level, title, body }),
    level,
    verdict,
    reason: reason && String(reason).trim() ? String(reason).trim() : null,
    title,
    body,
    text_en: null,
    url: row.url ?? null,
    source_name: sourceName,
    platform: "rss",
    published_at: row.published_at ?? null,
    topic: null,
    signal_type: null,
    extracted: null,
    taxonomy_version: null,
    origin: "review",
    post_id: row.post_id ?? null,
    feedback_id: null,
    created_at: createdAt,
  };
}

/**
 * Пост і мітка → значення рядка knowledge_examples (без id).
 *
 * @param {object} post Рядок posts (plain або модель).
 * @param {{
 *   verdict: string,
 *   reason?: string|null,
 *   origin: string,
 *   sourceName?: string|null,
 *   feedbackId?: number|null,
 *   createdAt?: Date,
 * }} label
 * @returns {object|null} null — у поста немає тексту, мітці нема на що спиратись.
 */
export function snapshotFromPost(post, { verdict, reason = null, origin, sourceName = null, feedbackId = null, createdAt = new Date() }) {
  const body = sourceText(post);
  if (!body) return null;

  const level = "post";
  const title = post.title ?? null;
  const analysis = asObject(post.analysis);
  const extracted = analysis && (analysis.entities || analysis.extracted)
    ? { entities: analysis.entities ?? null, extracted: analysis.extracted ?? null }
    : null;

  return {
    uid: crypto.randomUUID(),
    content_hash: contentHash({ level, title, body }),
    level,
    verdict,
    reason: reason && String(reason).trim() ? String(reason).trim() : null,
    title,
    body,
    text_en: post.text_en ?? null,
    url: post.external_url ?? null,
    source_name: sourceName,
    platform: post.platform ?? null,
    published_at: post.posted_at ?? null,
    topic: post.topic ?? null,
    signal_type: post.signal_type ?? null,
    extracted,
    taxonomy_version: post.taxonomy_version ?? null,
    origin,
    post_id: post.id ?? null,
    feedback_id: feedbackId,
    created_at: createdAt,
  };
}

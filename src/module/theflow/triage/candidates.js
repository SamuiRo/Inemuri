/**
 * Кандидат triage ↔ елемент стрічки (NEWS_INTAKE.md §2.2). Чистий.
 *
 * Елемент — те, що віддають парсери src/sources/feeds/parsers.js:
 * `{ id, link, title, text, author, publishedAt, imageUrls, keywords? }`.
 * Рядок — колонки discovered_items. Перетворення в обидва боки тут, щоб
 * кандидат, пропущений triage, став постом рівно таким, яким прийшов.
 */

/** Сегменти шляху URL без останнього (slug статті). */
function sectionSegments(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return [];
  }
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((p) => p.toLowerCase()).filter((p) => !/^\d+$/.test(p));
}

/**
 * Розділ сайту з URL — перший змістовний сегмент перед slug:
 *   nypost.com/2026/10/03/betting/<slug>/  → "betting"
 *   foxnews.com/politics/<slug>            → "politics"
 *   reuters.com/business/finance/<slug>/   → "business"
 * Лише slug без розділу → null.
 */
export function sectionOf(url) {
  return sectionSegments(url)[0] ?? null;
}

/** Усі розділи шляху: reuters.com/sports/soccer/<slug> → ["sports", "soccer"]. */
export function sectionsOf(url) {
  return sectionSegments(url);
}

/** Елемент стрічки → значення рядка discovered_items (без рішення). */
export function toRow(sourceId, item) {
  return {
    source_id: sourceId,
    external_id: String(item.id),
    url: item.link ?? null,
    title: item.title ?? null,
    teaser: item.text || null,
    author: item.author ?? null,
    keywords: item.keywords?.length ? item.keywords : null,
    image_urls: item.imageUrls?.length ? item.imageUrls : null,
    section: item.link ? sectionOf(item.link) : null,
    published_at: item.publishedAt != null ? new Date(item.publishedAt) : null,
  };
}

/** Рядок discovered_items → елемент стрічки, як його віддав парсер. */
export function toItem(row) {
  return {
    id: row.external_id,
    link: row.url ?? null,
    title: row.title ?? null,
    text: row.teaser ?? "",
    author: row.author ?? null,
    publishedAt: row.published_at ? new Date(row.published_at).getTime() : null,
    imageUrls: row.image_urls ?? [],
    keywords: row.keywords ?? [],
  };
}

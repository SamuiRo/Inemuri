import * as cheerio from "cheerio";

/**
 * Стрічки → уніфіковані елементи (ROADMAP §7.1–7.2). Чисті функції, без I/O.
 *
 * Елемент:
 *   { id, link, title, text, author, publishedAt, imageUrls }
 *   id          — guid / atom:id / Reddit fullname; ідентичність у posts.external_id
 *   link        — канонічне посилання (стаття, Reddit permalink)
 *   text        — plain text вмісту стрічки (HTML знято), не повна стаття
 *   publishedAt — мс або null
 *   imageUrls   — зображення елемента, для UrlMediaResolver
 *   keywords    — лише sitemap: news:keywords, для triage (NEWS_INTAKE.md §2.3)
 */

const MAX_IMAGES = 4;

function clean(s) {
  return String(s ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** HTML → plain text: абзаци й переноси зберігаються, теги знімаються. */
export function htmlToText(html) {
  if (!html) return "";
  const $ = cheerio.load(`<div id="__root">${html}</div>`, null, false);
  $("script, style").remove();
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr").each((_, el) => { $(el).append("\n"); });
  return clean($("#__root").text());
}

/** Перше зображення з HTML (<img src>), або null. */
function firstImgSrc(html) {
  if (!html) return null;
  const $ = cheerio.load(html, null, false);
  const src = $("img").first().attr("src");
  return src && /^https?:\/\//i.test(src) ? src : null;
}

function toMs(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? t : null;
}

function uniq(list, max) {
  return [...new Set(list.filter(Boolean))].slice(0, max);
}

/**
 * RSS 2.0 або Atom. Невідомий формат → порожній список (не виняток: стрічка,
 * що раптом віддала HTML-сторінку помилки, — не привід валити опитувач).
 */
export function parseFeed(xml, { maxTextChars = 4_000 } = {}) {
  const $ = cheerio.load(String(xml ?? ""), { xml: true });
  const out = [];

  // RSS 2.0 (і RSS 1.0 / RDF — теж <item>)
  $("item").each((_, el) => {
    const it = $(el);
    const html = it.find("content\\:encoded").first().text() || it.find("description").first().text();
    const link = it.find("link").first().text().trim() || it.find("guid[isPermaLink!='false']").first().text().trim();
    const guid = it.find("guid").first().text().trim();
    const images = [];
    it.find("enclosure").each((__, e) => {
      const type = $(e).attr("type") ?? "";
      if (type.startsWith("image/")) images.push($(e).attr("url"));
    });
    it.find("media\\:content, media\\:thumbnail").each((__, e) => {
      const medium = $(e).attr("medium") ?? "";
      const type = $(e).attr("type") ?? "";
      if (!medium || medium === "image" || type.startsWith("image/")) images.push($(e).attr("url"));
    });
    images.push(firstImgSrc(html));
    out.push({
      id: guid || link || it.find("title").first().text().trim(),
      link: link || null,
      title: clean(htmlToText(it.find("title").first().text())) || null,
      text: htmlToText(html).slice(0, maxTextChars),
      author: clean(it.find("dc\\:creator").first().text() || it.find("author").first().text()) || null,
      publishedAt: toMs(it.find("pubDate").first().text() || it.find("dc\\:date").first().text()),
      imageUrls: uniq(images, MAX_IMAGES),
    });
  });
  if (out.length) return out.filter((i) => i.id);

  // Atom
  $("entry").each((_, el) => {
    const it = $(el);
    const alternate = it.find("link[rel='alternate']").first().attr("href");
    const anyLink = it.find("link").first().attr("href");
    const html = it.find("content").first().text() || it.find("summary").first().text();
    const images = [];
    it.find("link[rel='enclosure']").each((__, e) => {
      if (($(e).attr("type") ?? "").startsWith("image/")) images.push($(e).attr("href"));
    });
    it.find("media\\:thumbnail, media\\:content").each((__, e) => images.push($(e).attr("url")));
    images.push(firstImgSrc(html));
    const link = alternate || anyLink || null;
    out.push({
      id: it.find("id").first().text().trim() || link,
      link,
      title: clean(htmlToText(it.find("title").first().text())) || null,
      text: htmlToText(html).slice(0, maxTextChars),
      author: clean(it.find("author > name").first().text()) || null,
      publishedAt: toMs(it.find("published").first().text() || it.find("updated").first().text()),
      imageUrls: uniq(images, MAX_IMAGES),
    });
  });
  return out.filter((i) => i.id);
}

// ── News sitemap (NEWS_INTAKE.md §1) ──────────────────────────────────────

/**
 * Компаратор «найновіші першими» за полем `at` (мс). Без дати — у кінець, у
 * порядку документа: sort стабільний, а NaN від (-∞) − (-∞) стає 0.
 */
const newestFirst = (a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || 0;

/** "/2026/10/03/business/fed-holds-rates/" → "fed holds rates"; без змістовного slug — null. */
export function titleFromUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const slug = path.split("/").filter(Boolean).pop() ?? "";
  const words = slug.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  // Чисто числовий або хешовий slug (id статті) нічого не каже.
  return /[a-z]{3,}/i.test(words) && words.includes(" ") ? words : null;
}

/**
 * Sitemap (urlset) або індекс sitemap-ів (sitemapindex).
 *
 * Для urlset — елементи, найновіші першими: sitemap не впорядкований, а
 * опитувач бере перші maxItems. Заголовок — news:title, інакше зі slug URL
 * (Fox і подібні не пишуть news-розширення). Тексту немає: sitemap дає лише
 * заголовок, дату й ключові слова.
 *
 * Для індексу — `children`: URL дочірніх sitemap-ів, найсвіжіші першими.
 *
 * @returns {{ items: object[], children: string[] }}
 */
export function parseSitemap(xml) {
  const $ = cheerio.load(String(xml ?? ""), { xml: true });

  if ($("sitemapindex").length) {
    const children = $("sitemapindex > sitemap").map((_, el) => ({
      url: $(el).find("loc").first().text().trim(),
      at: toMs($(el).find("lastmod").first().text()),
    })).get();
    return {
      items: [],
      children: children.filter((c) => /^https?:\/\//i.test(c.url)).sort(newestFirst).map((c) => c.url),
    };
  }

  const items = $("urlset > url").map((_, el) => {
    const it = $(el);
    const loc = it.find("loc").first().text().trim();
    if (!/^https?:\/\//i.test(loc)) return null;
    const keywords = it.find("news\\:keywords").first().text().split(",").map((k) => k.trim()).filter(Boolean);
    return {
      id: loc,
      link: loc,
      title: clean(htmlToText(it.find("news\\:title").first().text())) || titleFromUrl(loc),
      text: "",
      author: null,
      publishedAt: toMs(it.find("news\\:publication_date").first().text() || it.find("lastmod").first().text()),
      imageUrls: uniq(it.find("image\\:loc").map((__, e) => $(e).text().trim()).get(), MAX_IMAGES),
      keywords,
    };
  }).get().filter(Boolean);

  items.sort((a, b) => newestFirst({ at: a.publishedAt }, { at: b.publishedAt }));
  return { items, children: [] };
}

// ── WordPress REST API ────────────────────────────────────────────────────

/**
 * Адреса списку постів WordPress. channel_id — корінь сайту
 * ("https://thehill.com") або вже повний шлях до `/wp-json/...` (сайт у
 * підкаталозі). Поля обмежені тим, що потрібно для пошуку статей: без
 * `content` відповідь у десятки разів менша (текст — справа кроку 4).
 */
export function wpPostsUrl(raw, perPage = 25) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!url.pathname.includes("/wp-json/")) url = new URL("/wp-json/wp/v2/posts", url.origin);
  url.searchParams.set("per_page", String(Math.min(100, Math.max(1, perPage))));
  url.searchParams.set("_fields", "id,link,date_gmt,title,excerpt");
  return url.href;
}

/** `/wp-json/wp/v2/posts` → елементи. Не масив або не JSON → порожній список. */
export function parseWpPosts(body, { maxTextChars = 4_000 } = {}) {
  let list = body;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p?.link).map((p) => ({
    id: p.link,
    link: p.link,
    title: clean(htmlToText(p.title?.rendered)) || null,
    text: htmlToText(p.excerpt?.rendered).slice(0, maxTextChars),
    author: null,
    // date_gmt приходить без зони — це UTC.
    publishedAt: toMs(p.date_gmt ? `${p.date_gmt}Z` : null),
    imageUrls: [],
  }));
}

// ── Reddit ────────────────────────────────────────────────────────────────

/** "r/CS2", "cs2", "https://www.reddit.com/r/cs2/" → "cs2"; інше → null. */
export function normalizeSubreddit(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/(?:^|\/)r\/([A-Za-z0-9_]{2,21})\/?$/) || s.match(/^([A-Za-z0-9_]{2,21})$/);
  if (m) return m[1].toLowerCase();
  const u = s.match(/reddit\.com\/r\/([A-Za-z0-9_]{2,21})/i);
  return u ? u[1].toLowerCase() : null;
}

/**
 * Лістинг /new. З OAuth — oauth.reddit.com без `.json` (той самий JSON);
 * без — публічний www.reddit.com/…/new.json.
 */
export function redditListingUrl(subreddit, limit = 25, { oauth = false } = {}) {
  const n = Math.min(100, Math.max(1, limit));
  return oauth
    ? `https://oauth.reddit.com/r/${subreddit}/new?limit=${n}&raw_json=1`
    : `https://www.reddit.com/r/${subreddit}/new.json?limit=${n}&raw_json=1`;
}

/**
 * Лістинг /new.json → елементи. NSFW і закріплені пости пропускаються:
 * закріплене висить тижнями і щоразу було б «новим» для першого опитування.
 * Для посилання (не self-пост) цільовий URL дописується в текст — так він
 * потрапляє в candidates.urls і стає tier-1 ключем проти тієї самої новини
 * з RSS.
 */
export function parseRedditListing(json, { maxTextChars = 4_000 } = {}) {
  const children = json?.data?.children;
  if (!Array.isArray(children)) return [];
  const out = [];
  for (const c of children) {
    const d = c?.data;
    if (!d || c.kind !== "t3" || !d.name) continue;
    if (d.over_18 || d.stickied) continue;

    const images = [];
    if (d.is_gallery && d.media_metadata) {
      for (const m of Object.values(d.media_metadata)) {
        if (m?.e === "Image" && m?.s?.u) images.push(m.s.u);
      }
    }
    if (d.post_hint === "image" && /^https?:\/\//.test(d.url ?? "")) images.push(d.url);
    const preview = d.preview?.images?.[0]?.source?.url;
    if (preview) images.push(preview);

    let text = String(d.selftext ?? "").trim();
    if (!d.is_self && d.url && !/\/\/(i\.)?redd\.it\//.test(d.url) && !d.is_gallery) {
      text = text ? `${text}\n\n${d.url}` : d.url;
    }

    out.push({
      id: d.name,
      link: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
      title: clean(d.title) || null,
      text: text.slice(0, maxTextChars),
      author: d.author && d.author !== "[deleted]" ? `u/${d.author}` : null,
      publishedAt: Number.isFinite(d.created_utc) ? d.created_utc * 1000 : null,
      imageUrls: uniq(images, MAX_IMAGES),
    });
  }
  return out;
}

// ── Курсор ────────────────────────────────────────────────────────────────

/**
 * Які елементи нові відносно курсору `{ ts, seen: [id…] }` (SourceState.cursor).
 *
 * Перший прохід (курсору немає) — лише baseline: нічого не віддає, запам'ятовує
 * поточне. Як і Telegram-полінг (_setBaseline), джерело не заливає свою
 * історію при підключенні.
 *
 * Далі новий — той, кого немає в `seen` і хто не старший за `ts` (або без
 * дати). Повторна подача того самого елемента нешкідлива: ingest ідемпотентний
 * за (source_id, external_id). Результат — від старих до нових.
 *
 * @returns {{ items: object[], cursor: { ts: number|null, seen: string[] }, baseline: boolean }}
 */
export function selectNew(items, cursor, { seenMax = 200 } = {}) {
  const list = Array.isArray(items) ? items.filter((i) => i?.id) : [];
  const maxTs = list.reduce((m, i) => (i.publishedAt != null && (m == null || i.publishedAt > m) ? i.publishedAt : m), null);

  if (!cursor) {
    return {
      items: [],
      cursor: { ts: maxTs, seen: list.map((i) => String(i.id)).slice(0, seenMax) },
      baseline: true,
    };
  }

  const seen = new Set((cursor.seen ?? []).map(String));
  const fresh = list
    .filter((i) => !seen.has(String(i.id)))
    .filter((i) => i.publishedAt == null || cursor.ts == null || i.publishedAt >= cursor.ts)
    .sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));

  const ts = [cursor.ts, maxTs].filter((x) => x != null).reduce((m, x) => Math.max(m, x), -Infinity);
  return {
    items: fresh,
    cursor: {
      ts: Number.isFinite(ts) ? ts : null,
      seen: [...new Set([...fresh.map((i) => String(i.id)), ...list.map((i) => String(i.id)), ...seen])].slice(0, seenMax),
    },
    baseline: false,
  };
}

import {
  parseFeed, parseRedditListing, parseSitemap, parseWpPosts,
  normalizeSubreddit, redditListingUrl, wpPostsUrl,
} from "./parsers.js";

/**
 * Як знаходити нові елементи джерела-стрічки (NEWS_INTAKE.md §2.1). Чистий.
 *
 * Одна платформа `rss` на всі новинні сайти; спосіб задає `source.feed.discovery`
 * (а `source.feed.triage` — чи йдуть нові статті через triage, usesTriage):
 *   rss      — RSS 2.0 / Atom (типово), channel_id — URL стрічки;
 *   sitemap  — news sitemap або його індекс, channel_id — URL sitemap-а;
 *   wpjson   — WordPress REST API, channel_id — корінь сайту.
 * Reddit — окрема платформа зі своїм способом.
 *
 * Стратегія: `url(source, opts)` → що запитувати (null — конфіг непридатний),
 * `accept` — заголовок Accept, `parse(body, opts)` → `{ items, children }`.
 * `children` непорожній лише в індексу sitemap-ів: опитувач іде в перший
 * (найсвіжіший) із них.
 */

export const DISCOVERY_KINDS = ["rss", "sitemap", "wpjson"];

const httpUrl = (raw) => (/^https?:\/\//i.test(String(raw ?? "")) ? String(raw) : null);
const only = (items) => ({ items, children: [] });

const STRATEGIES = {
  rss: {
    url: (source) => httpUrl(source.channel_id),
    accept: undefined, // типовий Accept fetchFeed — для стрічок
    parse: (body, opts) => only(parseFeed(body, opts)),
  },
  sitemap: {
    url: (source) => httpUrl(source.channel_id),
    accept: "application/xml, text/xml;q=0.9, */*;q=0.5",
    parse: (body) => parseSitemap(body),
  },
  wpjson: {
    url: (source, { maxItems }) => wpPostsUrl(source.channel_id, maxItems),
    accept: "application/json",
    parse: (body, opts) => only(parseWpPosts(body, opts)),
  },
  reddit: {
    url: (source, { maxItems, oauth }) => {
      const sub = normalizeSubreddit(source.channel_id);
      return sub ? redditListingUrl(sub, maxItems, { oauth }) : null;
    },
    accept: "application/json",
    parse: (body, opts) => only(parseRedditListing(JSON.parse(body), opts)),
  },
};

/** JSON-колонка зі SQLite інколи приходить рядком. */
function feedConfigOf(source) {
  let feed = source.feed;
  if (typeof feed === "string") {
    try { feed = JSON.parse(feed); } catch { return {}; }
  }
  return feed && typeof feed === "object" ? feed : {};
}

/** Спосіб джерела: "reddit", один із DISCOVERY_KINDS, або null — невідомий. */
export function discoveryOf(source) {
  if (source.platform === "reddit") return "reddit";
  if (source.platform !== "rss") return null;
  const kind = feedConfigOf(source).discovery ?? "rss";
  return DISCOVERY_KINDS.includes(kind) ? kind : null;
}

/**
 * Чи йдуть нові статті джерела через triage (NEWS_INTAKE.md §2.2):
 * `feed.triage: true` на flow-джерелі. Без TheFlow triage не має куди
 * пропускати — такий конфіг сідер відхиляє.
 */
export function usesTriage(source) {
  return source.platform === "rss" && feedConfigOf(source).triage === true && source.isFlowEnabled?.() === true;
}

/** Стратегія джерела, або null. */
export function strategyFor(source) {
  return STRATEGIES[discoveryOf(source)] ?? null;
}

import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import { parseSitemap, titleFromUrl, wpPostsUrl, parseWpPosts } from "../src/sources/feeds/parsers.js";
import { discoveryOf, strategyFor } from "../src/sources/feeds/discovery.js";
import { feedUrlOf } from "../src/sources/feeds/FeedPoller.js";
import { decodeBody, fetchFeed } from "../src/sources/feeds/http.js";

// Фрагмент реального news sitemap NYPost (2026-10-03), скорочений.
const NEWS_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:news="http://www.google.com/schemas/sitemap-news/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://nypost.com/2026/10/03/betting/alabama-vs-mississippi-state-prediction/</loc>
    <news:news>
      <news:publication><news:name>New York Post</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>2026-10-03T11:30:00+00:00</news:publication_date>
      <news:title>Alabama vs. Mississippi State prediction &amp; picks</news:title>
      <news:keywords>college football betting, sports betting, Sports Picks</news:keywords>
    </news:news>
    <image:image><image:loc>https://nypost.com/img/a.jpg</image:loc></image:image>
  </url>
  <url>
    <loc>https://nypost.com/2026/10/03/business/fed-holds-rates-steady/</loc>
    <news:news><news:publication_date>2026-10-03T12:45:00+00:00</news:publication_date>
      <news:title>Fed holds rates steady</news:title></news:news>
  </url>
  <url>
    <loc>https://www.foxnews.com/politics/senate-passes-funding-bill</loc>
    <lastmod>2026-10-02T09:00:00Z</lastmod>
  </url>
  <url><loc>not-a-url</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://x.com/news-1.xml</loc><lastmod>2026-10-01T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://x.com/news-0.xml</loc><lastmod>2026-10-03T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://x.com/news-undated.xml</loc></sitemap>
</sitemapindex>`;

test("parseSitemap: news fields, newest first, title from the slug when there is no news:title", () => {
  const { items, children } = parseSitemap(NEWS_SITEMAP);
  assert.deepEqual(children, []);
  assert.deepEqual(items.map((i) => i.title), [
    "Fed holds rates steady",
    "Alabama vs. Mississippi State prediction & picks",
    "senate passes funding bill",
  ]);
  const [fed, bet, fox] = items;
  assert.equal(fed.id, "https://nypost.com/2026/10/03/business/fed-holds-rates-steady/");
  assert.equal(fed.link, fed.id);
  assert.equal(fed.text, "");
  assert.equal(fed.publishedAt, Date.parse("2026-10-03T12:45:00Z"));
  assert.deepEqual(bet.keywords, ["college football betting", "sports betting", "Sports Picks"]);
  assert.deepEqual(bet.imageUrls, ["https://nypost.com/img/a.jpg"]);
  assert.equal(fox.publishedAt, Date.parse("2026-10-02T09:00:00Z"), "lastmod when there is no news date");
  assert.deepEqual(fox.keywords, []);
});

test("parseSitemap: an index yields its children, freshest first, undated last", () => {
  const { items, children } = parseSitemap(SITEMAP_INDEX);
  assert.deepEqual(items, []);
  assert.deepEqual(children, ["https://x.com/news-0.xml", "https://x.com/news-1.xml", "https://x.com/news-undated.xml"]);
  assert.deepEqual(parseSitemap("<html>error page</html>"), { items: [], children: [] });
});

test("titleFromUrl reads a word slug and ignores ids", () => {
  assert.equal(titleFromUrl("https://a.com/2026/10/03/fed-holds-rates/"), "fed holds rates");
  assert.equal(titleFromUrl("https://a.com/news/oil_prices_jump.html"), "oil prices jump");
  assert.equal(titleFromUrl("https://a.com/article/123456"), null);
  assert.equal(titleFromUrl("https://a.com/a1b2c3d4e5"), null);
  assert.equal(titleFromUrl("nope"), null);
});

test("wpPostsUrl builds the posts endpoint from a site root and keeps an explicit one", () => {
  assert.equal(wpPostsUrl("https://thehill.com", 25),
    "https://thehill.com/wp-json/wp/v2/posts?per_page=25&_fields=id%2Clink%2Cdate_gmt%2Ctitle%2Cexcerpt");
  assert.equal(wpPostsUrl("https://thehill.com/some/page/", 500), wpPostsUrl("https://thehill.com", 100));
  assert.match(wpPostsUrl("https://a.com/blog/wp-json/wp/v2/posts?categories=7", 10), /^https:\/\/a\.com\/blog\/wp-json\/wp\/v2\/posts\?categories=7&per_page=10&/);
  assert.equal(wpPostsUrl("ftp://a.com"), null);
  assert.equal(wpPostsUrl("not a url"), null);
});

test("parseWpPosts: rendered HTML to text, date_gmt is UTC, junk gives nothing", () => {
  const body = JSON.stringify([
    { id: 1, link: "https://a.com/p1/", date_gmt: "2026-10-03T11:30:00",
      title: { rendered: "Oil &#8211; prices jump" }, excerpt: { rendered: "<p>Brent rose 4%.</p>" } },
    { id: 2, title: { rendered: "no link" } },
  ]);
  const [p] = parseWpPosts(body);
  assert.deepEqual([p.id, p.title, p.text, p.publishedAt], ["https://a.com/p1/", "Oil – prices jump", "Brent rose 4%.", Date.parse("2026-10-03T11:30:00Z")]);
  assert.equal(parseWpPosts(body).length, 1);
  assert.deepEqual(parseWpPosts("{\"code\":\"rest_forbidden\"}"), []);
  assert.deepEqual(parseWpPosts("<html>"), []);
});

test("discovery: one rss platform, the way set by feed.discovery; unknown ways are refused", () => {
  const rss = { platform: "rss", channel_id: "https://a.com/feed" };
  assert.equal(discoveryOf(rss), "rss");
  assert.equal(discoveryOf({ ...rss, feed: { discovery: "sitemap" } }), "sitemap");
  assert.equal(discoveryOf({ ...rss, feed: "{\"discovery\":\"wpjson\"}" }), "wpjson", "JSON column as a string");
  assert.equal(discoveryOf({ ...rss, feed: { discovery: "scrape" } }), null);
  assert.equal(discoveryOf({ platform: "reddit" }), "reddit");
  assert.equal(discoveryOf({ platform: "telegram" }), null);

  assert.equal(feedUrlOf({ ...rss, feed: { discovery: "sitemap" } }), "https://a.com/feed");
  assert.match(feedUrlOf({ platform: "rss", channel_id: "https://a.com", feed: { discovery: "wpjson" } }, 5), /wp-json\/wp\/v2\/posts\?per_page=5/);
  assert.equal(feedUrlOf({ ...rss, feed: { discovery: "scrape" } }), null);
  assert.equal(strategyFor({ ...rss, feed: { discovery: "wpjson" } }).accept, "application/json");
});

test("decodeBody: text passes through, raw gzip is unpacked, and the size cap holds after unpacking", () => {
  assert.equal(decodeBody("<rss/>"), "<rss/>");
  assert.equal(decodeBody(null), "");
  assert.equal(decodeBody(Buffer.from("plain")), "plain");
  const gz = zlib.gzipSync("<urlset/>");
  assert.equal(decodeBody(gz), "<urlset/>");
  assert.equal(decodeBody(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length)), "<urlset/>", "an ArrayBuffer, as axios gives it");
  assert.throws(() => decodeBody(zlib.gzipSync("x".repeat(10_000)), 1_000));
});

test("fetchFeed asks for bytes and decodes a .gz sitemap", async () => {
  let cfg;
  const http = { get: async (url, c) => { cfg = c; return { status: 200, headers: {}, data: zlib.gzipSync("<urlset/>") }; } };
  const r = await fetchFeed("https://a.com/news.xml.gz", { http, userAgent: "UA" });
  assert.equal(cfg.responseType, "arraybuffer");
  assert.equal(r.body, "<urlset/>");
});

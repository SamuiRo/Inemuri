import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, SourceState } from "../src/module/teapot/models/index.js";
import messageFilter from "../src/module/filters/MessageFilter.js";
import FeedPoller from "../src/sources/feeds/FeedPoller.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__fd_${process.pid}`;
const INDEX = `https://news.example.com/${XID}/index.xml`;
const SITE = `https://wp.example.com/${XID}`;
const cfg = {
  pollIntervalMin: 5, tickMs: 1_000, timeoutMs: 1, userAgent: "UA", maxItems: 25,
  maxFeedBytes: 1e6, maxTextChars: 4_000, seenGuids: 200,
};

const urlset = (urls) => `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${urls.map((u) => `
  <url><loc>${u.loc}</loc><news:news><news:publication_date>${u.at}</news:publication_date>
  <news:title>${u.title}</news:title></news:news></url>`).join("")}</urlset>`;
const index = (children) => `<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}</sitemapindex>`;

let sitemapSrc;
let wpSrc;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  sitemapSrc = await Source.create({
    platform: "rss", channel_id: INDEX, channel_name: "Sitemap flow", mode: "polling",
    feed: { discovery: "sitemap" }, flow: { enabled: true },
  });
  wpSrc = await Source.create({
    platform: "rss", channel_id: SITE, channel_name: "WP flow", mode: "polling",
    feed: { discovery: "wpjson" }, flow: { enabled: true },
  });
});

test.after(async () => {
  const ids = [sitemapSrc.id, wpSrc.id];
  await Post.destroy({ where: { source_id: ids } });
  await SourceState.destroy({ where: { source_id: ids } });
  await Source.destroy({ where: { id: ids } });
  messageFilter.clearCache();
  await database.disconnect();
});

/** Опитувач із фейковою мережею: `routes(url, call)` → тіло або { status }; запити записуються. */
function poller(routes) {
  const requests = [];
  const fetch = async (url, opts) => {
    requests.push({ url, etag: opts.etag, accept: opts.accept });
    const r = routes(url, requests.length);
    if (r?.status) return { body: null, etag: null, lastModified: null, retryAfterMs: null, ...r };
    return { status: 200, body: r, etag: `"${url}#${requests.length}"`, lastModified: null, retryAfterMs: null };
  };
  let t = Date.parse("2026-10-03T12:00:00Z");
  const p = new FeedPoller({
    eventBus: { emit: () => {} }, fetch, throttle: { run: (url, fn) => fn() }, config: cfg, now: () => t, log: () => {},
  });
  p.requests = requests;
  p.advance = (ms) => { t += ms; };
  return p;
}

test("a sitemap index is followed to its freshest child; validators belong to the child, never the index", async () => {
  const child = `https://news.example.com/${XID}/news-0.xml`;
  const old = { loc: "https://news.example.com/a/old-story", at: "2026-10-03T08:00:00Z", title: "Old story" };
  const fresh = { loc: "https://news.example.com/a/fed-holds-rates", at: "2026-10-03T11:55:00Z", title: "Fed holds rates" };
  let childBody = urlset([old]);
  const p = poller((url) => {
    if (url === INDEX) return index([child, `https://news.example.com/${XID}/news-1.xml`]);
    if (url === child) return childBody;
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(await p.pollSource(sitemapSrc), 0, "baseline");
  const state = await SourceState.findOne({ where: { source_id: sitemapSrc.id } });
  assert.equal(state.cursor.url, child);
  assert.equal(state.cursor.etag, `"${child}#2"`);

  childBody = urlset([fresh, old]);
  assert.equal(await p.pollSource(sitemapSrc), 1);
  const [toIndex, toChild] = p.requests.slice(2);
  assert.deepEqual([toIndex.url, toIndex.etag], [INDEX, null], "the index is asked unconditionally");
  assert.deepEqual([toChild.url, toChild.etag], [child, `"${child}#2"`], "the child is asked with its own ETag");

  const post = await Post.findOne({ where: { source_id: sitemapSrc.id } });
  assert.equal(post.external_id, fresh.loc);
  assert.equal(post.external_url, fresh.loc);
  assert.equal(post.title, "Fed holds rates");
  assert.equal(post.platform, "rss");
  assert.equal(post.status, "pending");
});

test("a 304 on the child ends the poll quietly", async () => {
  const before = await Post.count({ where: { source_id: sitemapSrc.id } });
  const p = poller((url) => (url === INDEX ? index([`https://news.example.com/${XID}/news-0.xml`]) : { status: 304 }));
  assert.equal(await p.pollSource(sitemapSrc), 0);
  assert.equal(await Post.count({ where: { source_id: sitemapSrc.id } }), before);
});

test("a WordPress source polls /wp-json/wp/v2/posts and ingests the excerpt as the body", async () => {
  const post = (id, at, title) => ({
    id, link: `https://wp.example.com/${XID}/${id}/`, date_gmt: at,
    title: { rendered: title }, excerpt: { rendered: `<p>${title} — details.</p>` },
  });
  let list = [post(1, "2026-10-03T09:00:00", "Base")];
  const p = poller((url) => {
    assert.match(url, /\/wp-json\/wp\/v2\/posts\?per_page=25&_fields=/);
    return JSON.stringify(list);
  });
  assert.equal(await p.pollSource(wpSrc), 0, "baseline");
  list = [post(2, "2026-10-03T11:00:00", "Senate passes funding bill"), ...list];
  assert.equal(await p.pollSource(wpSrc), 1);
  assert.equal(p.requests[0].accept, "application/json");

  const row = await Post.findOne({ where: { source_id: wpSrc.id } });
  assert.equal(row.title, "Senate passes funding bill");
  assert.equal(row.raw_text, "Senate passes funding bill — details.");
  assert.equal(row.posted_at.toISOString(), "2026-10-03T11:00:00.000Z");
});

test("a closed WordPress API (401, as NYPost answers) backs the source off instead of failing", async () => {
  const p = poller(() => ({ status: 401, forbidden: true }));
  p.sources = [wpSrc];
  assert.equal(await p.tick(), 0);
  p.advance(60 * 60_000);
  assert.equal(await p.tick(), 0);
  assert.equal(p.requests.length, 1, "no retry within the backoff");
});

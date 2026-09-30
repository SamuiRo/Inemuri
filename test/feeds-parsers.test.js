import test from "node:test";
import assert from "node:assert/strict";

import {
  parseFeed, parseRedditListing, normalizeSubreddit, redditListingUrl, selectNew, htmlToText,
} from "../src/sources/feeds/parsers.js";
import { feedUrlOf, toFeedMessageData } from "../src/sources/feeds/FeedPoller.js";
import { HostThrottle, retryAfterMs, fetchFeed } from "../src/sources/feeds/http.js";
import { UrlMediaResolver, guessFromUrl, typeFromContentType } from "../src/module/theflow/media/UrlMediaResolver.js";
import { buildEnrichPrompt } from "../src/services/ai/prompts/enrich.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>News</title>
<item>
  <title>Exchange X halts withdrawals &amp; investigates</title>
  <link>https://news.example.com/x-halts?utm_source=rss</link>
  <guid isPermaLink="false">news-123</guid>
  <pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate>
  <dc:creator>Jane Doe</dc:creator>
  <description>Short summary</description>
  <content:encoded><![CDATA[<p>Exchange <b>X</b> paused withdrawals.</p><p>More soon.<br>Stay tuned.</p><img src="https://cdn.example.com/a.jpg">]]></content:encoded>
  <media:content url="https://cdn.example.com/b.png" medium="image"/>
  <enclosure url="https://cdn.example.com/c.mp3" type="audio/mpeg"/>
</item>
<item>
  <title>No date item</title>
  <link>https://news.example.com/nodate</link>
  <description>plain</description>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Blog</title>
  <entry>
    <title>Patch 1.2 notes</title>
    <id>tag:blog,2026:1</id>
    <link rel="alternate" href="https://blog.example.com/patch-1-2"/>
    <published>2026-09-28T08:00:00Z</published>
    <author><name>Dev Team</name></author>
    <content type="html">&lt;p&gt;Fixed bugs.&lt;/p&gt;</content>
  </entry>
</feed>`;

test("RSS 2.0: guid, link, title (entities decoded), content:encoded as text, author, date, images", () => {
  const [a, b] = parseFeed(RSS);
  assert.equal(a.id, "news-123");
  assert.equal(a.link, "https://news.example.com/x-halts?utm_source=rss");
  assert.equal(a.title, "Exchange X halts withdrawals & investigates");
  assert.equal(a.text, "Exchange X paused withdrawals.\nMore soon.\nStay tuned.");
  assert.equal(a.author, "Jane Doe");
  assert.equal(a.publishedAt, Date.parse("2026-09-29T10:00:00Z"));
  assert.deepEqual(a.imageUrls, ["https://cdn.example.com/b.png", "https://cdn.example.com/a.jpg"], "audio enclosure is not an image");
  assert.equal(b.id, "https://news.example.com/nodate", "no guid → the link is the identity");
  assert.equal(b.publishedAt, null);
});

test("Atom: id, alternate link, published, author name, HTML content", () => {
  const [e] = parseFeed(ATOM);
  assert.equal(e.id, "tag:blog,2026:1");
  assert.equal(e.link, "https://blog.example.com/patch-1-2");
  assert.equal(e.title, "Patch 1.2 notes");
  assert.equal(e.text, "Fixed bugs.");
  assert.equal(e.author, "Dev Team");
  assert.equal(e.publishedAt, Date.parse("2026-09-28T08:00:00Z"));
});

test("an HTML error page instead of a feed is an empty list, not a crash", () => {
  assert.deepEqual(parseFeed("<html><body>502 Bad Gateway</body></html>"), []);
  assert.deepEqual(parseFeed(""), []);
  assert.equal(htmlToText("<script>x()</script><p>a</p><p>b</p>"), "a\nb");
});

test("Reddit: subreddit names, listing URL, parsing, NSFW and stickied dropped", () => {
  for (const raw of ["r/CS2", "cs2", "https://www.reddit.com/r/cs2/", "/r/cs2"]) assert.equal(normalizeSubreddit(raw), "cs2", raw);
  assert.equal(normalizeSubreddit("not a sub!"), null);
  assert.equal(redditListingUrl("cs2", 500), "https://www.reddit.com/r/cs2/new.json?limit=100&raw_json=1");

  const listing = { data: { children: [
    { kind: "t3", data: { name: "t3_link", title: "Valve announces case", selftext: "", is_self: false,
      url: "https://store.steampowered.com/news/1", permalink: "/r/cs2/comments/link/x/", author: "bob",
      created_utc: 1_790_000_000, post_hint: "link", preview: { images: [{ source: { url: "https://preview.redd.it/p.jpg" } }] } } },
    { kind: "t3", data: { name: "t3_self", title: "Question", selftext: "How do I **trade**?", is_self: true,
      permalink: "/r/cs2/comments/self/y/", author: "[deleted]", created_utc: 1_790_000_100 } },
    { kind: "t3", data: { name: "t3_img", title: "Screenshot", is_self: false, url: "https://i.redd.it/s.png",
      post_hint: "image", permalink: "/r/cs2/comments/img/z/", author: "al", created_utc: 1_790_000_200 } },
    { kind: "t3", data: { name: "t3_nsfw", title: "x", over_18: true, created_utc: 1 } },
    { kind: "t3", data: { name: "t3_pin", title: "Rules", stickied: true, created_utc: 1 } },
    { kind: "t1", data: { name: "t1_comment" } },
  ] } };
  const [link, self, img, ...rest] = parseRedditListing(listing);
  assert.equal(rest.length, 0);
  assert.equal(link.id, "t3_link");
  assert.equal(link.link, "https://www.reddit.com/r/cs2/comments/link/x/");
  assert.equal(link.text, "https://store.steampowered.com/news/1", "a link post carries its target URL for tier-1 dedup");
  assert.deepEqual(link.imageUrls, ["https://preview.redd.it/p.jpg"]);
  assert.equal(link.author, "u/bob");
  assert.equal(link.publishedAt, 1_790_000_000_000);
  assert.equal(self.text, "How do I **trade**?");
  assert.equal(self.author, null);
  assert.equal(img.text, "", "the image itself is media, not a link line");
  assert.deepEqual(img.imageUrls, ["https://i.redd.it/s.png"]);
  assert.deepEqual(parseRedditListing({ error: 403 }), []);
});

test("selectNew: baseline first, then only unseen items not older than the cursor, oldest first", () => {
  const items = [
    { id: "c", publishedAt: 300 }, { id: "b", publishedAt: 200 }, { id: "a", publishedAt: 100 },
  ];
  const first = selectNew(items, null);
  assert.equal(first.baseline, true);
  assert.deepEqual(first.items, []);
  assert.deepEqual(first.cursor, { ts: 300, seen: ["c", "b", "a"] });

  const next = selectNew([{ id: "e", publishedAt: 500 }, { id: "d", publishedAt: 400 }, ...items], first.cursor);
  assert.deepEqual(next.items.map((i) => i.id), ["d", "e"]);
  assert.equal(next.cursor.ts, 500);
  assert.ok(next.cursor.seen.includes("e") && next.cursor.seen.includes("a"));

  // Старий невидимий раніше елемент (видалили й повернули) — не новий.
  assert.deepEqual(selectNew([{ id: "old", publishedAt: 50 }], next.cursor).items, []);
  // Без дати — новий, якщо ще не бачили.
  assert.deepEqual(selectNew([{ id: "nodate", publishedAt: null }], next.cursor).items.map((i) => i.id), ["nodate"]);
  // Пам'ять обмежена.
  assert.equal(selectNew(items, { ts: 0, seen: [] }, { seenMax: 2 }).cursor.seen.length, 2);
});

test("feed source config: URL per platform; message data for both paths", () => {
  assert.equal(feedUrlOf({ platform: "reddit", channel_id: "r/cs2" }, 25), "https://www.reddit.com/r/cs2/new.json?limit=25&raw_json=1");
  assert.equal(feedUrlOf({ platform: "rss", channel_id: "https://a.com/feed" }), "https://a.com/feed");
  assert.equal(feedUrlOf({ platform: "rss", channel_id: "a.com/feed" }), null);
  assert.equal(feedUrlOf({ platform: "reddit", channel_id: "??" }), null);

  const md = toFeedMessageData({ platform: "rss", channel_id: "https://a.com/feed" },
    { id: "g1", link: "https://a.com/1", title: "Title", text: "Body", author: "J", publishedAt: 1000, imageUrls: ["https://a.com/i.jpg"] });
  assert.equal(md.externalId, "g1");
  assert.equal(md.externalUrl, "https://a.com/1");
  assert.equal(md.body, "Body");
  assert.equal(md.rawText, "Title\n\nBody\n\nhttps://a.com/1");
  assert.equal(md.text, "**Title**\n\nBody\n\nhttps://a.com/1");
  assert.deepEqual(md.entities, [{ className: "MessageEntityBold", offset: 0, length: 5 }]);
  assert.deepEqual(md.mediaUrls, ["https://a.com/i.jpg"]);
});

test("HostThrottle: one host waits its interval, another host does not", async () => {
  let t = 0;
  const slept = [];
  const th = new HostThrottle({
    intervals: { default: 1_000, "reddit.com": 7_000 }, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; },
  });
  assert.equal(th.intervalFor("old.reddit.com"), 7_000);
  assert.equal(th.intervalFor("example.com"), 1_000);
  await th.run("https://www.reddit.com/a", async () => 1);
  await th.run("https://www.reddit.com/b", async () => 2);
  await th.run("https://example.com/c", async () => 3);
  assert.deepEqual(slept, [7_000], "second reddit call waits, the other host does not");
  assert.equal(await th.run("https://example.com/d", async () => "ok"), "ok");
});

test("retryAfterMs and fetchFeed: conditional headers, 304 and 429 are answers, not errors", async () => {
  assert.equal(retryAfterMs("30"), 30_000);
  assert.equal(retryAfterMs("Thu, 01 Jan 2099 00:00:10 GMT", Date.parse("2099-01-01T00:00:00Z")), 10_000);
  assert.equal(retryAfterMs(null), null);

  let seen;
  const http = { get: async (url, cfg) => { seen = cfg; return { status: 304, headers: {}, data: "" }; } };
  const r = await fetchFeed("https://a.com/feed", { http, userAgent: "UA", etag: "\"e1\"", lastModified: "Mon" });
  assert.equal(r.status, 304);
  assert.equal(r.body, null);
  assert.equal(seen.headers["if-none-match"], "\"e1\"");
  assert.equal(seen.headers["user-agent"], "UA");
  assert.ok(seen.validateStatus(429) && seen.validateStatus(304) && !seen.validateStatus(404));

  const limited = await fetchFeed("https://a.com/feed", { http: { get: async () => ({ status: 429, headers: { "retry-after": "120" } }) } });
  assert.equal(limited.retryAfterMs, 120_000);
  const ok = await fetchFeed("https://a.com/feed", { http: { get: async () => ({ status: 200, headers: { etag: "E" }, data: "<rss/>" }) } });
  assert.deepEqual([ok.body, ok.etag, ok.retryAfterMs], ["<rss/>", "E", null]);
});

test("UrlMediaResolver: filters before download, verifies Content-Type after, one dead image does not stop the rest", async () => {
  assert.deepEqual(guessFromUrl("https://x.com/a.gif?x=1"), { type: "animation", mimeType: "image/gif" });
  assert.equal(guessFromUrl("https://x.com/v.mp4").type, "video");
  assert.equal(guessFromUrl("https://x.com/noext").type, "photo");
  assert.equal(typeFromContentType("image/png; q=1"), "photo");
  assert.equal(typeFromContentType("text/html"), null);

  const fetched = [];
  const http = { get: async (url) => {
    fetched.push(url);
    if (url.includes("dead")) throw new Error("404");
    if (url.includes("html")) return { headers: { "content-type": "text/html" }, data: new Uint8Array([60]) };
    return { headers: { "content-type": "image/png" }, data: new Uint8Array([1, 2, 3]) };
  } };
  const r = new UrlMediaResolver({ http, throttle: { run: (u, fn) => fn() }, config: { timeoutMs: 1, maxMediaBytes: 10, userAgent: "UA" } });
  const post = { media_ref: { kind: "url", urls: [
    "https://x.com/dead.png", "https://x.com/page-html.jpg", "https://x.com/ok.png", "https://x.com/clip.mp4", "ftp://x/y.png",
  ] } };
  const files = await r.resolve(post, { types: ["photo"] });
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "ok.png");
  assert.ok(Buffer.isBuffer(files[0].buffer));
  assert.ok(!fetched.some((u) => u.endsWith(".mp4")), "a video is never downloaded when only photos were asked for");
  assert.equal((await r.resolve(post, { types: ["photo"], limit: 1 })).length, 0, "limit applies before download");
});

test("enrich prompt: the title is its own field inside the untrusted block", () => {
  const p = buildEnrichPrompt({ text: "Body text", title: "Headline", taxonomy: { topics: {}, signals: {} }, nonce: "n" });
  const open = p.user.indexOf("<<<UNTRUSTED n>>>");
  const t = p.user.indexOf("--- title ---\nHeadline\n--- body ---\nBody text");
  assert.ok(open >= 0 && t > open && t < p.user.indexOf("<<<END UNTRUSTED n>>>"));
  assert.ok(!buildEnrichPrompt({ text: "Body", taxonomy: {}, nonce: "n" }).user.includes("--- title ---"));
});

test("RedditAuth: client_credentials with basic auth, token cached until expiry, invalidate forces a new one", async () => {
  const { RedditAuth } = await import("../src/sources/feeds/http.js");
  let t = 0;
  const posts = [];
  const http = { post: async (url, body, cfg) => { posts.push({ url, body, cfg }); return { data: { access_token: `tok${posts.length}`, expires_in: 3600 } }; } };
  const a = new RedditAuth({ clientId: "id", clientSecret: "sec", userAgent: "UA", http, now: () => t });
  assert.equal(a.configured, true);
  assert.equal(await a.token(), "tok1");
  assert.equal(await a.token(), "tok1");
  assert.equal(posts[0].url, "https://www.reddit.com/api/v1/access_token");
  assert.equal(posts[0].body, "grant_type=client_credentials");
  assert.deepEqual(posts[0].cfg.auth, { username: "id", password: "sec" });
  t += 3_600_000;
  assert.equal(await a.token(), "tok2", "expired → refreshed");
  a.invalidate();
  assert.equal(await a.token(), "tok3");
  assert.equal(new RedditAuth({ clientId: null, clientSecret: null }).configured, false);
  assert.equal(redditListingUrl("cs2", 5, { oauth: true }), "https://oauth.reddit.com/r/cs2/new?limit=5&raw_json=1");
});

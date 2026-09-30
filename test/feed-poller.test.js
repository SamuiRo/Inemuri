import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, SourceState } from "../src/module/teapot/models/index.js";
import messageFilter from "../src/module/filters/MessageFilter.js";
import FeedPoller from "../src/sources/feeds/FeedPoller.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__fp_${process.pid}`;
const FEED = `https://feeds.example.com/${XID}.xml`;
const cfg = {
  pollIntervalMin: 15, tickMs: 1_000, timeoutMs: 1, userAgent: "UA", maxItems: 25,
  maxFeedBytes: 1e6, maxTextChars: 4_000, seenGuids: 200,
};
const noThrottle = { run: (url, fn) => fn() };

const rss = (items) => `<rss version="2.0"><channel>${items.map((i) => `
  <item><title>${i.title}</title><link>${i.link}</link><guid>${i.guid}</guid>
  <pubDate>${new Date(i.at).toUTCString()}</pubDate><description>${i.body ?? ""}</description></item>`).join("")}
</channel></rss>`;

let flowSrc;
let classicSrc;
let redditSrc;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  flowSrc = await Source.create({
    platform: "rss", channel_id: FEED, channel_name: "RSS flow", mode: "polling",
    flow: { enabled: true }, filters: { enabled: true, blacklist: ["sponsored"], keywords: [], case_sensitive: false },
  });
  classicSrc = await Source.create({
    platform: "rss", channel_id: `${FEED}?classic`, channel_name: "RSS classic", mode: "polling",
    destinations: { telegram: ["-100dest"], discord: [] },
  });
  redditSrc = await Source.create({
    platform: "reddit", channel_id: `r/${XID.replace(/[^a-z0-9]/gi, "").slice(0, 18)}`, channel_name: "Reddit flow",
    mode: "polling", flow: { enabled: true },
  });
});

test.after(async () => {
  const ids = [flowSrc.id, classicSrc.id, redditSrc.id];
  await Post.destroy({ where: { source_id: ids } });
  await SourceState.destroy({ where: { source_id: ids } });
  await Source.destroy({ where: { id: ids } });
  messageFilter.clearCache();
  await database.disconnect();
});

function poller({ bodies, emitted = [] }) {
  let call = 0;
  const fetch = async (url) => {
    const b = typeof bodies === "function" ? bodies(url, call++) : bodies[Math.min(call++, bodies.length - 1)];
    return { status: 200, body: b, etag: `e${call}`, lastModified: null, retryAfterMs: null, ...(b?.status ? b : {}) };
  };
  let t = Date.parse("2026-09-30T12:00:00Z");
  const p = new FeedPoller({
    eventBus: { emit: (name, data) => emitted.push({ name, data }) },
    fetch, throttle: noThrottle, config: cfg, now: () => t, log: () => {},
  });
  p.advance = (ms) => { t += ms; };
  return p;
}

test("RSS into TheFlow: baseline first, then new items become pending posts; blacklist applies; re-polls are idempotent", async () => {
  const first = [{ guid: "g1", title: "Old news", link: "https://n.example.com/1", at: "2026-09-30T08:00:00Z" }];
  const second = [
    { guid: "g3", title: "Exchange hacked", link: "https://n.example.com/3?utm_source=rss", at: "2026-09-30T11:00:00Z", body: "Funds drained." },
    { guid: "g2", title: "Sponsored: buy now", link: "https://n.example.com/2", at: "2026-09-30T10:00:00Z" },
    ...first,
  ];
  const p = poller({ bodies: (url, i) => (url === FEED ? rss(i === 0 ? first : second) : "") });
  await p.load();
  p.sources = p.sources.filter((s) => s.id === flowSrc.id);

  assert.equal(await p.pollSource(flowSrc), 0, "first poll is a baseline");
  assert.equal(await Post.count({ where: { source_id: flowSrc.id } }), 0);
  const state = await SourceState.findOne({ where: { source_id: flowSrc.id } });
  assert.deepEqual(state.cursor.seen, ["g1"]);
  assert.equal(state.cursor.etag, "e1");

  assert.equal(await p.pollSource(flowSrc), 2);
  const posts = await Post.findAll({ where: { source_id: flowSrc.id }, order: [["posted_at", "ASC"]] });
  assert.deepEqual(posts.map((x) => [x.external_id, x.status]), [["g2", "skipped_blacklist"], ["g3", "pending"]]);
  const hack = posts[1];
  assert.equal(hack.platform, "rss");
  assert.equal(hack.title, "Exchange hacked");
  assert.equal(hack.raw_text, "Funds drained.", "raw_text is the body; the title is separate");
  assert.equal(hack.external_url, "https://n.example.com/3?utm_source=rss");
  assert.equal(hack.channel_id, FEED);

  assert.equal(await p.pollSource(flowSrc), 0, "nothing new on the next poll");
});

test("a Reddit link post with only a title is not skipped as empty; its image becomes a url media_ref", async () => {
  const listing = (children) => JSON.stringify({ data: { children } });
  const base = { kind: "t3", data: { name: "t3_old", title: "old", created_utc: 1_790_000_000, permalink: "/r/x/1/" } };
  const fresh = { kind: "t3", data: {
    name: "t3_new", title: "Valve adds a new case to CS2", selftext: "", is_self: false,
    url: "https://i.redd.it/case.png", post_hint: "image", permalink: "/r/x/comments/new/", author: "al",
    created_utc: 1_790_000_600,
  } };
  const p = poller({ bodies: [listing([base]), listing([fresh, base])] });
  await p.pollSource(redditSrc);
  assert.equal(await p.pollSource(redditSrc), 1);
  const post = await Post.findOne({ where: { source_id: redditSrc.id, external_id: "t3_new" } });
  assert.equal(post.status, "pending");
  assert.equal(post.title, "Valve adds a new case to CS2");
  assert.equal(post.raw_text, "");
  assert.equal(post.has_media, true);
  assert.deepEqual(post.media_ref, { kind: "url", urls: ["https://i.redd.it/case.png"] });
  assert.equal(post.external_url, "https://www.reddit.com/r/x/comments/new/");
});

test("a classic (non-flow) feed source forwards through message.received with a bold title", async () => {
  const emitted = [];
  const items = [{ guid: "c1", title: "Base", link: "https://c.example.com/1", at: "2026-09-30T08:00:00Z" }];
  const more = [{ guid: "c2", title: "Headline", link: "https://c.example.com/2", at: "2026-09-30T09:00:00Z", body: "Text" }, ...items];
  const p = poller({ bodies: [rss(items), rss(more)], emitted });
  await p.pollSource(classicSrc);
  await p.pollSource(classicSrc);
  assert.equal(emitted.length, 1);
  const m = emitted[0];
  assert.equal(m.name, "message.received");
  assert.equal(m.data.rawText, "Headline\n\nText\n\nhttps://c.example.com/2");
  assert.deepEqual(m.data.entities, [{ className: "MessageEntityBold", offset: 0, length: 8 }]);
  assert.deepEqual(m.data.source.destinations.telegram, ["-100dest"]);
  assert.equal(await Post.count({ where: { source_id: classicSrc.id } }), 0, "classic sources never touch posts");
});

test("304 and 429: nothing parsed; a rate-limited source waits for Retry-After", async () => {
  const p = poller({ bodies: [{ status: 429, body: null, retryAfterMs: 600_000 }] });
  p.sources = [flowSrc];
  assert.equal(await p.tick(), 0);
  // Ще не час: tick нічого не опитує.
  let fetched = 0;
  p.fetch = async () => { fetched++; return { status: 304, body: null, retryAfterMs: null }; };
  p.advance(5 * 60_000);
  await p.tick();
  assert.equal(fetched, 0, "still inside Retry-After");
  p.advance(20 * 60_000);
  await p.tick();
  assert.equal(fetched, 1);
});

test("Reddit with OAuth goes to oauth.reddit.com with a bearer token; 403 warns once and backs off", async () => {
  const calls = [];
  const logs = [];
  let t = Date.parse("2026-09-30T12:00:00Z");
  const auth = { configured: true, token: async () => "TOKEN", invalidate() { this.invalidated = true; } };
  const p = new FeedPoller({
    eventBus: { emit() {} }, throttle: noThrottle, config: { ...cfg, forbiddenBackoffMin: 360 }, redditAuth: auth,
    now: () => t, log: (m) => logs.push(m),
    fetch: async (url, opts) => { calls.push({ url, opts }); return { status: 401, body: null, forbidden: true, retryAfterMs: null }; },
  });
  p.sources = [redditSrc];
  await p.tick();
  assert.match(calls[0].url, /^https:\/\/oauth\.reddit\.com\/r\/[a-z0-9_]+\/new\?limit=25&raw_json=1$/);
  assert.equal(calls[0].opts.headers.authorization, "bearer TOKEN");
  assert.equal(auth.invalidated, true, "a 401 drops the cached token");

  t += 60 * 60_000;
  await p.tick();
  assert.equal(calls.length, 1, "backed off for hours, not re-polled every tick");
  t += 6 * 60 * 60_000;
  await p.tick();
  assert.equal(calls.length, 2);
  assert.equal(logs.filter((m) => m.includes("answered 401")).length, 1, "warned once, not every poll");
});

test("without OAuth a 403 from Reddit says what to configure", async () => {
  const logs = [];
  const p = new FeedPoller({
    eventBus: { emit() {} }, throttle: noThrottle, config: { ...cfg, reddit: {} }, now: () => 0, log: (m) => logs.push(m),
    fetch: async () => ({ status: 403, body: null, forbidden: true, retryAfterMs: null }),
  });
  assert.equal(p.redditAuth, null);
  assert.equal(await p.pollSource(redditSrc), 0);
  assert.match(logs[0], /REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET/);
});

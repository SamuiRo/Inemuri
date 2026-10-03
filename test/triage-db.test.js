import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, SourceState, DiscoveredItem, KnowledgeExample } from "../src/module/teapot/models/index.js";
import messageFilter from "../src/module/filters/MessageFilter.js";
import FeedPoller from "../src/sources/feeds/FeedPoller.js";
import TriageQueue from "../src/module/theflow/triage/TriageQueue.js";
import TriageStage from "../src/module/theflow/triage/TriageStage.js";
import { reviewQueue, collectTriageStats } from "../src/module/theflow/triage/report.js";
import { recordHeadlineLabel } from "../src/module/theflow/knowledge/KnowledgeBase.js";
import profile from "../src/config/triage.sample.json" with { type: "json" };

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__tr_${process.pid}`;
const SITEMAP = `https://news.example.com/${XID}/news.xml`;
const cfg = {
  pollIntervalMin: 5, tickMs: 1_000, timeoutMs: 1, userAgent: "UA", maxItems: 25,
  maxFeedBytes: 1e6, maxTextChars: 4_000, seenGuids: 200,
};
const quiet = () => {};

let src;
let seq = 0;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  src = await Source.create({
    platform: "rss", channel_id: SITEMAP, channel_name: "Triage News", mode: "polling",
    feed: { discovery: "sitemap", triage: true }, flow: { enabled: true },
  });
});

// Кожен тест — з чистого джерела: рядки попереднього (навіть упалого) не заважають.
test.beforeEach(async () => {
  await DiscoveredItem.destroy({ where: { source_id: src.id } });
  await Post.destroy({ where: { source_id: src.id } });
});

test.after(async () => {
  await KnowledgeExample.destroy({ where: { source_name: "Triage News" } });
  await DiscoveredItem.destroy({ where: { source_id: src.id } });
  await Post.destroy({ where: { source_id: src.id } });
  await SourceState.destroy({ where: { source_id: src.id } });
  await Source.destroy({ where: { id: src.id } });
  messageFilter.clearCache();
  await database.disconnect();
});

const article = (section, title, at = "2026-10-03T12:00:00Z") => {
  seq += 1;
  return { id: `https://news.example.com/2026/10/03/${section}/${XID}-${seq}/`, link: `https://news.example.com/2026/10/03/${section}/${XID}-${seq}/`,
    title, text: "", author: null, publishedAt: Date.parse(at), imageUrls: [], keywords: [] };
};

/** Фейковий gateway: `decide(items)` → decisions. */
const fakeGateway = (decide) => ({
  calls: 0,
  async triage(input) {
    this.calls += 1;
    return decide(input.items);
  },
});

const pollerFor = () => new FeedPoller({
  eventBus: { emit: quiet }, fetch: async () => ({ status: 304 }), throttle: { run: (u, fn) => fn() }, config: cfg, now: Date.now, log: quiet,
});

test("the queue rejects deny-listed sections at once, queues the rest, and ignores repeats", async () => {
  const q = new TriageQueue({ profile, log: quiet });
  const bet = article("betting", "Alabama picks");
  const science = article("science", "Trial cuts migraine days by half");
  assert.deepEqual(await q.add(src, bet), { created: true, status: "rejected" });
  assert.deepEqual(await q.add(src, science), { created: true, status: "pending" });
  assert.deepEqual(await q.add(src, science), { created: false, status: "pending" });

  const rule = await DiscoveredItem.findOne({ where: { source_id: src.id, external_id: bet.id } });
  assert.deepEqual([rule.decided_by, rule.reason, rule.profile_version], ["rule", "section:betting", profile.version]);
});

test("a triage source sends new articles to the queue, not to posts; a pass becomes a post", async () => {
  const p = pollerFor();
  const fresh = article("science", "Walking linked to lower blood pressure");
  await p.handleItem(src, fresh);
  assert.equal(await Post.count({ where: { source_id: src.id } }), 0);
  const row = await DiscoveredItem.findOne({ where: { source_id: src.id, external_id: fresh.id } });
  assert.equal(row.status, "pending");
  assert.equal(row.section, "science");

  const post = await p.promote(row);
  assert.equal(post.title, "Walking linked to lower blood pressure");
  assert.equal(post.external_id, fresh.id);
  assert.equal(post.status, "pending");
});

test("the stage decides a batch: passes become posts, rejects are sampled, silent items retry then fail", async () => {
  const q = new TriageQueue({ profile, log: quiet });
  const drug = article("science", "Drug trial halves migraine days");
  const gossip = article("entertainment", "Star wears hat");
  const skipped = article("us-news", "Item the model forgets");
  for (const a of [drug, gossip, skipped]) await q.add(src, a);

  const poller = pollerFor();
  const promoted = [];
  const gw = fakeGateway((items) => ({
    model_used: "fake",
    decisions: items.map((it, index) => (it.title.startsWith("Drug")
      ? { index, relevant: true, area: "science", reason: "new trial" }
      : it.title.startsWith("Star") ? { index, relevant: false, area: null, reason: "celebrity" } : null)).filter(Boolean),
  }));
  const stage = new TriageStage({ maxWaitMs: 0,
    gateway: gw, profile, random: () => 0, sampleRate: 0.05, maxAttempts: 2, log: quiet,
    promote: async (row) => { promoted.push(row.title); return poller.promote(row); },
  });

  assert.equal(await stage.runOnce(), 2);
  const by = async (a) => DiscoveredItem.findOne({ where: { source_id: src.id, external_id: a.id } });
  const d = await by(drug);
  const post = await Post.findByPk(d.post_id);
  assert.deepEqual([d.status, d.decided_by, d.area, d.reason, d.model_used], ["passed", "llm", "science", "new trial", "fake"]);
  assert.deepEqual([post.title, post.status], ["Drug trial halves migraine days", "pending"]);
  const g = await by(gossip);
  assert.deepEqual([g.status, g.sampled, g.area], ["rejected", true, null]);
  assert.deepEqual(promoted, ["Drug trial halves migraine days"]);

  let s = await by(skipped);
  assert.deepEqual([s.status, s.attempts, s.last_error], ["pending", 1, "no decision in the response"]);
  await stage.runOnce();
  s = await by(skipped);
  assert.deepEqual([s.status, s.attempts], ["failed", 2], "maxAttempts reached");
});

test("shed leaves the batch pending without spending attempts; a failed promotion is retried next tick", async () => {
  const q = new TriageQueue({ profile, log: quiet });
  const a = article("business", "Shares surge 40% on record results");
  await q.add(src, a);

  const shed = new TriageStage({ maxWaitMs: 0, gateway: fakeGateway(() => ({ shed: true })), profile, promote: async () => ({ id: 1 }), log: quiet });
  assert.equal(await shed.runOnce(), 0);
  let row = await DiscoveredItem.findOne({ where: { source_id: src.id, external_id: a.id } });
  assert.deepEqual([row.status, row.attempts], ["pending", 0]);

  const poller = pollerFor();
  let fail = true;
  const stage = new TriageStage({ maxWaitMs: 0,
    gateway: fakeGateway(() => ({ model_used: "fake", decisions: [{ index: 0, relevant: true, area: "markets", reason: "sharp move" }] })),
    profile, log: quiet,
    promote: async (r) => { if (fail) throw new Error("db locked"); return poller.promote(r); },
  });
  await stage.runOnce();
  row = await DiscoveredItem.findOne({ where: { source_id: src.id, external_id: a.id } });
  assert.deepEqual([row.status, row.post_id, row.last_error], ["passed", null, "promote: db locked"]);

  fail = false;
  assert.equal(await stage.runOnce(), 1, "the leftover is promoted");
  row = await DiscoveredItem.findOne({ where: { source_id: src.id, external_id: a.id } });
  assert.equal(row.last_error, null);
  assert.equal((await Post.findByPk(row.post_id)).title, "Shares surge 40% on record results");
});

test("review shows passes and sampled rejects; a label lands in the knowledge base once", async () => {
  const q = new TriageQueue({ profile, log: quiet });
  const items = [article("lifestyle", "A bakery grows into a 40-store chain"), article("us-news", "Local fire"), article("us-news", "Mayor speaks")];
  for (const a of items) await q.add(src, a);
  const rows = await DiscoveredItem.findAll({ where: { source_id: src.id }, order: [["id", "ASC"]] });
  await rows[0].update({ status: "rejected", decided_by: "llm", sampled: true, reason: "lifestyle" });
  await rows[1].update({ status: "passed", decided_by: "llm", area: "markets" });
  await rows[2].update({ status: "rejected", decided_by: "llm", sampled: false });

  const queue = (await reviewQueue()).filter((r) => r.source_id === src.id);
  assert.deepEqual(queue.map((r) => r.id), [rows[0].id, rows[1].id]);

  const example = await recordHeadlineLabel({ row: queue[0], verdict: "missed", note: "business story with hard numbers" });
  assert.deepEqual([example.level, example.verdict, example.reason, example.source_name, example.origin],
    ["headline", "missed", "business story with hard numbers", "Triage News", "review"]);
  assert.ok(!(await reviewQueue()).some((r) => r.id === rows[0].id), "reviewed once");

  const stats = await collectTriageStats({ days: 1 });
  const mine = stats.bySource.find((s) => s.source === "Triage News");
  assert.deepEqual([mine.total, mine.passed, mine.llmRejected], [3, 1, 2]);
  assert.equal(stats.reviewed.missed >= 1, true);
});

test("an incomplete batch waits for maxWait; a full one goes at once", async () => {
  const q = new TriageQueue({ profile, log: quiet });
  await q.add(src, article("science", "First"));
  await q.add(src, article("science", "Second"));
  const gw = fakeGateway((items) => ({ model_used: "fake", decisions: items.map((_, index) => ({ index, relevant: false, area: null, reason: "x" })) }));
  let t = Date.now();
  const stage = new TriageStage({ gateway: gw, profile, promote: async () => null, log: quiet, random: () => 1,
    batchSize: 3, maxWaitMs: 20 * 60_000, now: () => t });

  assert.equal(await stage.runOnce(), 0);
  assert.equal(gw.calls, 0, "2 of 3, still young: wait");
  t += 21 * 60_000;
  assert.equal(await stage.runOnce(), 2, "the oldest waited long enough");

  for (const title of ["A", "B", "C"]) await q.add(src, article("science", title));
  t = Date.now();
  assert.equal(await stage.runOnce(), 3, "a full batch does not wait");
  assert.equal(gw.calls, 2);
});

test("sweep removes candidates older than the retention", async () => {
  const q = new TriageQueue({ profile, log: quiet });
  await q.add(src, article("science", "Old"));
  const later = new Date(Date.now() + 15 * 86_400_000);
  assert.ok(await DiscoveredItem.sweep({ retentionDays: 14, now: later }) >= 1);
  assert.equal(await DiscoveredItem.count({ where: { source_id: src.id } }), 0);
});

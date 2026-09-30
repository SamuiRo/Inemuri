import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../src/module/teapot/models/index.js";
import FlowDelivery from "../src/module/theflow/delivery/FlowDelivery.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Стадія бере всі пости, що чекають доставки, тож кожен тест прибирає за собою.
const XID = `__fd_${process.pid}_`;
const routing = {
  unsorted_destinations: { telegram: ["-100unsorted"] },
  routing: [{ priority: 10, when: { topic: "steam" }, destinations: { telegram: ["-100steam"], discord: ["d-steam"] } }],
};
let src;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  [src] = await Source.findOrCreate({
    where: { channel_id: `${XID}src` },
    defaults: { platform: "telegram", channel_id: `${XID}src`, channel_name: "Deliv Src",
      flow: { enabled: true, min_confidence: 0.6 } },
  });
});

async function cleanup() {
  const rows = await Post.findAll({ where: { source_id: src.id }, attributes: ["id", "cluster_id"] });
  const cids = [...new Set(rows.map((r) => r.cluster_id).filter(Boolean))];
  if (rows.length) await Post.destroy({ where: { id: rows.map((r) => r.id) } });
  if (cids.length) await Cluster.destroy({ where: { id: cids } });
}
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await Source.destroy({ where: { id: src.id } });
  await database.disconnect();
});

let seq = 0;
async function post(over = {}) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: src.id, platform: "telegram", external_id: `${XID}${seq}`,
    channel_id: "-1001111111111", raw_text: `Post body ${seq}`, text_md: `Post body ${seq}`,
    text_hash: `${XID}h${seq}`, status: "enriched", topic: "steam", signal_type: "event", confidence: 0.9,
    model_used: "m", taxonomy_version: 1, attempts: 1, posted_at: new Date(),
    link_role: "canonical", dedup: { decision: "new" },
    ...over,
  });
  return p;
}

function fakeRouter({ fail = false } = {}) {
  const sent = [];
  let n = 0;
  const route = async (md) => {
    sent.push(md);
    if (fail) return [];
    return Object.entries(md.source.destinations).flatMap(([platform, ids]) =>
      ids.map((id) => ({ platform, channel_id: id, message_id: ++n, sent_at: new Date("2026-09-30T12:00:00Z") })));
  };
  return { route, sent };
}

const stage = (over = {}) => new FlowDelivery({ routing, dedupEnabled: true, ...over });

test("a routed post goes to both platforms, becomes routed, and the cluster records where", async () => {
  const cluster = await Cluster.create({ topic: "steam", signal_type: "event", members_count: 2, delivered: [] });
  const p = await post({ cluster_id: cluster.id, has_media: true,
    media_ref: { kind: "telegram", channel_id: "-1001111111111", message_id: 1 } });
  const { route, sent } = fakeRouter();
  const mediaCalls = [];
  // Форма запису — як у справжнього резолвера: байти в `buffer`.
  const d = stage({ route, resolveMedia: async (post, opts) => {
    mediaCalls.push(opts);
    return [{ type: "photo", buffer: Buffer.from([1, 2, 3]), filename: "a.jpg", mimeType: "image/jpeg" }];
  } });

  assert.equal(await d.runOnce(), 1);
  assert.equal(sent.length, 2);
  const tg = sent.find((m) => m.source.destinations.telegram);
  const ds = sent.find((m) => m.source.destinations.discord);
  assert.deepEqual(tg.source.destinations, { telegram: ["-100steam"] });
  assert.match(tg.source.name, /^Deliv Src — 🎮 steam · event$/);
  assert.match(tg.rawText, /📡 Also reported by 1 more channel/);
  assert.equal(ds.embed.footer, "steam · event");
  assert.equal(tg.downloadedMedia.length, 1, "media fetched once, lazily, for a post actually sent");
  assert.ok(Buffer.isBuffer(tg.downloadedMedia[0].data), "adapters read `data`, resolvers give `buffer`");
  assert.equal(mediaCalls.length, 1);

  const P = await Post.findByPk(p.id);
  assert.equal(P.status, "routed");
  assert.equal(P.delivery.outcome, "routed");
  assert.equal(P.delivery.delivered.length, 2);
  const C = await Cluster.findByPk(cluster.id);
  assert.equal(C.delivered.length, 2);
  assert.equal(await d.runOnce(), 0, "never sent twice");
});

test("low confidence and failed posts go to #unsorted with diagnostics", async () => {
  const low = await post({ confidence: 0.3 });
  const failed = await post({ status: "failed", topic: null, signal_type: null, confidence: null, link_role: null, dedup: null });
  const { route, sent } = fakeRouter();
  await stage({ route }).runOnce();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((m) => m.source.destinations.telegram?.[0] === "-100unsorted"));
  assert.ok(sent.some((m) => m.rawText.includes("🔧 low_confidence")));
  assert.ok(sent.some((m) => m.rawText.includes("🔧 model_failed")));
  assert.equal((await Post.findByPk(low.id)).status, "unsorted");
  assert.equal((await Post.findByPk(failed.id)).status, "unsorted");
});

test("waits for dedup; never sends duplicates or linked posts", async () => {
  await post({ dedup: null, link_role: null });
  await post({ status: "suppressed", link_role: "duplicate" });
  await post({ link_role: "linked" });
  const { route, sent } = fakeRouter();
  assert.equal(await stage({ route }).runOnce(), 0);
  assert.equal(sent.length, 0);
  // Без стадії дедуплікації пост без рішення йде.
  assert.equal(await stage({ route, dedupEnabled: false }).runOnce(), 1);
});

test("history is never delivered: an old post is marked too_old and left alone", async () => {
  const old = await post({ posted_at: new Date(Date.now() - 30 * 86_400_000) });
  const { route, sent } = fakeRouter();
  await stage({ route }).runOnce();
  assert.equal(sent.length, 0);
  const P = await Post.findByPk(old.id);
  assert.equal(P.status, "enriched");
  assert.equal(P.delivery.skipped, "too_old");
  assert.equal(await stage({ route }).runOnce(), 0);
});

test("a cluster already delivered is not delivered again by a new canonical", async () => {
  const cluster = await Cluster.create({ topic: "steam", signal_type: "event", delivered: [{ platform: "telegram", channel_id: "x", message_id: 1 }] });
  const p = await post({ cluster_id: cluster.id });
  const { route, sent } = fakeRouter();
  await stage({ route }).runOnce();
  assert.equal(sent.length, 0);
  assert.equal((await Post.findByPk(p.id)).delivery.skipped, "cluster_already_delivered");
});

test("a failed send is retried up to maxAttempts, then left with the error", async () => {
  const p = await post();
  const { route, sent } = fakeRouter({ fail: true });
  const d = stage({ route, maxAttempts: 2 });
  await d.runOnce();
  assert.equal((await Post.findByPk(p.id)).delivery.attempts, 1);
  await d.runOnce();
  const P = await Post.findByPk(p.id);
  assert.equal(P.delivery.attempts, 2);
  assert.equal(P.delivery.failed, true);
  assert.equal(P.status, "enriched");
  assert.equal(await d.runOnce(), 0, "attempts exhausted");
  assert.equal(sent.length, 4);
});

test("media failure does not block the text", async () => {
  const p = await post({ has_media: true, media_ref: { kind: "telegram" } });
  const { route, sent } = fakeRouter();
  await stage({ route, resolveMedia: async () => { throw new Error("FILE_REFERENCE_EXPIRED"); } }).runOnce();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].downloadedMedia, []);
  assert.match((await Post.findByPk(p.id)).delivery.media_error, /FILE_REFERENCE_EXPIRED/);
});

test("no destinations anywhere → skipped with the reason, nothing lost silently", async () => {
  const p = await post({ topic: "other" });
  const { route } = fakeRouter();
  await stage({ route, routing: { unsorted_destinations: {}, routing: [] } }).runOnce();
  const P = await Post.findByPk(p.id);
  assert.equal(P.delivery.skipped, "no_destinations");
  assert.equal(P.delivery.reason, "topic_other");
});

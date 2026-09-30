import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../src/module/teapot/models/index.js";
import DedupStage from "../src/module/theflow/dedup/DedupStage.js";
import { FlowIngest } from "../src/module/theflow/FlowIngest.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Стадія бере ВСІ enriched без рішення, тож кожен тест прибирає за собою.
const XID = `__dd_${process.pid}_`;
const taxonomy = {
  signals: {
    promo_code: { dedup_window_hours: 24 },
    event: { dedup_window_hours: 48 },
    security: { dedup_window_hours: 6 },
  },
};
const thresholds = { high: 0.9, low: 0.75, gateFactor: 1.15, replaceFactor: 2 };
let srcA;
let srcB;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  [srcA] = await Source.findOrCreate({
    where: { channel_id: `${XID}a` },
    defaults: { platform: "telegram", channel_id: `${XID}a`, channel_name: "dedup A", flow: { enabled: true } },
  });
  [srcB] = await Source.findOrCreate({
    where: { channel_id: `${XID}b` },
    defaults: { platform: "telegram", channel_id: `${XID}b`, channel_name: "dedup B", flow: { enabled: true } },
  });
});

async function cleanup() {
  const rows = await Post.findAll({ where: { source_id: [srcA.id, srcB.id] }, attributes: ["id", "cluster_id"] });
  const clusterIds = [...new Set(rows.map((r) => r.cluster_id).filter(Boolean))];
  if (rows.length) await Post.destroy({ where: { id: rows.map((r) => r.id) } });
  if (clusterIds.length) await Cluster.destroy({ where: { id: clusterIds } });
}

test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await Source.destroy({ where: { id: [srcA.id, srcB.id] } });
  await database.disconnect();
});

const vec = (...xs) => {
  const v = Float32Array.from(xs);
  const n = Math.hypot(...v);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return Buffer.from(v.buffer);
};

let seq = 0;
async function enriched(source, over = {}) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: source.id,
    platform: "telegram",
    external_id: `${XID}${seq}`,
    channel_id: source.channel_id,
    raw_text: "t",
    text_md: "t",
    text_hash: `${XID}h${seq}`,
    status: "enriched",
    topic: "steam",
    signal_type: "event",
    confidence: 0.9,
    text_en: `post ${seq}`,
    candidates: { urls: [], dates: [], amounts: [], promo_codes: [] },
    analysis: { entities: { tickers: [] }, extracted: { promo_codes: [] } },
    embedding_model: "emb",
    embedding_dim: 3,
    attempts: 1,
    ...over,
  });
  return p;
}

const stage = () => new DedupStage({ taxonomy, thresholds });

test("first post is canonical of a new cluster; a near-identical one from another channel is suppressed", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const a = await enriched(srcA, { posted_at: t0, embedding: vec(1, 0, 0), text_en: "CS2 free case drop this weekend" });
  const b = await enriched(srcB, {
    posted_at: new Date(t0.getTime() + 3_600_000), embedding: vec(0.99, 0.05, 0), text_en: "CS2 free case drop on weekend",
  });

  assert.equal(await stage().runOnce(), 2);
  const A = await Post.findByPk(a.id);
  const B = await Post.findByPk(b.id);
  assert.equal(A.link_role, "canonical");
  assert.equal(A.dedup.decision, "new");
  assert.equal(B.cluster_id, A.cluster_id);
  assert.equal(B.link_role, "duplicate");
  assert.equal(B.status, "suppressed");
  assert.equal(B.dedup.tier, 2);
  assert.ok(B.dedup.s > 0.99);

  const c = await Cluster.findByPk(A.cluster_id);
  assert.equal(c.members_count, 2);
  assert.equal(c.canonical_post_id, a.id);
  assert.equal(c.embedding_model, "emb");
  assert.equal(new Date(c.last_seen_at).getTime(), t0.getTime() + 3_600_000);
  assert.equal(await stage().runOnce(), 0, "decided posts are not taken again");
});

test("tier 1 joins across topics on a verified promo code, even without embeddings", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const code = { extracted: { promo_codes: [{ code: "FREECASE26", verified: true }] }, entities: { tickers: [] } };
  const a = await enriched(srcA, { posted_at: t0, signal_type: "promo_code", analysis: code, embedding_model: null, embedding_dim: null });
  const b = await enriched(srcB, {
    posted_at: new Date(t0.getTime() + 60_000), signal_type: "promo_code", topic: "other",
    analysis: code, embedding_model: null, embedding_dim: null,
  });
  await stage().runOnce();
  const B = await Post.findByPk(b.id);
  assert.equal(B.cluster_id, (await Post.findByPk(a.id)).cluster_id);
  assert.equal(B.dedup.tier, 1);
  assert.equal(B.dedup.key, "code:FREECASE26");
});

test("an unverified (OCR) code does not collapse posts", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const code = { extracted: { promo_codes: [{ code: "OCRCODE1", verified: false, source: "ocr" }] }, entities: { tickers: [] } };
  const a = await enriched(srcA, { posted_at: t0, analysis: code, embedding_model: null });
  const b = await enriched(srcB, { posted_at: new Date(t0.getTime() + 60_000), analysis: code, embedding_model: null });
  await stage().runOnce();
  assert.notEqual((await Post.findByPk(a.id)).cluster_id, (await Post.findByPk(b.id)).cluster_id);
});

test("a boilerplate URL (channel signature) is not a tier-1 key", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const sig = { urls: ["https://t.me/+signature"], dates: [], amounts: [] };
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await enriched(srcA, {
      posted_at: new Date(t0.getTime() + i * 60_000), candidates: sig, embedding: vec(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0),
    })).id);
  }
  await stage().runOnce();
  const clusters = new Set((await Post.findAll({ where: { id: ids } })).map((p) => p.cluster_id));
  assert.equal(clusters.size, 3, "three different posts stay three events");
});

test("out of the signal window → a new cluster; the old one gets closed", async () => {
  const t0 = new Date("2026-09-30T00:00:00Z");
  const a = await enriched(srcA, { posted_at: t0, signal_type: "security", embedding: vec(1, 0, 0) });
  await stage().runOnce();
  const b = await enriched(srcB, { posted_at: new Date(t0.getTime() + 7 * 3_600_000), signal_type: "security", embedding: vec(1, 0, 0) });
  await stage().runOnce();
  const A = await Post.findByPk(a.id);
  const B = await Post.findByPk(b.id);
  assert.notEqual(A.cluster_id, B.cluster_id);
  assert.equal((await Cluster.findByPk(A.cluster_id)).closed, true);
});

test("gray zone is a new event, flagged, with the nearest post logged", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const a = await enriched(srcA, { posted_at: t0, embedding: vec(1, 0, 0) });
  const b = await enriched(srcB, { posted_at: new Date(t0.getTime() + 60_000), embedding: vec(0.8, 0.6, 0) }); // s = 0.8
  await stage().runOnce();
  const B = await Post.findByPk(b.id);
  assert.equal(B.link_role, "canonical");
  assert.equal(B.dedup.gray, true);
  assert.equal(B.dedup.nearest_post_id, a.id);
  assert.ok(Math.abs(B.dedup.s - 0.8) < 1e-4);
});

test("a much richer later post becomes canonical; the old one is demoted to linked", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const a = await enriched(srcA, { posted_at: t0, embedding: vec(1, 0, 0), text_en: "Drop soon" });
  const b = await enriched(srcB, {
    posted_at: new Date(t0.getTime() + 60_000), embedding: vec(1, 0.01, 0),
    text_en: "Drop starts Friday 18:00 UTC: free case for every player who logs in, limited to 100k claims",
  });
  await stage().runOnce();
  const A = await Post.findByPk(a.id);
  const B = await Post.findByPk(b.id);
  const c = await Cluster.findByPk(A.cluster_id);
  assert.equal(c.canonical_post_id, b.id);
  assert.equal(B.link_role, "canonical");
  assert.equal(A.link_role, "linked");
  assert.equal(B.dedup.replaced_canonical_post_id, a.id);
});

test("tier 2 ignores the same source by default (a template series is not a duplicate), but logs its s", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const a = await enriched(srcA, { posted_at: t0, embedding: vec(1, 0, 0), text_en: "Giving away 3x AK-47 Redline" });
  const b = await enriched(srcA, {
    posted_at: new Date(t0.getTime() + 86_400_000 / 2), embedding: vec(0.99, 0.1, 0), text_en: "Giving away 3x AWP Pit Viper",
  });
  await stage().runOnce();
  const B = await Post.findByPk(b.id);
  assert.notEqual(B.cluster_id, (await Post.findByPk(a.id)).cluster_id);
  assert.equal(B.dedup.decision, "new");
  assert.equal(B.dedup.s, null);
  assert.ok(B.dedup.s_same_source > 0.99);

  // Увімкнене явно — поводиться як раніше.
  await DedupStage.reset();
  await new DedupStage({ taxonomy, thresholds: { ...thresholds, tier2SameSource: true } }).runOnce();
  const B2 = await Post.findByPk(b.id);
  assert.equal(B2.cluster_id, (await Post.findByPk(a.id)).cluster_id);
});

test("reset returns every post to undecided and refuses once something is delivered", async () => {
  const t0 = new Date("2026-09-30T10:00:00Z");
  const a = await enriched(srcA, { posted_at: t0, embedding: vec(1, 0, 0) });
  const b = await enriched(srcB, { posted_at: new Date(t0.getTime() + 60_000), embedding: vec(1, 0, 0), text_en: "post" });
  await stage().runOnce();
  assert.equal((await Post.findByPk(b.id)).status, "suppressed");

  const r = await DedupStage.reset();
  assert.ok(r.clusters >= 1);
  for (const id of [a.id, b.id]) {
    const p = await Post.findByPk(id);
    assert.equal(p.status, "enriched");
    assert.equal(p.cluster_id, null);
    assert.equal(p.dedup, null);
  }

  await stage().runOnce();
  const c = await Cluster.findByPk((await Post.findByPk(a.id)).cluster_id);
  await c.update({ delivered: [{ platform: "telegram", channel_id: "x", message_id: 1 }] });
  await assert.rejects(() => DedupStage.reset(), /already delivered/);
});

test("§6.1: ingest skips a repost only within the same source", async () => {
  const ingest = new FlowIngest({ minTextLength: 5 });
  const text = `Same announcement text across channels ${XID}`;
  const msg = (id) => ({ channelId: "x", messageId: id, text, timestamp: Math.floor(Date.now() / 1000) });

  const first = await ingest.ingest({ source: srcA, messageData: { ...msg(1), channelId: srcA.channel_id }, text, blacklist: null });
  const sameSource = await ingest.ingest({ source: srcA, messageData: { ...msg(2), channelId: srcA.channel_id }, text, blacklist: null });
  const otherSource = await ingest.ingest({ source: srcB, messageData: { ...msg(3), channelId: srcB.channel_id }, text, blacklist: null });

  assert.equal(first.status, "pending");
  assert.equal(sameSource.status, "skipped_repost");
  assert.equal(otherSource.status, "pending", "cross-channel repost goes on to enrich and tier 1");
});

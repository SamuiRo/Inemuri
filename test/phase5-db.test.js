import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, PostFeedback, Cluster, KnowledgeExample } from "../src/module/teapot/models/index.js";
import { FewShotStore } from "../src/module/theflow/FewShot.js";
import { recordLabel, loadExamples } from "../src/module/theflow/knowledge/KnowledgeBase.js";
import { EnrichWorker } from "../src/module/theflow/EnrichWorker.js";
import { collectDigestRows, buildDigestMessage } from "../src/module/theflow/digest/Digest.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__p5_${process.pid}_`;
const taxonomy = { version: 1, topics: { steam: {}, other: {} }, signals: { event: {}, promo_code: {} } };
let src;
let seq = 0;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  src = await Source.create({
    platform: "telegram", channel_id: `${XID}src`, channel_name: "P5 Src", flow: { enabled: true, min_confidence: 0.6 },
  });
});
test.after(async () => {
  const ids = (await Post.findAll({ where: { source_id: src.id }, attributes: ["id", "cluster_id"] }));
  await KnowledgeExample.destroy({ where: { post_id: ids.map((p) => p.id) } });
  await PostFeedback.destroy({ where: { post_id: ids.map((p) => p.id) } });
  const cids = [...new Set(ids.map((p) => p.cluster_id).filter(Boolean))];
  await Post.destroy({ where: { source_id: src.id } });
  if (cids.length) await Cluster.destroy({ where: { id: cids } });
  await Source.destroy({ where: { id: src.id } });
  await database.disconnect();
});

async function post(over) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: src.id, platform: "telegram", external_id: String(880000 + seq), channel_id: "-1003333333333",
    raw_text: `raw ${seq}`, text_md: `raw ${seq}`, text_hash: `${XID}h${seq}`, attempts: 0, ...over,
  });
  return p;
}

test("a reviewed label reaches the enrich call as an example; the verdict records which set", async () => {
  const labelled = await post({ status: "enriched", text_en: `${XID} Free case drop Friday`, topic: "steam", signal_type: "event", confidence: 0.9 });
  const { example } = await recordLabel({ post: labelled, verdict: "good" });
  assert.ok((await loadExamples()).some((e) => e.uid === example.uid));

  const pending = await post({ status: "pending", candidates: {} });
  const seen = [];
  const gateway = {
    enrich: async (input) => {
      seen.push(input);
      return { value: { text_en: "x", lang: "en", topic: "steam", signal_type: "event", confidence: 0.9 }, model_used: "fake", discarded: [], unverified: [] };
    },
    embed: async () => null,
  };
  const store = new FewShotStore();
  const w = new EnrichWorker({ gateway, taxonomy, fewShot: store, batchSize: 50 });
  await w.runOnce();

  const input = seen.find((i) => i.text === pending.raw_text);
  assert.ok(input.examples.some((e) => e.ref === example.uid && e.kind === "good"));
  const { hash } = await store.get();
  assert.equal(input.examplesHash, hash);
  const P = await Post.findByPk(pending.id);
  assert.equal(P.analysis.fewshot, hash);
  assert.equal(P.analysis.prompt_version, 2);
});

test("digest rows carry cluster size, source and link; a message is built for the period", async () => {
  const cluster = await Cluster.create({ topic: "steam", signal_type: "promo_code", members_count: 3 });
  await post({ status: "enriched", link_role: "canonical", cluster_id: cluster.id, text_en: "Code drop", topic: "steam",
    signal_type: "promo_code", confidence: 0.95, posted_at: new Date(), analysis: { summary_uk: `${XID} код дня` } });
  const rows = await collectDigestRows({ since: new Date(Date.now() - 3_600_000), until: new Date(Date.now() + 1000) });
  const r = rows.find((x) => x.analysis?.summary_uk === `${XID} код дня`);
  assert.equal(r.members, 3);
  assert.equal(r.source, "P5 Src");
  assert.equal(r.min_confidence, 0.6);
  assert.match(r.link, /^https:\/\/t\.me\/c\/3333333333\/\d+$/);

  const m = await buildDigestMessage({ hours: 1, destinations: { telegram: ["-100digest"] }, topicOrder: ["steam"] });
  assert.ok(m.rawText.includes(`${XID} код дня ×3`));
  assert.deepEqual(m.source.destinations, { telegram: ["-100digest"] });
  assert.equal(await buildDigestMessage({ now: Date.parse("2000-01-01"), hours: 1 }), null, "an empty period sends nothing");
});

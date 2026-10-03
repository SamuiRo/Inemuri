import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, PostFeedback, KnowledgeExample } from "../src/module/teapot/models/index.js";
import {
  recordLabel, backfillFromFeedback, exportKnowledge, importKnowledge, loadExamples,
} from "../src/module/theflow/knowledge/KnowledgeBase.js";
import { serialize, parse } from "../src/module/theflow/knowledge/exchange.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__kb_${process.pid}_`;
let src;
let seq = 0;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  src = await Source.create({ platform: "telegram", channel_id: `${XID}src`, channel_name: "KB Src", flow: { enabled: true } });
});
test.after(async () => {
  const ids = (await Post.findAll({ where: { source_id: src.id }, attributes: ["id"] })).map((p) => p.id);
  await KnowledgeExample.destroy({ where: { source_name: "KB Src" } });
  await PostFeedback.destroy({ where: { post_id: ids } });
  await Post.destroy({ where: { source_id: src.id } });
  await Source.destroy({ where: { id: src.id } });
  await database.disconnect();
});

async function post(over = {}) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: src.id, platform: "telegram", external_id: String(770000 + seq), channel_id: "-1004444444444",
    raw_text: `${XID} raw ${seq}`, text_md: `raw ${seq}`, text_hash: `${XID}h${seq}`, attempts: 0,
    status: "enriched", text_en: `${XID} text ${seq}`, topic: "steam", signal_type: "event", taxonomy_version: 1, ...over,
  });
  return p;
}

const mine = (rows) => rows.filter((r) => r.source_name === "KB Src");

test("recordLabel writes the feedback row and its snapshot together", async () => {
  const p = await post();
  const { feedback, example } = await recordLabel({ post: p, verdict: "wrong_topic", note: "is other/opinion" });
  assert.equal(feedback.post_id, p.id);
  assert.equal(example.feedback_id, feedback.id);
  assert.equal(example.reason, "is other/opinion");
  assert.equal(example.source_name, "KB Src");
  assert.equal(example.topic, "steam");
  assert.equal(example.origin, "review");
});

test("the snapshot outlives a re-enrichment that changes the post's topic", async () => {
  const p = await post();
  const { example } = await recordLabel({ post: p, verdict: "good" });
  await p.update({ topic: "crypto" });
  const row = (await loadExamples()).find((e) => e.uid === example.uid);
  assert.equal(row.topic, "steam");
});

test("backfill copies only the labels not yet in the knowledge base, and is repeatable", async () => {
  const p = await post();
  const orphan = await PostFeedback.create({ post_id: null, verdict: "missed", note: "not caught" });
  const direct = await PostFeedback.create({ post_id: p.id, verdict: "noise" });

  const first = await backfillFromFeedback();
  assert.ok(first.created >= 1);
  const copied = await KnowledgeExample.findOne({ where: { feedback_id: direct.id } });
  assert.equal(copied.verdict, "noise");
  assert.equal(await KnowledgeExample.count({ where: { feedback_id: orphan.id } }), 0);

  const again = await backfillFromFeedback();
  assert.equal(again.created, 0);
  await orphan.destroy();
});

test("export → import on the same database changes nothing; a new uid is added", async () => {
  await recordLabel({ post: await post(), verdict: "good" });
  const exported = mine(await exportKnowledge());
  const { rows, errors } = parse(serialize(exported));
  assert.deepEqual(errors, []);

  const before = await KnowledgeExample.count();
  assert.deepEqual(await importKnowledge(rows), { created: 0, existing: rows.length });
  assert.equal(await KnowledgeExample.count(), before);

  const foreign = { ...rows[0], uid: "00000000-0000-4000-8000-000000000001" };
  assert.deepEqual(await importKnowledge([foreign, foreign], { dryRun: true }), { created: 1, existing: 1 });
  assert.equal(await KnowledgeExample.count(), before);

  assert.deepEqual(await importKnowledge([foreign]), { created: 1, existing: 0 });
  const imported = await KnowledgeExample.findOne({ where: { uid: foreign.uid } });
  assert.equal(imported.post_id, null);
  assert.equal(imported.feedback_id, null);
  assert.equal(imported.content_hash, rows[0].content_hash);
});

test("export filters by level and verdict", async () => {
  await recordLabel({ post: await post(), verdict: "noise" });
  const noise = mine(await exportKnowledge({ verdicts: ["noise"] }));
  assert.ok(noise.length >= 1);
  assert.ok(noise.every((r) => r.verdict === "noise"));
  assert.equal(mine(await exportKnowledge({ levels: ["headline"] })).length, 0);
});

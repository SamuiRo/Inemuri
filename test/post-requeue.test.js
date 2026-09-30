import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, PostFeedback, Source } from "../src/module/teapot/models/index.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__rq_${process.pid}_`;
let sourceId;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  const [source] = await Source.findOrCreate({
    where: { channel_id: `${XID}channel` },
    defaults: { platform: "telegram", channel_id: `${XID}channel`, channel_name: "requeue test source" },
  });
  sourceId = source.id;
});
test.after(async () => {
  const rows = await Post.findAll({ where: { source_id: sourceId }, attributes: ["id"] });
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await PostFeedback.destroy({ where: { post_id: ids } });
    await Post.destroy({ where: { id: ids } });
  }
  await Source.destroy({ where: { id: sourceId } });
  await database.disconnect();
});

let seq = 0;
async function make(over) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: sourceId,
    platform: "telegram",
    external_id: `${XID}${seq}`,
    channel_id: "-100test",
    raw_text: "text",
    text_md: "text",
    text_hash: `${XID}h${seq}`,
    status: "pending",
    attempts: 0,
    ...over,
  });
  return p;
}

test("requeue resets failed posts matching the error, keeps OCR, leaves the rest", async () => {
  const bad = await make({
    status: "failed", attempts: 4, last_error: "bad_response: HTTP 400 unknown name type",
    text_ocr: "CODE123", vision_used: true,
  });
  const other = await make({ status: "failed", attempts: 4, last_error: "server: provider down" });

  const dry = await Post.requeue({ errorLike: "HTTP 400", dryRun: true });
  assert.ok(dry.ids.includes(bad.id));
  assert.ok(!dry.ids.includes(other.id));
  assert.equal((await Post.findByPk(bad.id)).status, "failed", "dry run changes nothing");

  await Post.requeue({ errorLike: "HTTP 400" });
  const b = await Post.findByPk(bad.id);
  assert.equal(b.status, "pending");
  assert.equal(b.attempts, 0);
  assert.equal(b.last_error, null);
  assert.equal(b.text_ocr, "CODE123");
  assert.equal((await Post.findByPk(other.id)).status, "failed");
});

test("requeue by model clears the verdict and reports stale feedback", async () => {
  const fake = await make({
    status: "enriched", text_en: "Free code SAVE20", topic: "steam", signal_type: "promo_code",
    confidence: 0.88, model_used: `${XID}fake`, taxonomy_version: 1,
    embedding: Buffer.alloc(8), embedding_model: "emb", embedding_dim: 2,
  });
  const real = await make({ status: "enriched", text_en: "x", topic: "steam", signal_type: "launch",
    confidence: 0.9, model_used: `${XID}real` });
  await PostFeedback.create({ post_id: fake.id, verdict: "wrong_topic" });

  const res = await Post.requeue({ status: ["enriched"], modelUsed: `${XID}fake` });
  assert.deepEqual(res.ids, [fake.id]);
  assert.equal(res.withFeedback, 1);

  const f = await Post.findByPk(fake.id);
  assert.equal(f.status, "pending");
  for (const k of ["text_en", "topic", "signal_type", "confidence", "model_used", "embedding", "embedding_model"]) {
    assert.equal(f[k], null, k);
  }
  assert.equal((await Post.findByPk(real.id)).status, "enriched");
});

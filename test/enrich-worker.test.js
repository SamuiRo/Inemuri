import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source } from "../src/module/teapot/models/index.js";
import { EnrichWorker } from "../src/module/theflow/EnrichWorker.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Рядки однаково мітяться pid і прибираються після.
const XID = `__ew_${process.pid}_`;

const taxonomy = {
  version: 3,
  topics: { steam: {}, other: {} },
  signals: { promo_code: {}, launch: {} },
};

const GOOD = {
  value: {
    text_en: "Free code SAVE20",
    lang: "en",
    summary_uk: null,
    topic: "steam",
    signal_type: "promo_code",
    confidence: 0.88,
    entities: { project: "G", tickers: [] },
    extracted: { promo_codes: [{ code: "SAVE20" }], event: null },
    why_interesting: "x",
    is_ad: false,
  },
  model_used: "fake-model",
  discarded: [],
};

let sourceId;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  // Створюємо власне джерело, а не беремо перше-ліпше з бази: інакше набір
  // залежить від даних, яких сам не створював, і на чистій базі (CI, свіжа
  // установка) `Source.findOne()` повертає null.
  const [source] = await Source.findOrCreate({
    where: { channel_id: `${XID}channel` },
    defaults: {
      platform: "telegram",
      channel_id: `${XID}channel`,
      channel_name: "enrich-worker test source",
    },
  });
  sourceId = source.id;
});
test.after(async () => {
  const rows = await Post.findAll({ attributes: ["id", "external_id"] });
  const ids = rows.filter((r) => String(r.external_id).startsWith(XID)).map((r) => r.id);
  if (ids.length) await Post.destroy({ where: { id: ids } });
  await Source.destroy({ where: { channel_id: `${XID}channel` } });
  await database.disconnect();
});

async function seed(n, over = {}) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const [p] = await Post.ingest({
      source_id: sourceId,
      platform: "telegram",
      external_id: `${XID}${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`,
      channel_id: "-100test",
      message_id: 800000 + i,
      raw_text: "Use code SAVE20 today",
      text_md: "x",
      text_hash: `h${Math.random()}`,
      candidates: { promo_codes: ["SAVE20"], tickers: [], urls: [], dates: [], amounts: [] },
      status: "pending",
      attempts: 0,
      ...over,
    });
    made.push(p);
  }
  return made;
}

function fakeGateway(over = {}) {
  return {
    enrich: over.enrich ?? (async () => ({ ...GOOD })),
    embed: over.embed ?? (async () => ({ vector: Float32Array.from([0.6, 0.8]), model: "emb", dim: 2 })),
  };
}

test("runOnce — pending posts become enriched with the full verdict", async () => {
  const [p] = await seed(1);
  const w = new EnrichWorker({ gateway: fakeGateway(), taxonomy, batchSize: 10 });

  const advanced = await w.runOnce();
  assert.ok(advanced >= 1);

  await p.reload();
  assert.equal(p.status, "enriched");
  assert.equal(p.topic, "steam");
  assert.equal(p.signal_type, "promo_code");
  assert.equal(p.confidence, 0.88);
  assert.equal(p.model_used, "fake-model");
  assert.equal(p.taxonomy_version, 3);
  assert.equal(p.text_en, "Free code SAVE20");
  assert.equal(p.attempts, 1); // incremented at claim time
  assert.ok(Buffer.isBuffer(p.embedding));
  assert.equal(p.embedding_model, "emb");
  assert.equal(p.embedding_dim, 2);
  assert.equal(p.embedding.length, 2 * 4);
  assert.equal(p.analysis.discarded.length, 0);
  assert.equal(p.last_error, null);
});

test("embed unavailable — still enriched, embedding null", async () => {
  const [p] = await seed(1);
  const w = new EnrichWorker({
    gateway: fakeGateway({ embed: async () => null }),
    taxonomy,
  });
  await w.runOnce();
  await p.reload();
  assert.equal(p.status, "enriched");
  assert.equal(p.embedding, null);
  assert.equal(p.embedding_model, null);
});

test("shed — post left pending, no error recorded", async () => {
  const [p] = await seed(1);
  const w = new EnrichWorker({
    gateway: fakeGateway({ enrich: async () => ({ shed: true }) }),
    taxonomy,
  });
  const advanced = await w.runOnce();
  assert.equal(advanced, 0);
  await p.reload();
  assert.equal(p.status, "pending");
  assert.equal(p.last_error, null);
  // Shed — навмисне відкладання, не збій і не виклик. Спробу, яку забрав
  // claimPending, треба повернути. Попередня версія цього тесту стверджувала
  // attempts === 1, тобто закріплювала ваду як очікувану поведінку.
  assert.equal(p.attempts, 0);
});

test("shed never burns the retry budget: a shed post still gets all its real retries", async () => {
  // Регресія. Раніше кожен shed лишав attempts+1, тож після кількох shed
  // перша ж справжня мережева помилка одразу робила пост failed — без жодного
  // реального повтору. Vision скидається першим під тиском квоти, тож у
  // тісний день скріншот-пости вичерпували спроби за хвилину.
  const [p] = await seed(1);
  const shedding = new EnrichWorker({
    gateway: fakeGateway({ enrich: async () => ({ shed: true }) }),
    taxonomy,
    maxAttempts: 3,
  });
  for (let i = 0; i < 5; i++) await shedding.runOnce();

  const failing = new EnrichWorker({
    gateway: fakeGateway({ enrich: async () => { throw Object.assign(new Error("blip"), { kind: "network" }); } }),
    taxonomy,
    maxAttempts: 3,
  });
  await failing.runOnce();
  await p.reload();
  assert.equal(p.status, "pending", "перша справжня помилка — ще повтор, не failed");
  assert.equal(p.attempts, 1);
});

test("gateway error — retried until attempts exhausted, then failed", async () => {
  const [p] = await seed(1);
  const boom = async () => { const e = new Error("provider down"); e.kind = "server"; throw e; };
  const w = new EnrichWorker({ gateway: fakeGateway({ enrich: boom }), taxonomy, maxAttempts: 2 });

  await w.runOnce();
  await p.reload();
  assert.equal(p.status, "pending"); // attempts now 1
  assert.match(p.last_error, /server: provider down/);

  await w.runOnce();
  await p.reload();
  assert.equal(p.status, "failed"); // attempts now 2 >= maxAttempts
});

test("claimPending — increments attempts and returns the rows once", async () => {
  await seed(2);
  const first = await Post.claimPending(50);
  const mine = first.filter((r) => String(r.external_id).startsWith(XID));
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((r) => r.attempts >= 1));
});

// ── стадія 1.5 у воркері ──────────────────────────────────────────────

const FLOW_ON = { enabled: true, vision: { enabled: true, text_threshold: 200, max_images_per_post: 2 } };

test("vision — a transcription reaches enrich() as textOcr", async () => {
  const [p] = await seed(1);
  let seenOcr = null;
  const w = new EnrichWorker({
    gateway: fakeGateway({ enrich: async (input) => { seenOcr = input.textOcr; return { ...GOOD }; } }),
    taxonomy,
    // Справжня стадія пише text_ocr у пост — фейк робить те саме.
    vision: { run: async (post) => { await post.update({ text_ocr: "PROMO HY45OLK8QRE2" }); return { status: "done" }; } },
    flowFor: async () => FLOW_ON,
  });
  await w.runOnce();
  assert.equal(seenOcr, "PROMO HY45OLK8QRE2");
  await p.reload();
  assert.equal(p.status, "enriched");
});

test("vision shed — enrich is NOT called and the claim is released", async () => {
  // Збагачення без OCR дало б упевнений вердикт на порожньому тексті.
  const [p] = await seed(1);
  let enrichCalls = 0;
  const w = new EnrichWorker({
    gateway: fakeGateway({ enrich: async () => { enrichCalls += 1; return { ...GOOD }; } }),
    taxonomy,
    vision: { run: async () => ({ status: "shed" }) },
    flowFor: async () => FLOW_ON,
  });
  assert.equal(await w.runOnce(), 0);
  assert.equal(enrichCalls, 0);
  await p.reload();
  assert.equal(p.status, "pending");
  assert.equal(p.attempts, 0, "shed не з'їдає спробу");
});

test("vision skipped or unavailable — enrichment proceeds as usual", async () => {
  for (const status of ["skipped", "unavailable"]) {
    const [p] = await seed(1);
    const w = new EnrichWorker({
      gateway: fakeGateway(),
      taxonomy,
      vision: { run: async () => ({ status }) },
      flowFor: async () => FLOW_ON,
    });
    await w.runOnce();
    await p.reload();
    assert.equal(p.status, "enriched", status);
  }
});

test("vision error — counts as an attempt, like any gateway error", async () => {
  const [p] = await seed(1);
  const w = new EnrichWorker({
    gateway: fakeGateway(),
    taxonomy,
    maxAttempts: 3,
    vision: { run: async () => { throw Object.assign(new Error("vision down"), { kind: "server" }); } },
    flowFor: async () => FLOW_ON,
  });
  await w.runOnce();
  await p.reload();
  assert.equal(p.status, "pending");
  assert.equal(p.attempts, 1);
  assert.match(p.last_error, /vision down/);
});

test("vision without flowFor is a construction error, not a silent no-op", () => {
  assert.throws(
    () => new EnrichWorker({ gateway: fakeGateway(), taxonomy, vision: { run: async () => ({}) } }),
    /flowFor/,
  );
});

test("no vision stage — the worker behaves exactly as before", async () => {
  const [p] = await seed(1);
  await new EnrichWorker({ gateway: fakeGateway(), taxonomy }).runOnce();
  await p.reload();
  assert.equal(p.status, "enriched");
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  VisionStage, visionGate, VISION_SKIP as SKIP, isVisionImage, VISION_MAX_DOCUMENT_BYTES,
} from "../src/module/theflow/VisionStage.js";

const FLOW = { enabled: true, vision: { enabled: true, text_threshold: 200, max_images_per_post: 2 } };

// ── ворота ────────────────────────────────────────────────────────────

const basePost = (over = {}) => ({ id: 1, has_media: true, raw_text: "", text_ocr: null, ...over });

test("gate — runs for a short-text post with media on a vision source", () => {
  assert.deepEqual(visionGate({ post: basePost(), flow: FLOW }), { run: true, reason: null });
});

test("gate — never re-transcribes: text_ocr set means done, even when empty", () => {
  // "" — пробували, тексту нема. Без цього пост без тексту на знімку
  // перетранскрибовувався б на кожній спробі.
  assert.equal(visionGate({ post: basePost({ text_ocr: "" }), flow: FLOW }).reason, SKIP.ALREADY_TRANSCRIBED);
  assert.equal(visionGate({ post: basePost({ text_ocr: "x" }), flow: FLOW }).reason, SKIP.ALREADY_TRANSCRIBED);
});

test("gate — off unless both flow and vision are enabled on the source", () => {
  for (const flow of [
    { ...FLOW, enabled: false },
    { ...FLOW, vision: { ...FLOW.vision, enabled: false } },
    { enabled: true },
    undefined,
  ]) {
    assert.equal(visionGate({ post: basePost(), flow }).reason, SKIP.SOURCE_DISABLED, JSON.stringify(flow));
  }
});

test("gate — no media, nothing to transcribe", () => {
  assert.equal(visionGate({ post: basePost({ has_media: false }), flow: FLOW }).reason, SKIP.NO_MEDIA);
});

test("gate — substantial text means the image is decorative", () => {
  const long = "x".repeat(201);
  assert.equal(visionGate({ post: basePost({ raw_text: long }), flow: FLOW }).reason, SKIP.TEXT_LONG_ENOUGH);
  assert.equal(visionGate({ post: basePost({ raw_text: "x".repeat(200) }), flow: FLOW }).run, true, "рівно поріг — ще запускаємо");
});

// ── стадія ────────────────────────────────────────────────────────────

/** Фейковий пост: запам'ятовує update(). */
function mkPost(over = {}) {
  const post = basePost(over);
  post.updates = [];
  post.update = async (fields) => { post.updates.push(fields); Object.assign(post, fields); };
  return post;
}

/** Фейкові залежності з лічильниками. */
function mkDeps({ files = ["img-a"], hashes = {}, cached = {}, vision } = {}) {
  const calls = { resolve: [], vision: 0, store: [] };
  const resolver = {
    resolve: async (post, opts) => { calls.resolve.push(opts); return files.map((name) => ({ buffer: Buffer.from(name) })); },
  };
  const image = {
    downscaleForVision: async (buf) => {
      if (String(buf) === "broken") throw new Error("Input buffer contains unsupported image format");
      return { data: buf, mimeType: "image/jpeg" };
    },
    dhash: async (buf) => hashes[String(buf)] ?? `hash-${String(buf)}`,
  };
  const cache = {
    nearest: async (hash) => (cached[hash] ? { row: { text_ocr: cached[hash] }, distance: 3 } : null),
    store: async (hash, res) => { calls.store.push([hash, res.text_ocr]); },
  };
  const gateway = {
    vision: vision ?? (async () => { calls.vision += 1; return { text_ocr: `ocr#${calls.vision}`, description: "d", legible: true, model: "vm" }; }),
  };
  return { calls, stage: new VisionStage({ gateway, resolver, cache, image }) };
}

test("run — skipped by the gate does nothing at all", async () => {
  const { stage, calls } = mkDeps();
  const post = mkPost({ has_media: false });
  const r = await stage.run(post, FLOW);
  assert.deepEqual(r, { status: "skipped", reason: SKIP.NO_MEDIA });
  assert.equal(calls.resolve.length, 0, "без завантаження");
  assert.equal(post.updates.length, 0);
});

test("run — asks the resolver for images only, capped by max_images_per_post", async () => {
  // Vision потрібні лише зображення; відео не має завантажуватись взагалі.
  const { stage, calls } = mkDeps();
  await stage.run(mkPost(), FLOW);
  const opts = calls.resolve[0];
  assert.deepEqual(opts.types, ["photo", "document"]);
  assert.equal(opts.limit, 2);
  assert.equal(opts.accept, isVisionImage, "документи — лише через фільтр зображень");
});

// ── isVisionImage: що вважаємо скріншотом, до завантаження ───────────

test("isVisionImage — photos always", () => {
  assert.equal(isVisionImage({ type: "photo" }), true);
});

test("isVisionImage — a screenshot sent as a file is picked up", () => {
  // Файлом шлють, щоб Telegram не стискав якість — на каналах промокодів
  // саме так, бо кожен символ коду важливий.
  for (const mimeType of ["image/png", "image/jpeg", "image/webp", "IMAGE/PNG"]) {
    assert.equal(isVisionImage({ type: "document", mimeType, fileSize: 2_000_000 }), true, mimeType);
  }
});

test("isVisionImage — SVG, HEIC and GIF documents are refused", () => {
  // SVG рендериться через librsvg — векторний файл із відкритого каналу є
  // зайвою поверхнею атаки; HEIC зібраний sharp не декодує; GIF — анімація.
  for (const mimeType of ["image/svg+xml", "image/heic", "image/gif", "application/pdf", "", undefined]) {
    assert.equal(isVisionImage({ type: "document", mimeType, fileSize: 1000 }), false, String(mimeType));
  }
});

test("isVisionImage — an oversized document is refused before download", () => {
  const big = VISION_MAX_DOCUMENT_BYTES + 1;
  assert.equal(isVisionImage({ type: "document", mimeType: "image/png", fileSize: big }), false);
  assert.equal(isVisionImage({ type: "document", mimeType: "image/png", fileSize: VISION_MAX_DOCUMENT_BYTES }), true);
});

test("isVisionImage — GramJS BigInt sizes are handled", () => {
  // long-поля GramJS — BigInt-подібні; порівняння без приведення тихо хибило б.
  assert.equal(isVisionImage({ type: "document", mimeType: "image/png", fileSize: 1_000_000n }), true);
  assert.equal(
    isVisionImage({ type: "document", mimeType: "image/png", fileSize: BigInt(VISION_MAX_DOCUMENT_BYTES) + 1n }),
    false,
  );
});

test("isVisionImage — a document with no size is allowed (the pixel limit still guards decode)", () => {
  assert.equal(isVisionImage({ type: "document", mimeType: "image/png" }), true);
});

test("isVisionImage — videos, animations and audio are never images", () => {
  for (const type of ["video", "video_note", "animation", "audio", "webpage", undefined]) {
    assert.equal(isVisionImage({ type, mimeType: "image/png" }), false, String(type));
  }
});

test("run — transcribes, caches, and persists text_ocr BEFORE returning", async () => {
  const { stage, calls } = mkDeps({ files: ["img-a"] });
  const post = mkPost();
  const r = await stage.run(post, FLOW);

  assert.equal(r.status, "done");
  assert.equal(r.text_ocr, "ocr#1");
  assert.equal(calls.vision, 1);
  assert.deepEqual(calls.store, [["hash-img-a", "ocr#1"]]);
  assert.deepEqual(post.updates, [{ text_ocr: "ocr#1", vision_used: true, image_hash: "hash-img-a" }]);
});

test("run — a cache hit costs no vision call (the repost case)", async () => {
  const { stage, calls } = mkDeps({ files: ["img-a"], cached: { "hash-img-a": "from cache" } });
  const post = mkPost();
  const r = await stage.run(post, FLOW);
  assert.equal(calls.vision, 0);
  assert.equal(r.cacheHits, 1);
  assert.equal(r.text_ocr, "from cache");
  assert.equal(post.updates[0].vision_used, false, "виклику не було — квота не витрачалась");
});

test("run — an album joins transcriptions, and image_hash is the first image's", async () => {
  const { stage } = mkDeps({ files: ["img-a", "img-b"] });
  const post = mkPost();
  const r = await stage.run(post, FLOW);
  assert.equal(r.text_ocr, "ocr#1\n\nocr#2");
  assert.equal(post.updates[0].image_hash, "hash-img-a");
});

test("run — shed leaves the post untouched so enrichment does not run without OCR", async () => {
  // Збагачувати скріншот-пост на порожньому тексті означало б упевнений
  // вердикт на сміттєвому вході, і OCR до нього більше ніколи не дійшов би.
  const { stage } = mkDeps({ vision: async () => ({ shed: true, reason: "quota reserve" }) });
  const post = mkPost();
  assert.deepEqual(await stage.run(post, FLOW), { status: "shed" });
  assert.equal(post.updates.length, 0, "text_ocr лишається NULL — наступна спроба запустить vision знову");
});

test("run — shed midway: images already paid for are in the cache for the retry", async () => {
  let n = 0;
  const { stage, calls } = mkDeps({
    files: ["img-a", "img-b"],
    vision: async () => (++n === 1 ? { text_ocr: "paid", description: "d", legible: true, model: "vm" } : { shed: true }),
  });
  assert.equal((await stage.run(mkPost(), FLOW)).status, "shed");
  assert.deepEqual(calls.store, [["hash-img-a", "paid"]], "перше зображення збережено до shed");
});

test("run — no vision provider: 'unavailable', and text_ocr is not marked done", async () => {
  // Якщо оператор згодом додасть провайдера, ці пости ще можуть отримати OCR.
  const { stage } = mkDeps({ vision: async () => null });
  const post = mkPost();
  assert.deepEqual(await stage.run(post, FLOW), { status: "unavailable" });
  assert.equal(post.updates.length, 0);
});

test("run — no photos resolved (deleted message, video-only post): done with empty text", async () => {
  // "" — позначка «пробували»: без неї пост без фото перевіряли б щоразу.
  const { stage, calls } = mkDeps({ files: [] });
  const post = mkPost();
  const r = await stage.run(post, FLOW);
  assert.equal(r.status, "done");
  assert.equal(calls.vision, 0);
  assert.deepEqual(post.updates, [{ text_ocr: "", vision_used: false, image_hash: null }]);
});

test("run — one broken image does not block the rest", async () => {
  const { stage, calls } = mkDeps({ files: ["broken", "img-b"] });
  const r = await stage.run(mkPost(), FLOW);
  assert.equal(r.failedImages, 1);
  assert.equal(calls.vision, 1);
  assert.equal(r.text_ocr, "ocr#1");
});

test("run — a gateway error propagates so the worker counts the attempt", async () => {
  const { stage } = mkDeps({ vision: async () => { throw Object.assign(new Error("down"), { kind: "server" }); } });
  const post = mkPost();
  await assert.rejects(stage.run(post, FLOW), /down/);
  assert.equal(post.updates.length, 0, "нічого не записано — наступна спроба повторить");
});

test("run — illegible transcriptions are dropped from the joined text", async () => {
  let n = 0;
  const { stage } = mkDeps({
    files: ["img-a", "img-b"],
    vision: async () => (++n === 1
      ? { text_ocr: "", description: "blurry", legible: false, model: "vm" }
      : { text_ocr: "readable", description: "d", legible: true, model: "vm" }),
  });
  assert.equal((await stage.run(mkPost(), FLOW)).text_ocr, "readable");
});

import test from "node:test";
import assert from "node:assert/strict";

import { MediaResolver } from "../src/module/theflow/media/MediaResolver.js";
import { TelegramMediaResolver } from "../src/sources/telegram/TelegramMediaResolver.js";

test("MediaResolver — dispatches by media_ref.kind", async () => {
  const r = new MediaResolver();
  r.register("telegram", { resolve: async () => [{ type: "photo", buffer: Buffer.from("a") }] });
  assert.deepEqual(r.kinds, ["telegram"]);

  const out = await r.resolve({ media_ref: { kind: "telegram" } });
  assert.equal(out.length, 1);
});

test("MediaResolver — no media_ref => []", async () => {
  const r = new MediaResolver();
  assert.deepEqual(await r.resolve({ media_ref: null }), []);
  assert.deepEqual(await r.resolve({}), []);
});

test("MediaResolver — unknown kind throws", async () => {
  const r = new MediaResolver();
  await assert.rejects(() => r.resolve({ media_ref: { kind: "ipfs" } }), /No media resolver/);
});

test("MediaResolver — register rejects a resolver without resolve()", () => {
  const r = new MediaResolver();
  assert.throws(() => r.register("x", {}), /resolve\(\) method/);
});

test("TelegramMediaResolver — single message: fetches one id, maps records", async () => {
  const calls = [];
  const tg = new TelegramMediaResolver({
    client: { getMessages: async (ch, opts) => { calls.push([ch, opts]); return [{ id: 7, media: { photo: {} } }]; } },
    downloader: { download: async () => [{ type: "photo", data: Buffer.from("img"), filename: "a.jpg", mimeType: "image/jpeg" }] },
    parser: { parseMedia: (m) => ({ type: "photo", raw: m.media }) },
  });

  const out = await tg.resolve({ id: 1, media_ref: { kind: "telegram", channel_id: "-100x", message_id: 7, grouped_id: null } });
  assert.deepEqual(calls[0], ["-100x", { ids: [7] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].buffer.toString(), "img");
  assert.equal(out[0].type, "photo");
  assert.equal(out[0].filename, "a.jpg");
});

test("TelegramMediaResolver — album: 10-wide window, filtered by grouped_id, nulls dropped", async () => {
  const album = [
    { id: 10, media: { photo: {} }, groupedId: { toString: () => "G1" } },
    { id: 11, media: { photo: {} }, groupedId: { toString: () => "G1" } },
    { id: 12, media: { photo: {} }, groupedId: { toString: () => "G2" } }, // neighbour album
    null,
  ];
  let seenIds;
  const tg = new TelegramMediaResolver({
    client: { getMessages: async (_ch, opts) => { seenIds = opts.ids; return album; } },
    downloader: { download: async (md) => md.media.map((_, i) => ({ type: "photo", data: Buffer.from("x" + i) })) },
    parser: { parseMedia: (m) => ({ type: "photo", raw: m.media }) },
  });

  const out = await tg.resolve({ id: 2, media_ref: { kind: "telegram", channel_id: "-100x", message_id: 10, grouped_id: "G1" } });
  assert.equal(seenIds.length, 10);
  assert.equal(seenIds[0], 10);
  assert.equal(out.length, 2); // G2 neighbour and null dropped
});

test("TelegramMediaResolver — unusable media_ref => []", async () => {
  const tg = new TelegramMediaResolver({ client: {}, downloader: {}, parser: {} });
  assert.deepEqual(await tg.resolve({ id: 3, media_ref: null }), []);
  assert.deepEqual(await tg.resolve({ id: 4, media_ref: { kind: "url", urls: [] } }), []);
});

// ── лише потрібне, до завантаження (vision) ──────────────────────────

function mixedAlbum() {
  // Альбом: відео, два фото, документ, ще фото — усе з одним grouped_id.
  const kinds = ["video", "photo", "document", "photo", "photo"];
  const messages = kinds.map((kind, i) => ({ id: 100 + i, groupedId: "g1", media: { kind } }));
  const downloaded = [];
  const typesSeen = [];
  const tg = new TelegramMediaResolver({
    client: { getMessages: async () => messages },
    downloader: {
      download: async (md, types) => {
        typesSeen.push(types);
        const list = Array.isArray(md.media) ? md.media : [md.media];
        downloaded.push(...list.map((m) => m.type));
        return list.map((m) => ({ type: m.type, data: Buffer.from(m.type) }));
      },
    },
    parser: { parseMedia: (m) => ({ type: m.media.kind, raw: m.media }) },
  });
  const post = { id: 1, media_ref: { kind: "telegram", channel_id: "-100", message_id: 100, grouped_id: "g1" } };
  return { tg, post, downloaded, typesSeen };
}

test("TelegramMediaResolver — `types` filters BEFORE download: a video is never fetched", async () => {
  // Специфікація: пост, відсіяний дедуплікацією, ніколи не має тягнути відео.
  // Vision потрібні лише зображення — ролик до 25+ МБ не завантажується зовсім.
  const { tg, post, downloaded } = mixedAlbum();
  const files = await tg.resolve(post, { types: ["photo"] });
  assert.deepEqual(downloaded, ["photo", "photo", "photo"], "завантажено лише фото");
  assert.equal(files.every((f) => f.type === "photo"), true);
});

test("TelegramMediaResolver — `limit` caps the download, not just the result", async () => {
  // Альбомна стеля (vision.max_images_per_post): 10 скріншотів ≠ 10 завантажень.
  const { tg, post, downloaded } = mixedAlbum();
  const files = await tg.resolve(post, { types: ["photo"], limit: 2 });
  assert.equal(files.length, 2);
  assert.equal(downloaded.length, 2, "качаємо рівно стільки, скільки треба");
});

test("TelegramMediaResolver — the type filter reaches the downloader too", async () => {
  // Інакше глобальний список завантажувача тихо відкидав би запитаний тип.
  const { tg, post, typesSeen } = mixedAlbum();
  await tg.resolve(post, { types: ["photo"] });
  assert.deepEqual(typesSeen, [["photo"]]);
});

test("TelegramMediaResolver — no requested kind present → [] without downloading", async () => {
  const { tg, post, downloaded } = mixedAlbum();
  assert.deepEqual(await tg.resolve(post, { types: ["audio"] }), []);
  assert.deepEqual(downloaded, []);
});

test("TelegramMediaResolver — without options the behaviour is unchanged", async () => {
  const { tg, post, downloaded } = mixedAlbum();
  await tg.resolve(post);
  assert.equal(downloaded.length, 5, "доставці потрібне все, як і раніше");
});

test("TelegramMediaResolver — `accept` filters by pre-download metadata", async () => {
  // Документ-зображення проходить, документ-PDF — ні, і PDF не завантажується.
  const messages = [
    { id: 200, groupedId: "g2", media: { kind: "document", mime: "image/png" } },
    { id: 201, groupedId: "g2", media: { kind: "document", mime: "application/pdf" } },
    { id: 202, groupedId: "g2", media: { kind: "photo", mime: "image/jpeg" } },
  ];
  const downloaded = [];
  const typesSeen = [];
  const tg = new TelegramMediaResolver({
    client: { getMessages: async () => messages },
    downloader: {
      download: async (md, types) => {
        typesSeen.push(types);
        const list = Array.isArray(md.media) ? md.media : [md.media];
        downloaded.push(...list.map((m) => m.mimeType));
        return list.map((m) => ({ type: m.type, data: Buffer.from("x"), mimeType: m.mimeType }));
      },
    },
    parser: { parseMedia: (m) => ({ type: m.media.kind, mimeType: m.media.mime, raw: m.media }) },
  });
  const post = { id: 2, media_ref: { kind: "telegram", channel_id: "-100", message_id: 200, grouped_id: "g2" } };

  const files = await tg.resolve(post, {
    types: ["photo", "document"],
    accept: (m) => m.type === "photo" || m.mimeType?.startsWith("image/"),
  });

  assert.deepEqual(downloaded.sort(), ["image/jpeg", "image/png"], "PDF не завантажувався");
  assert.equal(files.length, 2);
  assert.deepEqual([...typesSeen[0]].sort(), ["document", "photo"], "типи завантажувача — з того, що лишилось");
});

import test from "node:test";
import assert from "node:assert/strict";

import { MediaResolver } from "../src/module/theflow/media/MediaResolver.js";
import { TelegramMediaResolver } from "../src/module/theflow/media/TelegramMediaResolver.js";

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

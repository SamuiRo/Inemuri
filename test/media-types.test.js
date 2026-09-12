import test from "node:test";
import assert from "node:assert/strict";

import { DOWNLOADABLE_MEDIA_TYPES } from "../src/config/app.config.js";
import { Source } from "../src/module/teapot/models/index.js";
import TelegramMediaDownloader from "../src/sources/telegram/TelegramMediaDownloader.js";

const GLOBAL = DOWNLOADABLE_MEDIA_TYPES;

const build = (extra) => Source.build({
  platform: "telegram", channel_id: "-1", channel_name: "x", extra_media_types: extra,
});

// ── Source.getDownloadableMediaTypes ──────────────────────────────────

test("getDownloadableMediaTypes — NULL means the global list only", () => {
  assert.deepEqual(build(null).getDownloadableMediaTypes(GLOBAL), GLOBAL);
});

test("getDownloadableMediaTypes — extra types are added, never substituted", () => {
  // Додавальне навмисно: повний список легко задати без "photo" і тихо
  // втратити всі зображення джерела.
  const types = build(["audio"]).getDownloadableMediaTypes(GLOBAL);
  for (const t of GLOBAL) assert.ok(types.includes(t), `${t} має лишитись`);
  assert.ok(types.includes("audio"));
});

test("getDownloadableMediaTypes — no duplicates when extra repeats a global type", () => {
  const types = build(["photo", "audio", "audio"]).getDownloadableMediaTypes(GLOBAL);
  assert.equal(new Set(types).size, types.length);
});

test("getDownloadableMediaTypes — survives a JSON column handed back as a string", () => {
  // Той самий захист, що в getFlowConfig: якщо колонка потрапила як TEXT,
  // Sequelize віддає сирий рядок.
  const s = build(null);
  s.extra_media_types = '["audio"]';
  assert.ok(s.getDownloadableMediaTypes(GLOBAL).includes("audio"));
});

test("getDownloadableMediaTypes — garbage falls back to the global list", () => {
  for (const bad of ["not json", "{}", 42, [], [""], [null]]) {
    const s = build(null);
    s.extra_media_types = bad;
    assert.deepEqual(
      s.getDownloadableMediaTypes(GLOBAL), GLOBAL, `extra=${JSON.stringify(bad)}`,
    );
  }
});

test("video_note stays out of the global list", () => {
  // Свідоме рішення: кружечки не пересилаємо. Джерело може додати їх явно,
  // але за замовчуванням їх немає.
  assert.equal(GLOBAL.includes("video_note"), false);
  assert.equal(GLOBAL.includes("audio"), false, "audio теж лише per-source");
});

// ── downloader honours the per-call list ──────────────────────────────

function fakeDownloader() {
  const downloaded = [];
  const d = new TelegramMediaDownloader({
    downloadMedia: async () => Buffer.from("x"),
  });
  const orig = d._buildFileRecord.bind(d);
  d._buildFileRecord = (media, buf) => { downloaded.push(media.type); return orig(media, buf); };
  return { d, downloaded };
}

const msg = (types) => ({
  messageId: 1,
  media: types.map((t) => ({ type: t, raw: {} })),
});

test("download — without an override, only global types are fetched", async () => {
  const { d, downloaded } = fakeDownloader();
  await d.download(msg(["photo", "audio"]));
  assert.deepEqual(downloaded, ["photo"], "audio не входить у глобальний список");
});

test("download — an override list lets a source keep audio", async () => {
  const { d, downloaded } = fakeDownloader();
  await d.download(msg(["photo", "audio"]), [...GLOBAL, "audio"]);
  assert.deepEqual(downloaded.sort(), ["audio", "photo"]);
});

test("download — an empty or non-array override falls back to the global list", async () => {
  for (const override of [[], null, undefined, "audio"]) {
    const { d, downloaded } = fakeDownloader();
    await d.download(msg(["photo", "audio"]), override);
    assert.deepEqual(downloaded, ["photo"], `override=${JSON.stringify(override)}`);
  }
});

test("download — a single (non-album) media respects the override too", async () => {
  const { d, downloaded } = fakeDownloader();
  await d.download({ messageId: 2, media: { type: "audio", raw: {} } }, [...GLOBAL, "audio"]);
  assert.deepEqual(downloaded, ["audio"]);

  const second = fakeDownloader();
  const res = await second.d.download({ messageId: 3, media: { type: "audio", raw: {} } });
  assert.equal(res, null, "без override audio відсіюється");
  assert.deepEqual(second.downloaded, []);
});

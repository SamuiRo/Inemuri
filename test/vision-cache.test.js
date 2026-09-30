import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { VisionCache } from "../src/module/teapot/models/index.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Рядки мітяться унікальним model і прибираються.
const MODEL = `__vc_${process.pid}`;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
});
test.after(async () => {
  await VisionCache.destroy({ where: { model: MODEL } });
  await database.disconnect();
});

const store = (hash, over = {}) =>
  VisionCache.store(hash, { text_ocr: `ocr-${hash}`, description: "d", legible: true, model: MODEL, ...over });

// Хеші, що відрізняються на відому кількість біт.
const BASE = "0f0f0f0f0f0f0f0f";
const flip = (hex, bits) => {
  // Перевертаємо молодші біти останніх символів — рівно `bits` біт.
  const chars = hex.split("");
  let left = bits;
  for (let i = chars.length - 1; i >= 0 && left > 0; i--) {
    let v = parseInt(chars[i], 16);
    for (let b = 0; b < 4 && left > 0; b++, left--) v ^= 1 << b;
    chars[i] = v.toString(16);
  }
  return chars.join("");
};

test("nearest — an exact hash is found at distance 0", async () => {
  await store(BASE);
  const hit = await VisionCache.nearest(BASE);
  assert.equal(hit.distance, 0);
  assert.equal(hit.row.text_ocr, `ocr-${BASE}`);
});

test("nearest — a recompressed repost within the threshold is a hit", async () => {
  // Суть кешу: перепост майже ніколи не має відстані 0, тож точний ключ
  // промахувався б саме тут.
  const stored = "a1a1a1a1a1a1a1a1";
  await store(stored);
  const repost = flip(stored, 6);
  const hit = await VisionCache.nearest(repost);
  assert.ok(hit, "перепост на відстані 6 має знайтись");
  assert.equal(hit.distance, 6);
  assert.equal(hit.row.image_hash, stored);
});

test("nearest — beyond the threshold is a miss", async () => {
  const stored = "5555555555555555";
  await store(stored);
  assert.equal(await VisionCache.nearest(flip(stored, 12)), null);
});

test("nearest — picks the closest of several candidates", async () => {
  const near = "c3c3c3c3c3c3c3c0";
  const far = "c3c3c3c3c3c3c3ff";
  await store(far);
  await store(near);
  const hit = await VisionCache.nearest("c3c3c3c3c3c3c3c1"); // 1 біт від near
  assert.equal(hit.row.image_hash, near);
  assert.equal(hit.distance, 1);
});

test("nearest — entries older than the TTL do not count", async () => {
  const stored = "7e7e7e7e7e7e7e7e";
  await store(stored);
  const future = new Date(Date.now() + 100 * 3_600_000);
  assert.equal(await VisionCache.nearest(stored, { ttlHours: 72, now: future }), null);
});

test("nearest — garbage hashes are a miss, not a crash", async () => {
  for (const bad of [null, undefined, "", "xyz", "0f0f", "gggggggggggggggg"]) {
    assert.equal(await VisionCache.nearest(bad), null, String(bad));
  }
});

test("store — an illegible result is cached too", async () => {
  // Нечитабельний перепост не має оплачуватись удруге.
  const hash = "3c3c3c3c3c3c3c3c";
  await store(hash, { text_ocr: "", legible: false, description: "blurry" });
  const hit = await VisionCache.nearest(hash);
  assert.equal(hit.row.legible, false);
  assert.equal(hit.row.text_ocr, "");
});

test("sweep — removes only what is past the TTL", async () => {
  // Старимо ОДИН тестовий рядок напряму в базі й свіпимо з реальним «зараз».
  // Свіп із майбутньою датою видалив би кожен рядок кешу в базі — включно зі
  // справжніми, якщо тести ганяють на робочій dev-базі.
  const fresh = await store("9999999999999999");
  const stale = await store("6666666666666666");
  const old = new Date(Date.now() - 100 * 3_600_000).toISOString().replace("T", " ").replace("Z", " +00:00");
  await database.sequelize.query("UPDATE `vision_cache` SET `createdAt` = ? WHERE `id` = ?", {
    replacements: [old, stale.id],
  });

  const removed = await VisionCache.sweep({ ttlHours: 72 });

  assert.ok(removed >= 1, "прострочений рядок прибрано");
  assert.equal(await VisionCache.findByPk(stale.id), null);
  assert.ok(await VisionCache.findByPk(fresh.id), "свіжий рядок лишився");
});

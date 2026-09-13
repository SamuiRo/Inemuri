import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import {
  dhash, hammingDistance, downscaleForVision, VISION_MAX_SIDE, SAME_IMAGE_MAX_DISTANCE, sniffImageFormat,
} from "../src/shared/image.js";

/**
 * Скріншотоподібне зображення: шапка, рядки «тексту», кнопка — контрастні
 * краї, як у справжньому UI. `seed` міняє розкладку, даючи інший знімок.
 *
 * Не плавний градієнт: на ньому сусідні пікселі майже рівні, шум JPEG
 * перевертає біти dHash, і фікстура перевіряла б найгірший випадок, а не
 * скріншоти, під які налаштовано поріг.
 */
async function screenshot(width = 1200, height = 800, { seed = 0 } = {}) {
  const W = 1200, H = 800;
  const widths = [900, 700, 1000, 500, 820, 640, 960, 300, 760];
  const rects = [
    `<rect x="0" y="0" width="${W}" height="90" fill="#2b5278"/>`,
    ...widths.map((_, i) =>
      `<rect x="60" y="${140 + i * 60}" width="${widths[(i + seed) % 9]}" height="22" fill="#222"/>`),
    `<rect x="${60 + seed * 90}" y="700" width="260" height="60" rx="10" fill="#3a9"/>`,
  ].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect width="100%" height="100%" fill="#fff"/>${rects}</svg>`;
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
}

// ── dhash ─────────────────────────────────────────────────────────────

test("dhash — 16 hex chars", async () => {
  assert.match(await dhash(await screenshot(300, 200)), /^[0-9a-f]{16}$/);
});

test("dhash — deterministic for the same bytes", async () => {
  const img = await screenshot(300, 200);
  assert.equal(await dhash(img), await dhash(img));
});

test("dhash — a recompressed repost stays within the same-image threshold", async () => {
  // Той самий скріншот у п'яти каналах: Telegram перестискає й зменшує.
  // Моделюємо саме це — перетворення ОДНОГО знімка, а не два окремо
  // растеризовані зображення, які різнились би ще й растеризацією.
  const original = await screenshot();
  const h0 = await dhash(original);
  for (const [w, q] of [[1200, 90], [1080, 80], [800, 75], [600, 60], [400, 50]]) {
    const repost = await sharp(original).resize(w).jpeg({ quality: q }).toBuffer();
    const d = hammingDistance(h0, await dhash(repost));
    assert.ok(d <= SAME_IMAGE_MAX_DISTANCE, `${w}px q${q}: відстань ${d}`);
  }
});

test("dhash — a repost rarely hashes identically, so exact-match caching would miss", async () => {
  // Обґрунтування того, що кеш шукає за відстанню, а не за рівністю хешу.
  const original = await screenshot();
  const h0 = await dhash(original);
  const repost = await sharp(original).resize(1080).jpeg({ quality: 80 }).toBuffer();
  assert.notEqual(await dhash(repost), h0, "якщо рівні — обґрунтування застаріло, перегляньте кеш");
});

test("dhash — genuinely different screenshots are beyond the threshold", async () => {
  const h0 = await dhash(await screenshot());
  for (const seed of [1, 2, 3, 5]) {
    const d = hammingDistance(h0, await dhash(await screenshot(1200, 800, { seed })));
    assert.ok(d > SAME_IMAGE_MAX_DISTANCE, `seed ${seed}: відстань ${d}`);
  }
});

test("dhash — garbage bytes reject rather than hash", async () => {
  await assert.rejects(dhash(Buffer.from("definitely not an image")));
});

// ── hammingDistance ───────────────────────────────────────────────────

test("hammingDistance — basics", () => {
  assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
  assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
  assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
});

test("hammingDistance — invalid input is null, never NaN", () => {
  // NaN < 6 === false, але null змушує викликача перевірити явно, а не
  // випадково вирішити, що «відстань мала».
  for (const [a, b] of [["abc", "abcd"], [null, "0000"], ["zzzz", "0000"], [undefined, undefined]]) {
    assert.equal(hammingDistance(a, b), null, `${a} vs ${b}`);
  }
});

// ── downscaleForVision ────────────────────────────────────────────────

test("downscaleForVision — large images shrink to the max side, aspect kept", async () => {
  const out = await downscaleForVision(await screenshot(3000, 1500));
  assert.equal(out.width, VISION_MAX_SIDE);
  assert.equal(out.height, VISION_MAX_SIDE / 2);
  assert.equal(out.mimeType, "image/jpeg");
});

test("downscaleForVision — small images are not enlarged", async () => {
  const out = await downscaleForVision(await screenshot(300, 200));
  assert.equal(out.width, 300);
  assert.equal(out.height, 200);
});

test("downscaleForVision — the output is smaller than a large original", async () => {
  // Сенс зменшення — квота: вартість запиту росте з роздільною здатністю.
  const original = await screenshot(3000, 2000);
  const out = await downscaleForVision(original);
  assert.ok(out.data.length < original.length, `${out.data.length} vs ${original.length}`);
});

test("downscaleForVision — refuses a decompression bomb", async () => {
  // Кілька кілобайтів на вході, гігабайти після розпакування. Заголовок
  // декларує величезні розміри — sharp має відмовити ДО декодування.
  const bomb = await sharp({
    create: { width: 10_000, height: 10_000, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png({ compressionLevel: 9 }).toBuffer();
  await assert.rejects(downscaleForVision(bomb), /pixel limit|exceeds/i);
});

// ── сигнатура до декодера ─────────────────────────────────────────────


test("sniffImageFormat — recognises real JPEG, PNG and WebP bytes", async () => {
  const base = sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } });
  assert.equal(sniffImageFormat(await base.clone().jpeg().toBuffer()), "jpeg");
  assert.equal(sniffImageFormat(await base.clone().png().toBuffer()), "png");
  assert.equal(sniffImageFormat(await base.clone().webp().toBuffer()), "webp");
});

test("sniffImageFormat — anything else is null", async () => {
  const base = sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } });
  for (const [name, buf] of [
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ["gif", await base.clone().gif().toBuffer()],
    ["tiff", await base.clone().tiff().toBuffer()],
    ["text", Buffer.from("hello world, not an image")],
    ["short", Buffer.from([0xff, 0xd8])],
    ["empty", Buffer.alloc(0)],
  ]) {
    assert.equal(sniffImageFormat(buf), null, name);
  }
  assert.equal(sniffImageFormat("not a buffer"), null);
});

test("downscaleForVision — an SVG labelled as PNG is refused before sharp", async () => {
  // Регресія. mimeType документа вказує відправник, а sharp визначає формат
  // за вмістом: SVG з підписом image/png проходив фільтр і рендерився через
  // librsvg. Перевірено до виправлення — повертав 400×200 JPEG.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#f00"/></svg>',
  );
  await assert.rejects(downscaleForVision(svg), /not a JPEG, PNG or WebP by signature/);
});

test("downscaleForVision — a WebP screenshot is processed", async () => {
  const webp = await sharp(await screenshot()).webp().toBuffer();
  const out = await downscaleForVision(webp);
  assert.equal(out.mimeType, "image/jpeg");
  assert.ok(out.width > 0);
});

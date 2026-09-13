import sharp from "sharp";

/**
 * Локальна обробка зображень для vision (VISION.md «Local image processing»).
 *
 * Один модуль на скрипт бекфілу і стадію vision: dHash раніше жив лише в
 * scripts/backfill-image-hash.js, а gate 3 має рахувати його так само —
 * інакше хеш із бекфілу й хеш зі стадії vision розійшлися б і кеш не
 * збігався б між ними.
 *
 * УВАГА: з фази 1.5 sharp обробляє зображення з Telegram-каналів, тобто
 * байти ззовні. До цього він бачив лише файли з репозиторію, і CVE у libvips
 * були недосяжні. Тепер досяжні — див. CHANGELOG про оновлення sharp.
 */

/**
 * Жорстка стеля на вхід, до будь-якого декодування. Зображення, що
 * декларує 50 000 × 50 000 пікселів, — класичний decompression bomb: кілька
 * кілобайтів на вході, гігабайти після розпакування. sharp перевіряє це сам
 * через limitInputPixels; задаємо явно, а не покладаємось на дефолт.
 */
export const MAX_INPUT_PIXELS = 50_000_000; // ~7000 × 7000

/** Найбільший бік після зменшення. Скріншоти лишаються читабельними. */
export const VISION_MAX_SIDE = 1024;

const sharpSafe = (buffer) => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });

/** Формати, які ми погоджуємося декодувати з чужих байтів. */
export const ACCEPTED_IMAGE_FORMATS = Object.freeze(["jpeg", "png", "webp"]);

/**
 * Формат за сигнатурою перших байтів — БЕЗ жодного декодера.
 *
 * Потрібно тому, що `mimeType` документа в Telegram вказує відправник, а sharp
 * визначає формат за вмістом. SVG, підписаний як image/png, проходив фільтр за
 * MIME і рендерився через librsvg — перевірено. Сигнатуру підробити не можна,
 * не зробивши файл справді PNG/JPEG/WebP, тож до sharp доходить лише те, що ним
 * і є.
 *
 * @param {Buffer} buffer
 * @returns {"jpeg"|"png"|"webp"|null}
 */
export function sniffImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * dHash: 9×8 grayscale → порівняння сусідніх пікселів у рядку → 64 біти → 16 hex.
 * Стійкий до масштабування й легкого стиснення — саме те, що треба для
 * «той самий скріншот у п'яти каналах».
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>} 16 hex-символів.
 */
export async function dhash(buffer) {
  const w = 9, h = 8;
  const px = await sharpSafe(buffer)
    .greyscale()
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer();

  let bits = "";
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w - 1; col++) {
      bits += px[row * w + col] < px[row * w + col + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/**
 * Поріг «той самий знімок» для відстані Геммінга між dHash.
 *
 * Виміряно на скріншотоподібних зображеннях: той самий знімок після
 * перестискання й зменшення (як це робить Telegram) дає 4–7 біт; справді
 * інші скріншоти — 15–23. 10 лежить посередині розриву із запасом в обидва
 * боки.
 *
 * Звідси й головне: **точний збіг хешу як ключ кешу не працює** — перепост
 * майже ніколи не має відстані 0. Кеш шукає за відстанню, не за рівністю.
 *
 * Застереження з тих самих вимірів: на низькоконтрастних зображеннях
 * (плавні градієнти, темні UI з ледь помітними переходами) сусідні пікселі
 * майже рівні, шум JPEG перевертає біти, і dHash перестає розрізняти
 * «перестиснутий» і «інший». Для таких поріг дасть зайві промахи кешу — це
 * коштує виклику, а не коректності.
 */
export const SAME_IMAGE_MAX_DISTANCE = 10;

/**
 * Відстань Геммінга між двома dHash. 0 — ідентичні; невеликі значення —
 * той самий знімок після перестискання. Невалідний вхід — null, не NaN:
 * викликач не має помилково вирішити, що «відстань мала».
 */
export function hammingDistance(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !/^[0-9a-f]+$/i.test(a + b)) {
    return null;
  }
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * Зменшує зображення для vision-виклику: найбільший бік ≤ maxSide, JPEG.
 * Зображення, менше за стелю, не збільшується. Вартість запиту росте з
 * роздільною здатністю, тож це головний важіль на квоті.
 *
 * @param {Buffer} buffer
 * @param {{maxSide?: number, quality?: number}} [opts]
 * @returns {Promise<{data: Buffer, mimeType: string, width: number, height: number}>}
 */
export async function downscaleForVision(buffer, { maxSide = VISION_MAX_SIDE, quality = 85 } = {}) {
  // Сигнатура ДО sharp: до декодера доходить лише справжній JPEG/PNG/WebP.
  const format = sniffImageFormat(buffer);
  if (!format) {
    throw new Error("unsupported image format: not a JPEG, PNG or WebP by signature");
  }
  const { data, info } = await sharpSafe(buffer)
    .rotate() // EXIF-орієнтація: інакше знімок з телефона приходить боком
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  return { data, mimeType: "image/jpeg", width: info.width, height: info.height };
}

export default {
  dhash, hammingDistance, downscaleForVision, sniffImageFormat,
  MAX_INPUT_PIXELS, VISION_MAX_SIDE, SAME_IMAGE_MAX_DISTANCE, ACCEPTED_IMAGE_FORMATS,
};

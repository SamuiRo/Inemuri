import { print } from "../../shared/utils.js";
import { dhash, downscaleForVision } from "../../shared/image.js";
import { VisionCache } from "../teapot/models/index.js";
import defaultResolver from "./media/index.js";

/**
 * TheFlow — стадія 1.5, vision (ROADMAP §4, VISION.md).
 *
 * Між ingest і enrich, у воркері — ніколи під час ingest: інваріант «ingest
 * без вихідних мережевих викликів» лишається.
 *
 *   gate → лише фото, не більше N → зменшити → dHash → кеш за відстанню →
 *   gateway.vision() → ОДРАЗУ UPDATE posts.text_ocr → далі enrich як завжди
 *
 * text_ocr записується негайно, до enrich(): якщо збагачення потім впаде й
 * повториться, за транскрипцію не заплатять удруге. Через це vision не
 * потребує окремого статусу — `text_ocr IS NOT NULL` і є позначкою.
 *
 * NULL і "" різні навмисно: NULL — ще не пробували; "" — пробували, тексту
 * нема (немає фото, нечитабельне, заблоковане). Інакше пост без тексту на
 * знімку перетранскрибовувався б на кожній спробі.
 *
 * Відомий пропуск: беремо лише `photo`. Скріншот, надісланий як файл
 * (документ image/png, щоб Telegram не стискав), сюди не потрапляє.
 */

/** Чому стадія не запускається. Порядок — від найдешевшої перевірки. */
export const VISION_SKIP = Object.freeze({
  ALREADY_TRANSCRIBED: "already_transcribed",
  SOURCE_DISABLED: "source_disabled",
  NO_MEDIA: "no_media",
  TEXT_LONG_ENOUGH: "text_long_enough",
});

/**
 * Ворота 1, 2 і попередні перевірки (VISION.md «Gates»). Чиста функція.
 * Gate 3 (хеш уже бачили) потребує байтів і бази — він у run().
 * Gate 4 (стеля альбому) застосовується при завантаженні.
 *
 * @param {{post: object, flow: object}} args  flow — source.getFlowConfig()
 * @returns {{run: boolean, reason: string|null}}
 */
export function visionGate({ post, flow }) {
  if (post?.text_ocr != null) return { run: false, reason: VISION_SKIP.ALREADY_TRANSCRIBED };
  if (!flow?.enabled || !flow?.vision?.enabled) return { run: false, reason: VISION_SKIP.SOURCE_DISABLED };
  if (!post?.has_media) return { run: false, reason: VISION_SKIP.NO_MEDIA };

  const threshold = Number(flow.vision.text_threshold ?? 200);
  const textLength = String(post.raw_text ?? "").trim().length;
  // Суттєвий текст → зображення майже напевно декоративне.
  if (Number.isFinite(threshold) && textLength > threshold) {
    return { run: false, reason: VISION_SKIP.TEXT_LONG_ENOUGH };
  }
  return { run: true, reason: null };
}

export class VisionStage {
  /**
   * @param {object} deps
   * @param {object} deps.gateway                LLMGateway (vision()).
   * @param {object} [deps.resolver]             MediaResolver.
   * @param {object} [deps.cache]                VisionCache-подібний: nearest/store.
   * @param {object} [deps.image]                { dhash, downscaleForVision } — для тестів.
   * @param {number} [deps.ttlHours=72]
   */
  constructor({ gateway, resolver = defaultResolver, cache = VisionCache, image, ttlHours = 72 } = {}) {
    if (!gateway) throw new Error("VisionStage needs a gateway");
    this.gateway = gateway;
    this.resolver = resolver;
    this.cache = cache;
    this.image = image ?? { dhash, downscaleForVision };
    this.ttlHours = ttlHours;
  }

  /**
   * @param {object} post  Sequelize-інстанс posts (потрібен update()).
   * @param {object} flow  source.getFlowConfig()
   * @returns {Promise<
   *   {status: "skipped", reason: string} |
   *   {status: "shed"} |
   *   {status: "unavailable"} |
   *   {status: "done", text_ocr: string, vision_used: boolean, image_hash: string|null,
   *    calls: number, cacheHits: number, failedImages: number}
   * >}
   *
   *   shed        — квота під тиском: пост лишити pending, не збагачувати без OCR.
   *   unavailable — жоден провайдер не вміє vision: збагачувати як є, text_ocr не чіпати.
   *   Помилка резолвера чи gateway кидається далі — воркер рахує спробу.
   */
  async run(post, flow) {
    const gate = visionGate({ post, flow });
    if (!gate.run) return { status: "skipped", reason: gate.reason };

    const limit = Math.max(1, Number(flow.vision.max_images_per_post ?? 2) || 2);
    const files = await this.resolver.resolve(post, { types: ["photo"], limit });

    const texts = [];
    let firstHash = null;
    let calls = 0;
    let cacheHits = 0;
    let failedImages = 0;

    for (const file of files) {
      let small;
      let hash;
      try {
        small = await this.image.downscaleForVision(file.buffer);
        hash = await this.image.dhash(small.data);
      } catch (error) {
        // Одне биге зображення (або decompression bomb) не має блокувати
        // збагачення всього поста.
        failedImages += 1;
        print(`[VISION] post#${post.id}: image skipped (${error.message})`, "warning");
        continue;
      }
      firstHash ??= hash;

      const hit = await this.cache.nearest(hash, { ttlHours: this.ttlHours });
      if (hit) {
        cacheHits += 1;
        texts.push(hit.row.text_ocr);
        continue;
      }

      const res = await this.gateway.vision({ data: small.data, mimeType: small.mimeType });
      if (res === null) return { status: "unavailable" };
      // Уже оплачені зображення цього поста лежать у кеші, тож повтор після
      // shed візьме їх звідти, а не оплатить знову.
      if (res.shed) return { status: "shed" };

      await this.cache.store(hash, res);
      calls += 1;
      texts.push(res.text_ocr);
    }

    const text_ocr = texts.map((t) => String(t ?? "").trim()).filter(Boolean).join("\n\n");
    const image_hash = firstHash ?? post.image_hash ?? null;

    // Негайно, до enrich(): повтор збагачення не має платити за транскрипцію.
    await post.update({ text_ocr, vision_used: calls > 0, image_hash });

    print(
      `[VISION] post#${post.id}: ${files.length} image(s), ${calls} call(s), ${cacheHits} cache hit(s)` +
        (failedImages ? `, ${failedImages} failed` : "") +
        ` → ${text_ocr.length} chars`,
      calls > 0 ? "success" : "debug",
    );

    return { status: "done", text_ocr, vision_used: calls > 0, image_hash, calls, cacheHits, failedImages };
  }
}

export default VisionStage;

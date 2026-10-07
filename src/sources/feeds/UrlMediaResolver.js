import axios from "axios";

import { print } from "../../shared/utils.js";
import { FEEDS } from "../../config/app.config.js";
import { feedThrottle } from "./http.js";

/**
 * Медіа за URL — для постів зі стрічок (ROADMAP §7.3), `media_ref.kind: "url"`.
 *
 * Той самий контракт, що й TelegramMediaResolver: фільтри `types` / `accept`
 * / `limit` діють ДО завантаження. Тип до завантаження відомий лише з URL
 * (розширення), тож це здогадка; після — перевіряється за Content-Type, і
 * файл, що виявився не тим (HTML-сторінка помилки замість картинки),
 * відкидається.
 *
 * Запити — через спільний feedThrottle (пауза на хост), з User-Agent
 * опитувача і стелею розміру.
 */

const EXT_TYPE = [
  [/\.(mp4|webm|mov|m4v)$/i, "video", "video/mp4"],
  [/\.gif$/i, "animation", "image/gif"],
  [/\.(jpe?g)$/i, "photo", "image/jpeg"],
  [/\.png$/i, "photo", "image/png"],
  [/\.webp$/i, "photo", "image/webp"],
];

/** Здогадка про тип за URL — до завантаження. Зі стрічок це майже завжди картинка. */
export function guessFromUrl(url) {
  let path = "";
  try { path = new URL(url).pathname; } catch { return { type: "photo", mimeType: "image/jpeg" }; }
  for (const [re, type, mimeType] of EXT_TYPE) if (re.test(path)) return { type, mimeType };
  return { type: "photo", mimeType: "image/jpeg" };
}

/** Тип за фактичним Content-Type, або null — не медіа. */
export function typeFromContentType(ct) {
  const c = String(ct ?? "").split(";")[0].trim().toLowerCase();
  if (c === "image/gif") return "animation";
  if (c.startsWith("image/")) return "photo";
  if (c.startsWith("video/")) return "video";
  return null;
}

function filenameOf(url, index, mimeType) {
  let base = "";
  try { base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); } catch { /* ignore */ }
  if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base.slice(-100);
  const ext = (mimeType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
  return `media-${index + 1}.${ext}`;
}

export class UrlMediaResolver {
  constructor({ http = axios, throttle = feedThrottle, config = FEEDS } = {}) {
    this.http = http;
    this.throttle = throttle;
    this.config = config;
  }

  /**
   * @param {object} post  З `media_ref: { kind: "url", urls: [...] }`.
   * @param {{types?: string[], limit?: number, accept?: (media: object) => boolean}} [opts]
   * @returns {Promise<object[]>} [{ type, buffer, filename, mimeType, fileSize }]
   */
  async resolve(post, { types = null, limit = null, accept = null } = {}) {
    const urls = Array.isArray(post?.media_ref?.urls) ? post.media_ref.urls : [];
    let planned = urls
      .filter((u) => /^https?:\/\//i.test(String(u)))
      .map((url) => ({ url, ...guessFromUrl(url) }));
    if (Array.isArray(types) && types.length) planned = planned.filter((m) => types.includes(m.type));
    if (typeof accept === "function") planned = planned.filter((m) => accept(m));
    if (Number.isInteger(limit) && limit > 0) planned = planned.slice(0, limit);

    const out = [];
    for (const [i, m] of planned.entries()) {
      try {
        const res = await this.throttle.run(m.url, () => this.http.get(m.url, {
          responseType: "arraybuffer",
          timeout: this.config.timeoutMs,
          maxContentLength: this.config.maxMediaBytes,
          headers: { "user-agent": this.config.userAgent },
        }));
        const mimeType = String(res.headers?.["content-type"] ?? m.mimeType).split(";")[0].trim();
        const type = typeFromContentType(mimeType);
        if (!type) {
          print(`[MEDIA] url: ${m.url} is ${mimeType}, not media — skipped`, "debug");
          continue;
        }
        if (Array.isArray(types) && types.length && !types.includes(type)) continue;
        const buffer = Buffer.from(res.data);
        out.push({ type, buffer, filename: filenameOf(m.url, i, mimeType), mimeType, fileSize: buffer.length });
      } catch (error) {
        // Одна мертва картинка не валить решту.
        print(`[MEDIA] url: ${m.url} failed: ${error.message}`, "warning");
      }
    }
    return out;
  }
}

export default UrlMediaResolver;

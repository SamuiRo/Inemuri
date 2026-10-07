import zlib from "node:zlib";

import axios from "axios";

import { FEEDS } from "../../config/app.config.js";

/**
 * Ввічливий HTTP для стрічок (ROADMAP §7.4).
 *
 * HostThrottle — мінімальна пауза між запитами до одного хоста. Не глобальна:
 * повільний Reddit не має гальмувати RSS із десятка інших сайтів. Черга на
 * хост — ланцюжок промісів, тож паралельні виклики стають у ряд, а не
 * пробивають інтервал.
 */
export class HostThrottle {
  /**
   * @param {{ intervals: Record<string, number>, now?: () => number, sleep?: (ms: number) => Promise<void> }} opts
   *   intervals — { default, "<host>": ms }; хост зіставляється за суфіксом
   *   (www.reddit.com → reddit.com).
   */
  constructor({ intervals, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.intervals = intervals ?? { default: 1_000 };
    this.now = now;
    this.sleep = sleep;
    this._last = new Map(); // host -> час останнього запиту
    this._chain = new Map(); // host -> проміс черги
  }

  static hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  intervalFor(host) {
    for (const [suffix, ms] of Object.entries(this.intervals)) {
      if (suffix !== "default" && (host === suffix || host.endsWith(`.${suffix}`))) return ms;
    }
    return this.intervals.default ?? 1_000;
  }

  /** Виконати fn після того, як для хоста url минув інтервал. */
  async run(url, fn) {
    const host = HostThrottle.hostOf(url);
    const prev = this._chain.get(host) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const wait = (this._last.get(host) ?? -Infinity) + this.intervalFor(host) - this.now();
      if (wait > 0) await this.sleep(wait);
      this._last.set(host, this.now());
      return fn();
    });
    this._chain.set(host, next);
    return next;
  }
}

/**
 * Один throttle на процес: опитувач стрічок і UrlMediaResolver ходять на ті
 * самі хости (картинки Reddit — i.redd.it / preview.redd.it), і пауза має
 * бути спільною, а не в кожного своя.
 */
export const feedThrottle = new HostThrottle({ intervals: FEEDS.hostMinIntervalMs });

/**
 * Retry-After (секунди або HTTP-дата) → мс, або null.
 */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * Тіло відповіді → текст. Файл `.xml.gz` (sitemap-и NYT, WaPo) приходить
 * сирим gzip-ом, а не з Content-Encoding, — його видно за сигнатурою 1f 8b.
 * Розпаковане обмежене тією ж стелею: gzip-бомба — помилка опитування, а не
 * гігабайт у пам'яті.
 */
export function decodeBody(data, maxBytes = Infinity) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  let buf = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf, Number.isFinite(maxBytes) ? { maxOutputLength: maxBytes } : {});
  }
  return buf.toString("utf-8");
}

/**
 * GET для стрічки: описовий User-Agent, умовний запит, стеля розміру.
 *
 * @returns {Promise<{ status: number, body: string|null, etag: string|null,
 *   lastModified: string|null, retryAfterMs: number|null }>}
 *   304 → body null. 429/503 → body null і retryAfterMs, не виняток: це
 *   «прийди пізніше», а не помилка стрічки.
 */
export async function fetchFeed(url, {
  http = axios, userAgent, timeoutMs = FEEDS.timeoutMs, maxBytes = FEEDS.maxFeedBytes,
  etag = null, lastModified = null, accept = "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5",
  headers: extra = {},
} = {}) {
  const headers = { "user-agent": userAgent, accept, ...extra };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;

  const res = await http.get(url, {
    headers,
    timeout: timeoutMs,
    maxContentLength: maxBytes,
    responseType: "arraybuffer", // байти: можливо, це .gz (decodeBody)
    // Не кидати на 304/401/403/429/503 — це штатні відповіді для опитувача:
    // «без змін», «закрито для нас», «прийди пізніше».
    validateStatus: (s) => (s >= 200 && s < 300) || [304, 401, 403, 429, 503].includes(s),
    transformResponse: (d) => d,
  });

  const h = res.headers ?? {};
  const limited = res.status === 429 || res.status === 503;
  return {
    status: res.status,
    body: res.status >= 200 && res.status < 300 ? decodeBody(res.data, maxBytes) : null,
    etag: h.etag ?? null,
    lastModified: h["last-modified"] ?? null,
    retryAfterMs: limited ? (retryAfterMs(h["retry-after"]) ?? FEEDS.defaultRetryAfterMs) : null,
    forbidden: res.status === 401 || res.status === 403,
  };
}

/**
 * Reddit app-only OAuth (grant `client_credentials`). Токен кешується до
 * закінчення (мінус хвилина запасу); 401 від API скидає його — наступний
 * запит візьме новий.
 */
export class RedditAuth {
  constructor({ clientId, clientSecret, userAgent, http = axios, now = Date.now, timeoutMs = FEEDS.timeoutMs }) {
    this.timeoutMs = timeoutMs;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.userAgent = userAgent;
    this.http = http;
    this.now = now;
    this._token = null;
    this._expiresAt = 0;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  invalidate() {
    this._token = null;
    this._expiresAt = 0;
  }

  async token() {
    if (this._token && this.now() < this._expiresAt) return this._token;
    const res = await this.http.post(
      "https://www.reddit.com/api/v1/access_token",
      "grant_type=client_credentials",
      {
        auth: { username: this.clientId, password: this.clientSecret },
        headers: { "user-agent": this.userAgent, "content-type": "application/x-www-form-urlencoded" },
        timeout: this.timeoutMs,
      },
    );
    const t = res.data?.access_token;
    if (!t) throw new Error("reddit oauth: no access_token in response");
    this._token = t;
    this._expiresAt = this.now() + Math.max(60, Number(res.data.expires_in ?? 3600) - 60) * 1000;
    return t;
  }
}

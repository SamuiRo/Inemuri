/**
 * REST user-акаунта — чисте ядро: шляхи, заголовки, ліміти запитів.
 * Оболонка — RestClient.js.
 */

import { API_VERSION } from "./protocol.js";

export const API_BASE = `https://discord.com/api/v${API_VERSION}`;
export const MAX_PAGE = 100;

/** GET /channels/{id}/messages з before/after/limit (limit 1..100). */
export function messagesPath(channelId, { before = null, after = null, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (before) params.set("before", String(before));
  if (after) params.set("after", String(after));
  params.set("limit", String(Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || 50)))));
  return `/channels/${encodeURIComponent(channelId)}/messages?${params}`;
}

/**
 * Заголовки веб-клієнта для REST.
 * @param {{ token: string, identity: { userAgent: string, encodedSuperProperties: string, locale: string }, timeZone?: string }} input
 */
export function requestHeaders({ token, identity, timeZone = "UTC" }) {
  return {
    authorization: token,
    "user-agent": identity.userAgent,
    "x-super-properties": identity.encodedSuperProperties,
    "x-discord-locale": identity.locale,
    "x-discord-timezone": timeZone,
    "accept-language": `${identity.locale},${identity.locale.split("-")[0]};q=0.9`,
    accept: "*/*",
    origin: "https://discord.com",
    referer: "https://discord.com/channels/@me",
  };
}

/**
 * Відповідь → чи це ліміт і скільки чекати. Discord дає `retry_after` у
 * секундах у тілі 429 і `Retry-After` / `X-RateLimit-Reset-After` у заголовках.
 *
 * @param {number} status
 * @param {(name: string) => string|null} header
 * @param {object|null} body
 * @returns {{ limited: boolean, retryAfterMs: number, global: boolean, remaining: number|null, resetAfterMs: number|null }}
 */
export function parseRateLimit(status, header, body = null) {
  const num = (v) => (v == null || v === "" ? null : Number(v));
  const remaining = num(header("x-ratelimit-remaining"));
  const resetAfter = num(header("x-ratelimit-reset-after"));
  const resetAfterMs = Number.isFinite(resetAfter) ? Math.ceil(resetAfter * 1000) : null;
  if (status !== 429) {
    return { limited: false, retryAfterMs: 0, global: false, remaining: Number.isFinite(remaining) ? remaining : null, resetAfterMs };
  }
  const seconds = [num(body?.retry_after), num(header("retry-after")), resetAfter].find((v) => Number.isFinite(v) && v >= 0) ?? 5;
  return {
    limited: true,
    retryAfterMs: Math.ceil(seconds * 1000),
    global: body?.global === true || header("x-ratelimit-global") === "true",
    remaining: 0,
    resetAfterMs,
  };
}

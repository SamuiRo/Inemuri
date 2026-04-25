import "dotenv/config";

import pkg from "../../package.json" with { type: "json" };
import SourceConfig from "./sources.json" with { type: "json" };

// ── Runtime ────────────────────────────────────────────────────────────────
export const NODE_ENV = process.env.NODE_ENV;
export const PKG = pkg;
export const SOURCE_CONFIG = SourceConfig;

// ── Telegram auth ──────────────────────────────────────────────────────────
export const TELEGRAM_SESSION =
  process.env.TELEGRAM_SESSION === "" ? null : process.env.TELEGRAM_SESSION;
export const TELEGRAM_API_ID = +process.env.TELEGRAM_API_ID;
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;

// ── Discord ────────────────────────────────────────────────────────────────
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const DISCORD_COMMAND_WHITELIST = process.env.DISCORD_COMMAND_WHITELIST
  ? process.env.DISCORD_COMMAND_WHITELIST.split(",").map((id) => id.trim())
  : [];

// ── Polling ────────────────────────────────────────────────────────────────
export const POLLING_INTERVAL_MS =
  Number(process.env.POLLING_INTERVAL_MIN) * 60 * 1000;
export const POLLING_FETCH_LIMIT = Number(process.env.POLLING_FETCH_LIMIT);

// ── External services ──────────────────────────────────────────────────────
export const CMC_API_KEY = process.env.CMC_API_KEY;

// ── TelegramSourceListener: album grouping ─────────────────────────────────
// Час очікування перш ніж вважати альбом зібраним (мс).
// Telegram відправляє повідомлення альбому окремими подіями з невеликим зазором.
export const ALBUM_GROUP_TIMEOUT_MS = 5_000;

// ── TelegramSourceListener: deduplication (mode: "both") ──────────────────
// Скільки часу тримати запис про повідомлення оброблене listener-ом,
// щоб polling не продублював його.
export const DEDUP_TTL_MS = 10 * 60 * 1_000; // 10 хвилин
// Максимальна кількість записів у dedup-сеті (захист від memory leak).
export const DEDUP_MAX_SIZE = 5_000;

// ── TelegramSourceListener: delay між каналами в polling циклі ────────────
// Фіксована пауза між запитами до сусідніх каналів під час одного циклу.
// Зменшує пікове навантаження: 20 каналів × 500ms = +10с на цикл.
export const POLLING_CHANNEL_DELAY_MS = 500;

// ── TelegramSourceListener: media ─────────────────────────────────────────
// Типи медіа, які варто завантажувати і пересилати далі.
export const DOWNLOADABLE_MEDIA_TYPES = ["photo", "video", "document", "animation"];
import "dotenv/config";

import pkg from "../../package.json" with { type: "json" };
import CategoriesConfig from "./categories.json" with { type: "json" };
import { loadLocalConfig } from "./localConfig.js";

// ── Runtime ────────────────────────────────────────────────────────────────
export const NODE_ENV = process.env.NODE_ENV;
export const PKG = pkg;
// TheFlow taxonomy (topics / signals) — у репозиторії, спільна для всіх.
export const CATEGORIES = CategoriesConfig;

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

// ── Валідація числових env ────────────────────────────────────────────────
// Зібрані тут, а не надруковані одразу: app.config.js не тягне shared/utils.js
// (важкий: chalk, sharp, gradient), тож попередження друкує inemuri.js на
// старті через print().
export const CONFIG_WARNINGS = [];

/**
 * Додатне число з env, із фолбеком замість NaN.
 *
 * Чому це важливо саме тут: `Number(undefined) * 60 * 1000` дає `NaN`, а
 * `setTimeout(fn, NaN)` виконується негайно (NaN приводиться до 0). Без
 * фолбеку відсутній `POLLING_INTERVAL_MIN` перетворював цикл полінгу на
 * суцільний потік запитів до Telegram — тобто гарантований flood-бан на
 * першому ж запуску з неповним `.env`.
 *
 * @param {string} name     Ім'я змінної (для тексту попередження).
 * @param {*} raw           process.env[name].
 * @param {number} fallback Значення за замовчуванням.
 * @param {string[]} [sink] Куди складати попередження (для тестів).
 */
export function positiveNumber(name, raw, fallback, sink = CONFIG_WARNINGS) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    sink.push(`${name} is not set — falling back to ${fallback}`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    sink.push(`${name}=${JSON.stringify(raw)} is not a positive number — falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

// ── Конфіги конкретного розгортання ───────────────────────────────────────
// У .gitignore: у кожного розгортання свої канали й призначення. Читаються
// через loadLocalConfig, який падає на *.sample.json, — інакше свіжий клон
// не стартує взагалі (module resolution падає на відсутньому файлі).
export const SOURCE_CONFIG = loadLocalConfig("sources", { sources: [] }, CONFIG_WARNINGS);
// Маршрутизація TheFlow: unsorted_destinations + routing. Навмисно НЕ в
// categories.json — таксономія спільна, а id каналів належать розгортанню.
export const ROUTING = loadLocalConfig(
  "routing", { unsorted_destinations: {}, routing: [] }, CONFIG_WARNINGS,
);

// ── Polling ────────────────────────────────────────────────────────────────
export const POLLING_INTERVAL_MIN = positiveNumber(
  "POLLING_INTERVAL_MIN", process.env.POLLING_INTERVAL_MIN, 5,
);
export const POLLING_INTERVAL_MS = POLLING_INTERVAL_MIN * 60 * 1000;
export const POLLING_FETCH_LIMIT = positiveNumber(
  "POLLING_FETCH_LIMIT", process.env.POLLING_FETCH_LIMIT, 50,
);
// Запас поверх FLOOD_WAIT, щоб не повторювати запит рівно на межі вікна.
export const POLLING_FLOOD_MARGIN_MS = 5_000;

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

// ── TheFlow (Phase 0) ────────────────────────────────────────────────────
// Мінімальна довжина нормалізованого тексту після replacements. Коротше —
// пост зберігається зі статусом skipped_empty (не викидається).
export const THEFLOW_MIN_TEXT_LENGTH = Number(process.env.THEFLOW_MIN_TEXT_LENGTH ?? 10);
// Вікно для skipped_repost: точний збіг хешу нормалізованого тексту в межах
// останніх N годин вважається репостом.
export const THEFLOW_REPOST_WINDOW_HOURS = Number(process.env.THEFLOW_REPOST_WINDOW_HOURS ?? 24);

// ── TheFlow — LLM gateway (Phase 1) ─────────────────────────────────────
// Специфікація: docs/theflow/LLM_GATEWAY.md §Configuration.
export const LLM_PRIMARY        = process.env.LLM_PRIMARY  || "gemini";
export const LLM_FALLBACK       = process.env.LLM_FALLBACK || null;
export const LLM_TIER_UP        = process.env.LLM_TIER_UP  || null; // сильніша модель, НЕ fallback
export const LLM_TIER_UP_BELOW  = Number(process.env.LLM_TIER_UP_BELOW || 0.5);
export const LLM_MAX_CONCURRENCY = Number(process.env.LLM_MAX_CONCURRENCY || 2);
export const LLM_TIMEOUT_MS     = Number(process.env.LLM_TIMEOUT_MS || 30_000);
// Прапорця shadow mode тут немає навмисно. У фазі 1 shadow — це властивість
// структури, а не конфігу: вердикти пише EnrichWorker, а читача вердиктів
// (routing) ще не існує. Перемикач з'явиться разом із ним у фазі 2, і саме
// тоді він щось вимикатиме. Див. ROADMAP §3.6, §5.

// Кеш і shedding — прості константи, дзеркалять DEDUP_TTL_MS / DEDUP_MAX_SIZE.
export const LLM_CACHE_TTL_MS   = 6 * 60 * 60 * 1_000;
export const LLM_CACHE_MAX_SIZE = 5_000;
export const LLM_QUOTA_RESERVE  = 0.15; // частка RPD, зарезервована під `critical`

// Enrichment worker (ROADMAP 3.6). Tick і batch виводяться з виміряного RPD
// (3.1), не вгадуються — гальмо все одно token bucket, не таймер.
export const ENRICH_TICK_MS      = Number(process.env.ENRICH_TICK_MS ?? 30_000);
export const ENRICH_BATCH_SIZE   = Number(process.env.ENRICH_BATCH_SIZE ?? 10);
export const ENRICH_MAX_ATTEMPTS = Number(process.env.ENRICH_MAX_ATTEMPTS ?? 3);
// Воркер стартує лише коли є ключ провайдера LLM_PRIMARY і це не вимкнено явно.
export const ENRICH_WORKER_ENABLED = process.env.ENRICH_WORKER_ENABLED !== "false";

// Per-provider: ключ, model id-и, endpoint, ліміти. Усе з env. Модель, у якої
// embedModel === null, не оголошує capability `embed` — gateway маршрутизує
// `embed()` на іншого провайдера або деградує до tier 1 (ROADMAP 3.1).
export const LLM_PROVIDERS = {
  gemini: {
    apiKey:        process.env.GEMINI_API_KEY || null,
    baseUrl:       process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    completeModel: process.env.GEMINI_COMPLETE_MODEL || "gemini-2.5-flash",
    embedModel:    process.env.GEMINI_EMBED_MODEL    || "text-embedding-004",
    visionModel:   process.env.GEMINI_VISION_MODEL   || process.env.GEMINI_COMPLETE_MODEL || "gemini-2.5-flash",
    embedDim:      Number(process.env.GEMINI_EMBED_DIM || 768),
    rpd:           Number(process.env.GEMINI_RPD || 1_400), // verify per 3.1
    rpm:           Number(process.env.GEMINI_RPM || 12),
  },
  openrouter: {
    apiKey:        process.env.OPENROUTER_API_KEY || null,
    baseUrl:       process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    completeModel: process.env.OPENROUTER_COMPLETE_MODEL || null, // Serhii picks per 3.1
    embedModel:    process.env.OPENROUTER_EMBED_MODEL    || null, // null => no embed capability
    visionModel:   process.env.OPENROUTER_VISION_MODEL   || null,
    embedDim:      Number(process.env.OPENROUTER_EMBED_DIM || 0),
    rpd:           Number(process.env.OPENROUTER_RPD || 200),
    rpm:           Number(process.env.OPENROUTER_RPM || 20),
  },
};
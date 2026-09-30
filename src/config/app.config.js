import "dotenv/config";

import pkg from "../../package.json" with { type: "json" };
import CategoriesConfig from "./categories.json" with { type: "json" };
import { fileURLToPath } from "url";
import path from "path";
import { loadLocalConfig } from "./localConfig.js";

// ── Runtime ────────────────────────────────────────────────────────────────
export const NODE_ENV = process.env.NODE_ENV;
export const PKG = pkg;
// TheFlow taxonomy (topics / signals) — у репозиторії, спільна для всіх.
export const CATEGORIES = CategoriesConfig;

// ── Database ───────────────────────────────────────────────────────────────
// Робоча база — database/pot.sqlite. SQLITE_STORAGE перевизначає шлях; його
// ставить scripts/run-tests.js, щоб `npm test` ганявся на одноразовій базі,
// а не на корпусі пілота (до v4.43.1 тест EnrichWorker забирав справжні
// pending-пости і писав у них фейкові вердикти).
export const SQLITE_DEFAULT_STORAGE = path.resolve(process.cwd(), "database", "pot.sqlite");
export const SQLITE_STORAGE = process.env.SQLITE_STORAGE
  ? path.resolve(process.env.SQLITE_STORAGE)
  : SQLITE_DEFAULT_STORAGE;

// ── Telegram auth ──────────────────────────────────────────────────────────
export const TELEGRAM_SESSION =
  process.env.TELEGRAM_SESSION === "" ? null : process.env.TELEGRAM_SESSION;
export const TELEGRAM_API_ID = +process.env.TELEGRAM_API_ID;
export const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;

// ── Discord ────────────────────────────────────────────────────────────────
/** Список id через кому; порожні елементи відкидаються. */
function idList(raw) {
  return (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean);
}

export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || null;
// Хто може запускати адмінські команди discordapp. Порожній список — ніхто
// (fail closed, docs/DISCORDAPP.md D7): експорт читає приватні канали.
export const DISCORD_COMMAND_WHITELIST = idList(process.env.DISCORD_COMMAND_WHITELIST);

// ── discordapp ─────────────────────────────────────────────────────────────
// Керування серверами (docs/DISCORDAPP.md). Доставка від цього не залежить:
// вона ходить через REST і працює навіть з DISCORD_APP_ENABLED=false.
export const DISCORD_APP_ENABLED = process.env.DISCORD_APP_ENABLED !== "false";
// Сервери, які обслуговує discordapp (D8). Порожньо — усі, де є бот.
export const DISCORD_GUILD_IDS = idList(process.env.DISCORD_GUILD_IDS);

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

/**
 * Те саме, але тиша, коли змінної просто немає.
 *
 * Різниця з positiveNumber змістова, не косметична: та стосується змінних, які
 * `.env.example` вимагає і чия відсутність колись давала NaN — про це оператор
 * має знати. А це — опційні ручки тюнінгу з робочим дефолтом. Попереджати про
 * кожну незадану означає засипати старт шумом і привчити його не читати.
 * Задане, але невалідне значення попереджає в обох випадках: оператор щось
 * налаштовував, і це не застосувалось.
 */
export function optionalNumber(name, raw, fallback, sink = CONFIG_WARNINGS) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return positiveNumber(name, raw, fallback, sink);
}

/**
 * IANA-пояс для скидання квоти. Невалідний — попередження і UTC: краще
 * гучно рахувати не в тому поясі, ніж упасти на старті.
 */
export function quotaTimeZone(name, raw, fallback, sink = CONFIG_WARNINGS) {
  const tz = raw == null || String(raw).trim() === "" ? fallback : String(raw).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    sink.push(`${name}=${JSON.stringify(raw)} is not a valid IANA time zone — falling back to UTC`);
    return "UTC";
  }
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

// ── Discord: вкладення ────────────────────────────────────────────────────
// Найбільший файл, що йде вкладенням — і для доставки, і для експорту
// discordapp. 20 МБ перевірено оператором (2026-09-29).
export const DISCORD_UPLOAD_LIMIT_MB = optionalNumber(
  "DISCORD_UPLOAD_LIMIT_MB", process.env.DISCORD_UPLOAD_LIMIT_MB, 20,
);

// ── discordapp: /export-chats ─────────────────────────────────────────────
// Куди пишуться експорти. У .gitignore: там чужі повідомлення.
export const DISCORD_EXPORT_DIR = fileURLToPath(new URL("../../exports/", import.meta.url));
// Скільки каналів читаємо паралельно. Черга rate limit у @discordjs/rest
// все одно вирівнює запити; більше — лише довші паузи на 429.
export const DISCORD_EXPORT_CONCURRENCY = 3;
// Куди ще надсилати файли /export-chats, крім диска: id або @username чату
// Telegram. Не задано — лише диск. У Discord експорт не надсилається: там
// лишається тільки коротка відповідь.
export const DISCORD_EXPORT_TELEGRAM_CHAT = process.env.DISCORD_EXPORT_TELEGRAM_CHAT?.trim() || null;
// Архівних тредів на канал — одна сторінка API. Форум із тисячами тредів
// інакше перетворив би експорт на тисячі запитів; обрізання видно у звіті.
export const DISCORD_EXPORT_ARCHIVED_THREADS = 100;

// ── discordapp: провіжн ───────────────────────────────────────────────────
// Конфіги серверів (docs/DISCORDAPP.md): servers/<name>.json, у .gitignore.
// Читаються на кожну команду, а не на старті — правка конфігу діє без рестарту.
export const DISCORD_SERVERS_DIR = fileURLToPath(new URL("./discordapp/servers/", import.meta.url));
// Тексти повідомлень, на які посилаються конфіги ("file": "rules.md").
export const DISCORD_MESSAGES_DIR = fileURLToPath(new URL("./discordapp/messages/", import.meta.url));

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

// ── Полінг: пер-джерельні інтервали ───────────────────────────────────────
// Планувальник тікає часто й дешево, а опитує лише ті джерела, чий час
// настав (`poll_interval_min` на джерелі, NULL = POLLING_INTERVAL_MIN).
// Один таймер, не N: серіалізація циклу — властивість безпеки, і незалежні
// таймери на джерело її знищили б.
export const POLLING_TICK_MS = optionalNumber(
  "POLLING_TICK_MS", process.env.POLLING_TICK_MS, 30_000,
);
// Стеля каналів на один тік. Навіть якщо все стало due одночасно (рестарт,
// довгий FLOOD_WAIT), робота на тік обмежена — решта сповзає на наступний.
export const POLLING_MAX_PER_TICK = optionalNumber(
  "POLLING_MAX_PER_TICK", process.env.POLLING_MAX_PER_TICK, 8,
);
// Скільки разів підряд _pollChannel може добирати повну сторінку, наздоганяючи
// канал. Без цього джерело з інтервалом «раз на добу» і лімітом 50 відстає
// назавжди: за цикл воно забирає 50 повідомлень, а за добу їх більше.
export const POLLING_MAX_DRAIN_PAGES = optionalNumber(
  "POLLING_MAX_DRAIN_PAGES", process.env.POLLING_MAX_DRAIN_PAGES, 5,
);

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
// Кеш транскрипцій vision (ROADMAP §4). Скріншоти перепощують протягом
// кількох днів; довше тримати — зайвий скан при кожному пошуку за відстанню.
export const VISION_CACHE_TTL_HOURS = optionalNumber(
  "VISION_CACHE_TTL_HOURS", process.env.VISION_CACHE_TTL_HOURS, 72,
);
export const ENRICH_WORKER_ENABLED = process.env.ENRICH_WORKER_ENABLED !== "false";

// Нагляд за TheFlow (ROADMAP §13.10). Інваріант — AI *може* впасти; тоді
// хтось має це помітити, а не оператор, що випадково запустив `flow stats`.
// Алерти йдуть у `health_destinations` з routing.json; без них — лише в лог.
export const FLOW_HEALTH = {
  // Як часто перевіряти. Запит — кілька COUNT по posts, дешево.
  intervalMin: optionalNumber("FLOW_HEALTH_INTERVAL_MIN", process.env.FLOW_HEALTH_INTERVAL_MIN, 10),
  // Найстаріший pending старший за це — застій (якщо квота не вичерпана:
  // тоді бэклог чекає скидання за дизайном). Бэклог у кілька сотень постів
  // на безкоштовному тирі розбирається за ~півгодини.
  pendingMaxAgeMin: optionalNumber("FLOW_HEALTH_PENDING_MAX_AGE_MIN", process.env.FLOW_HEALTH_PENDING_MAX_AGE_MIN, 120),
  // Вікно для частки failed. Пілот 2026-09-29 валив КОЖЕН запит годинами,
  // а pending при цьому не старішали — постів ставали failed, не застрягали.
  failureWindowMin: optionalNumber("FLOW_HEALTH_FAILURE_WINDOW_MIN", process.env.FLOW_HEALTH_FAILURE_WINDOW_MIN, 60),
  failureMin: optionalNumber("FLOW_HEALTH_FAILURE_MIN", process.env.FLOW_HEALTH_FAILURE_MIN, 5),
  failureShare: optionalNumber("FLOW_HEALTH_FAILURE_SHARE", process.env.FLOW_HEALTH_FAILURE_SHARE, 0.5),
  // Жодного нового flow-поста стільки годин — мертвий канал або зламаний
  // polling (питання S3, ROADMAP §1.2).
  ingestSilentHours: optionalNumber("FLOW_HEALTH_INGEST_SILENT_HOURS", process.env.FLOW_HEALTH_INGEST_SILENT_HOURS, 24),
  // Нагадування, поки проблема не зникла. Одне повідомлення на перехід, не на тік.
  repeatHours: optionalNumber("FLOW_HEALTH_REPEAT_HOURS", process.env.FLOW_HEALTH_REPEAT_HOURS, 6),
};

// Per-provider: ключ, model id-и, endpoint, ліміти. Усе з env. Модель, у якої
// embedModel === null, не оголошує capability `embed` — gateway маршрутизує
// `embed()` на іншого провайдера або деградує до tier 1 (ROADMAP 3.1).
/**
 * Ліміти на модель. Google рахує RPM/RPD окремо для кожної моделі (у AI Studio
 * кожна — свій рядок), тож flash-lite і embedding-2 — два незалежні бюджети.
 * Моделі, що збігаються (vision на тій самій моделі, що й complete), зливаються
 * в один запис — і ділять лічильник, як і в Google.
 *
 * @param {Array<[model: string|null, limits: {rpd: number, rpm: number}]>} pairs
 *   Порядок має значення: перший запис для моделі виграє.
 */
function modelLimits(pairs) {
  const out = {};
  for (const [model, limits] of pairs) {
    if (model && !(model in out)) out[model] = limits;
  }
  return out;
}

const GEMINI_COMPLETE = process.env.GEMINI_COMPLETE_MODEL || "gemini-3.5-flash-lite";
const GEMINI_VISION = process.env.GEMINI_VISION_MODEL || GEMINI_COMPLETE;
const GEMINI_EMBED = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2";

export const LLM_PROVIDERS = {
  gemini: {
    apiKey:        process.env.GEMINI_API_KEY || null,
    baseUrl:       process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    // gemini-3.5-flash-lite, НЕ gemini-2.5-flash. Безкоштовний тир (AI Studio,
    // 2026-09-13): 2.5-flash — RPD 20, RPM 5; flash-lite — RPD 500, RPM 15.
    // 20 запитів на добу пілот із трьох каналів вичерпав би за годину.
    // Перевірено реальними викликами: flash-lite повертає JSON за schema і
    // правильно читає код зі зображення — тож годиться і для enrich, і для vision.
    completeModel: GEMINI_COMPLETE,
    // gemini-embedding-2, НЕ text-embedding-004: той вимкнено 14.01.2026.
    // Старий дефолт не падав, а тихо псував: 404 класифікується як
    // bad_response (breaker не відкривається), але quota.bump() іде ДО запиту,
    // тож кожен пост спалював RPD на гарантований 404 і отримував
    // embedding = null. Для embedding-2 task_type не передається — модель
    // його відхиляє; інструкції задачі йдуть у сам текст.
    embedModel:    GEMINI_EMBED,
    visionModel:   GEMINI_VISION,
    // Закріплено явно (ROADMAP 13.2): дефолт моделі — 3072, і він може
    // змінитись. 768 — одне з рекомендованих значень; провайдер нормалізує
    // вектор сам, тож це безпечно і для embedding-001, де нормалізація ручна.
    embedDim:      Number(process.env.GEMINI_EMBED_DIM || 768),
    // Дефолти — виміряні ліміти безкоштовного тиру (AI Studio, 2026-09-13).
    // Платний проєкт має вищі: там ці числа просто недовикористовують квоту,
    // а не перевищують її — безпечний бік.
    // rpd/rpm — ліміти complete-моделі (і vision, якщо модель та сама); вони ж
    // фолбек для моделі без власного запису, напр. tier-up.
    rpd:           Number(process.env.GEMINI_RPD || 500),
    rpm:           Number(process.env.GEMINI_RPM || 15),
    modelLimits: modelLimits([
      [GEMINI_COMPLETE, {
        rpd: Number(process.env.GEMINI_RPD || 500),
        rpm: Number(process.env.GEMINI_RPM || 15),
      }],
      [GEMINI_VISION, {
        rpd: Number(process.env.GEMINI_VISION_RPD || process.env.GEMINI_RPD || 500),
        rpm: Number(process.env.GEMINI_VISION_RPM || process.env.GEMINI_RPM || 15),
      }],
      [GEMINI_EMBED, {
        rpd: Number(process.env.GEMINI_EMBED_RPD || 1_000),
        rpm: Number(process.env.GEMINI_EMBED_RPM || 100),
      }],
    ]),
    // Google скидає RPD опівночі за тихоокеанським часом, не UTC
    // (ai.google.dev/gemini-api/docs/rate-limits). Реєстр квоти рахує добу тут.
    quotaTimeZone: quotaTimeZone("GEMINI_QUOTA_TZ", process.env.GEMINI_QUOTA_TZ, "America/Los_Angeles"),
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
    // Не звірено з документацією OpenRouter — задайте, якщо ліміти вашого
    // акаунта скидаються не за UTC.
    quotaTimeZone: quotaTimeZone("OPENROUTER_QUOTA_TZ", process.env.OPENROUTER_QUOTA_TZ, "UTC"),
  },
};

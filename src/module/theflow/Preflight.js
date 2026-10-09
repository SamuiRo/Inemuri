import fs from "fs";
import path from "path";

import database from "../teapot/sqlite/sqlite_db.js";
import { Source, KnowledgeExample } from "../teapot/models/index.js";
import {
  NODE_ENV, CONFIG_WARNINGS, CATEGORIES, ROUTING, FLOW_TRIAGE, FLOW_DELIVERY,
  ENRICH_WORKER_ENABLED, LLM_PRIMARY, LLM_FALLBACK, LLM_PROVIDERS,
  TELEGRAM_SESSION, TELEGRAM_API_ID, CRON_CONFIG, DAILY_REPORT, DISCORD_USER_TOKEN,
} from "../../config/app.config.js";
import { destinationIdProblems } from "../../shared/destinations.js";
import { usesTriage } from "../../sources/feeds/discovery.js";
import { validateRouting } from "./ResolveStage.js";

/**
 * Перевірка готовності розгортання (`flow preflight`): чи заповнено все, без
 * чого TheFlow і новинні джерела не запрацюють або працюватимуть не так.
 * Запускається після деплою на сервері, до `pm2 start`, і будь-коли потім.
 *
 * Збирання (collectPreflight) — окремо від оцінки (assessPreflight, чиста):
 * так оцінку легко тестувати, а збирання бачить лише те, що бачить процес.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "database", "migrations");
const MIGRATION_RE = /^\d{3}-.*\.js$/;

const destinationCount = (d) => Object.values(d ?? {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);

/** Стан конфігурації й бази — лише факти, без висновків. */
export async function collectPreflight() {
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_RE.test(f)).sort().map((f) => f.replace(/\.js$/, ""))
    : [];
  let applied = [];
  try {
    [applied] = await database.sequelize.query("SELECT `name` FROM `schema_migrations`");
  } catch {
    applied = []; // журналу ще немає — жодна міграція не застосована
  }
  const appliedNames = new Set(applied.map((r) => r.name));

  const sources = (await Source.findAll({ where: { is_active: true } })).map((s) => ({
    name: s.channel_name,
    platform: s.platform,
    mode: s.mode,
    flow: s.isFlowEnabled(),
    triage: usesTriage(s),
    // Класичне пересилання шле сюди; flow-джерело — ні, але повернеться сюди.
    destinationProblems: destinationIdProblems(s.getAllDestinations(), `source "${s.channel_name}"`),
  }));

  const knowledge = await KnowledgeExample.count();
  const triageExamples = await KnowledgeExample.count({
    where: { level: ["headline", "post"], verdict: ["good", "missed", "noise"] },
  });

  const primary = LLM_PROVIDERS[LLM_PRIMARY];
  const fallback = LLM_FALLBACK ? LLM_PROVIDERS[LLM_FALLBACK] : null;

  return {
    nodeEnv: NODE_ENV,
    pendingMigrations: files.filter((f) => !appliedNames.has(f)),
    migrationCount: files.length,
    llm: {
      workerEnabled: ENRICH_WORKER_ENABLED,
      primary: LLM_PRIMARY,
      primaryKey: Boolean(primary?.apiKey),
      fallback: LLM_FALLBACK,
      fallbackKey: Boolean(fallback?.apiKey),
    },
    telegram: { session: Boolean(TELEGRAM_SESSION), apiId: Number.isFinite(TELEGRAM_API_ID) && TELEGRAM_API_ID > 0 },
    discord: { userToken: Boolean(DISCORD_USER_TOKEN) },
    // Лише «немає файлу — взято семпл»: саме це означає «не налаштовано».
    configFallbacks: CONFIG_WARNINGS
      .map((w) => w.match(/^(\S+)\.json not found/)?.[1] ?? (w.includes("neither") ? w : null))
      .filter(Boolean),
    triageProfile: {
      version: FLOW_TRIAGE.profile?.version ?? 0,
      areas: Object.keys(FLOW_TRIAGE.profile?.areas ?? {}).length,
    },
    taxonomyVersion: CATEGORIES?.version ?? null,
    sources,
    routing: {
      unsorted: destinationCount(ROUTING.unsorted_destinations),
      health: destinationCount(ROUTING.health_destinations),
      digest: destinationCount(ROUTING.digest_destinations),
      status: destinationCount(ROUTING.status_destinations),
      rules: Array.isArray(ROUTING.routing) ? ROUTING.routing.length : 0,
      problems: validateRouting(ROUTING, CATEGORIES),
    },
    deliveryEnabled: FLOW_DELIVERY.enabled,
    // Щоденний звіт: куди він піде. Семпл cronjob.config має id-заглушки.
    cron: {
      dailyEnabled: DAILY_REPORT.enabled,
      daily: destinationCount(CRON_CONFIG.dailyinfo?.destinations),
      problems: destinationIdProblems(CRON_CONFIG.dailyinfo?.destinations, "cronjob.config dailyinfo"),
    },
    knowledge,
    triageExamples,
  };
}

/**
 * Висновки. Чиста функція.
 *
 * @returns {{ ok: boolean, items: Array<{ level: "ok"|"warn"|"fail", key: string, message: string }> }}
 *   ok — немає жодного `fail`.
 */
export function assessPreflight(s) {
  const items = [];
  const ok = (key, message) => items.push({ level: "ok", key, message });
  const warn = (key, message) => items.push({ level: "warn", key, message });
  const fail = (key, message) => items.push({ level: "fail", key, message });

  // ── Середовище і схема ─────────────────────────────────────────────
  if (s.nodeEnv === "production") ok("node_env", "NODE_ENV=production");
  else fail("node_env", `NODE_ENV=${s.nodeEnv ?? "(unset)"} — must be production: under development the database is recreated`);

  if (s.pendingMigrations.length) fail("migrations", `${s.pendingMigrations.length} pending migration(s): ${s.pendingMigrations.join(", ")} — run npm run migrate (service stopped)`);
  else ok("migrations", `all ${s.migrationCount} migrations applied`);

  const telegramSources = s.sources.filter((x) => x.platform === "telegram").length;
  if (telegramSources && !(s.telegram.session && s.telegram.apiId)) {
    fail("telegram", `${telegramSources} Telegram source(s), but TELEGRAM_SESSION / TELEGRAM_API_ID are not set`);
  }
  // Без токена джерело Discord не стартує зовсім — лише рядок у лозі на старті.
  const discordSources = s.sources.filter((x) => x.platform === "discord").length;
  if (discordSources && !s.discord?.userToken) {
    fail("discord", `${discordSources} Discord source(s), but DISCORD_USER_TOKEN is not set`);
  }

  // ── TheFlow і модель ──────────────────────────────────────────────
  const flow = s.sources.filter((x) => x.flow);
  const triage = s.sources.filter((x) => x.triage);
  if (flow.length && !(s.llm.workerEnabled && s.llm.primaryKey)) {
    fail("llm", `${flow.length} flow source(s), but the enrich worker will not start: ` +
      (!s.llm.workerEnabled ? "ENRICH_WORKER_ENABLED=false" : `no ${s.llm.primary} API key`) +
      (triage.length ? " — triage runs inside it, so news would only pile up" : ""));
  } else if (flow.length) {
    ok("llm", `enrich worker will start (${s.llm.primary})`);
  }
  if (s.llm.fallback && !s.llm.fallbackKey) {
    // Провайдер без ключа просто вимкнений (BaseProvider.capabilities), тож це
    // не збій — але й запасного шляху немає.
    warn("llm_fallback", `LLM_FALLBACK=${s.llm.fallback} has no API key, so there is no fallback: ` +
      `when the ${s.llm.primary} quota runs out, enrichment and triage wait for the reset`);
  }

  // ── Конфіги розгортання ───────────────────────────────────────────
  // Семпл замість routing.json чи cronjob.config.json — це доставка на
  // вигадані id: усе, що туди піде, відкине Discord («Unknown Channel») чи
  // Telegram. Тому блокер, а не попередження.
  const DELIVERY_CONFIGS = new Set(["routing", "cronjob.config"]);
  for (const name of s.configFallbacks) {
    if (name === "triage" && triage.length) {
      fail("config_triage", "triage.json is missing — triage would judge headlines against the sample profile; copy and fill it");
    } else if (DELIVERY_CONFIGS.has(name)) {
      fail(`config_${name}`, `${name}.json is missing — running on ${name}.sample.json, whose destination ids do not exist; copy the real one`);
    } else {
      warn(`config_${name}`, `${name}.json is missing — running on ${name}.sample.json`);
    }
  }
  if (triage.length) {
    if (s.triageProfile.areas === 0) fail("triage_profile", "the triage profile has no areas");
    else ok("triage_profile", `triage profile v${s.triageProfile.version}, ${s.triageProfile.areas} area(s)`);
  }

  // ── Джерела ───────────────────────────────────────────────────────
  ok("sources", `${s.sources.length} active source(s): ${flow.length} flow, ${triage.length} with headline triage`);
  const sourceIdProblems = s.sources.flatMap((x) => x.destinationProblems ?? []);
  if (sourceIdProblems.length) {
    fail("source_ids", `${sourceIdProblems.length} source destination id(s) no platform accepts: ${sourceIdProblems.slice(0, 5).join("; ")}`);
  }
  // Лише Telegram: у Discord-джерела polling немає (історію читати поки ні).
  const listeners = flow.filter((x) => x.mode === "listener" && x.platform === "telegram");
  if (listeners.length) {
    warn("flow_listener", `${listeners.length} flow source(s) in pure listener mode lose posts while the service is down — ` +
      "set mode to both or polling (ROADMAP 1.1a)");
  }

  // ── Доставка і нагляд ─────────────────────────────────────────────
  if (s.deliveryEnabled) warn("delivery", "FLOW_DELIVERY_ENABLED=true — this is not shadow mode, verdicts are delivered");
  else if (s.routing.rules > 0) {
    // Правила є — отже, канали чекають постів. Тіньовий режим тут найчастіше
    // забута змінна, а не намір: пости збагачуються і нікуди не йдуть.
    warn("delivery", `delivery off (FLOW_DELIVERY_ENABLED is not true) but routing.json has ${s.routing.rules} rule(s) — ` +
      "enriched posts reach no channel; set FLOW_DELIVERY_ENABLED=true when that is intended");
  } else ok("delivery", "delivery off — shadow mode, nothing is sent");
  if (s.routing.digest && !s.deliveryEnabled) {
    warn("digest", `digest_destinations set (${s.routing.digest}) — the daily digest is sent even in shadow mode`);
  }
  if (flow.length && !s.routing.health) warn("health", "no health_destinations — stall and failure alerts go to the log only");
  else if (flow.length) ok("health", `health alerts to ${s.routing.health} destination(s)`);
  if (s.routing.status) ok("status", `status board to ${s.routing.status} destination(s)`);

  // routing.json: id, яких платформа не прийме (заглушки до створення каналу),
  // — блокер: туди нічого не дійде. Решта — попередження, як і на старті.
  const problems = s.routing.problems ?? [];
  const badIds = problems.filter((p) => p.includes("is not a valid"));
  const other = problems.filter((p) => !p.includes("is not a valid"));
  if (badIds.length) fail("routing_ids", `routing.json has ${badIds.length} destination id(s) no platform accepts: ${badIds.slice(0, 5).join("; ")}`);
  if (other.length) warn("routing", `routing.json: ${other.slice(0, 5).join("; ")}`);
  if (!problems.length) ok("routing", `routing.json: ${s.routing.rules} rule(s), no problems`);

  // ── Cron ─────────────────────────────────────────────────────────
  if (s.cron?.dailyEnabled) {
    if (s.cron.problems.length) {
      fail("cron_ids", `daily report destination id(s) no platform accepts: ${s.cron.problems.slice(0, 5).join("; ")}`);
    } else if (!s.cron.daily) {
      warn("cron", "daily report enabled but cronjob.config.json has no dailyinfo destinations — it goes nowhere (DAILY_REPORT_ENABLED=false to turn it off)");
    } else {
      ok("cron", `daily report to ${s.cron.daily} destination(s)`);
    }
  }

  // ── Знання ────────────────────────────────────────────────────────
  if (triage.length && !s.triageExamples) {
    warn("knowledge", "the knowledge base has no examples for triage — import the operator's examples (flow knowledge import)");
  } else {
    ok("knowledge", `knowledge base: ${s.knowledge} example(s), ${s.triageExamples} usable by triage`);
  }
  ok("taxonomy", `categories.json v${s.taxonomyVersion}`);

  return { ok: !items.some((i) => i.level === "fail"), items };
}

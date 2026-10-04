import fs from "fs";
import path from "path";

import database from "../teapot/sqlite/sqlite_db.js";
import { Source, KnowledgeExample } from "../teapot/models/index.js";
import {
  NODE_ENV, CONFIG_WARNINGS, CATEGORIES, ROUTING, FLOW_TRIAGE, FLOW_DELIVERY,
  ENRICH_WORKER_ENABLED, LLM_PRIMARY, LLM_FALLBACK, LLM_PROVIDERS,
  TELEGRAM_SESSION, TELEGRAM_API_ID,
} from "../../config/app.config.js";
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
  for (const name of s.configFallbacks) {
    if (name === "triage" && triage.length) {
      fail("config_triage", "triage.json is missing — triage would judge headlines against the sample profile; copy and fill it");
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
  const listeners = flow.filter((x) => x.mode === "listener");
  if (listeners.length) {
    warn("flow_listener", `${listeners.length} flow source(s) in pure listener mode lose posts while the service is down — ` +
      "set mode to both or polling (ROADMAP 1.1a)");
  }

  // ── Доставка і нагляд ─────────────────────────────────────────────
  if (s.deliveryEnabled) warn("delivery", "FLOW_DELIVERY_ENABLED=true — this is not shadow mode, verdicts are delivered");
  else ok("delivery", "delivery off — shadow mode, nothing is sent");
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

  // ── Знання ────────────────────────────────────────────────────────
  if (triage.length && !s.triageExamples) {
    warn("knowledge", "the knowledge base has no examples for triage — import the operator's examples (flow knowledge import)");
  } else {
    ok("knowledge", `knowledge base: ${s.knowledge} example(s), ${s.triageExamples} usable by triage`);
  }
  ok("taxonomy", `categories.json v${s.taxonomyVersion}`);

  return { ok: !items.some((i) => i.level === "fail"), items };
}

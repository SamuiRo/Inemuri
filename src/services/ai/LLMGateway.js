import crypto from "crypto";

import { print } from "../../shared/utils.js";
import { ProviderQuota } from "../../module/teapot/models/index.js";
import {
  LLM_PRIMARY,
  LLM_FALLBACK,
  LLM_TIER_UP,
  LLM_TIER_UP_BELOW,
  LLM_MAX_CONCURRENCY,
  LLM_TIMEOUT_MS,
  LLM_CACHE_TTL_MS,
  LLM_CACHE_MAX_SIZE,
  LLM_QUOTA_RESERVE,
  LLM_PROVIDERS,
} from "../../config/app.config.js";
import { TokenBucket, CircuitBreaker, TtlCache } from "./internal.js";
import { validateEnrichResponse } from "./schemas.js";
import { buildEnrichPrompt, ENRICH_PROMPT_VERSION } from "./prompts/enrich.js";
import { buildVisionPrompt, validateVisionResponse } from "./prompts/vision.js";
import { buildDeltaPrompt, validateDeltaResponse } from "./prompts/delta.js";
import { buildTriagePrompt, validateTriageResponse } from "./prompts/triage.js";
import { buildTranslatePrompt, validateTranslateResponse } from "./prompts/translate.js";
import { GeminiProvider } from "./providers/GeminiProvider.js";
import { OpenAICompatProvider } from "./providers/OpenAICompatProvider.js";

/**
 * TheFlow — LLM gateway (ROADMAP §3.5, LLM_GATEWAY.md).
 *
 * The pipeline sees only enrich() / embed() / vision() / delta() / triage(). Everything else —
 * provider selection, RPM token buckets, the persistent RPD ledger, per-
 * provider circuit breakers, a TTL cache, a priority queue with a concurrency
 * cap, the fallback matrix, tiering, and priority shedding — lives here.
 *
 *   enrich(input, { priority }) -> { value, model_used, discarded, ... }
 *                                | { shed: true }        (deferred, not an error)
 *                                | throws (kind: bad_response | unavailable | ...)
 *   embed(text,  { priority })  -> { vector, model, dim } | { shed: true }
 *                                | null   (no embed provider — degrade to tier 1)
 *
 * The gateway imports nothing from Telegram, Discord, or the pipeline.
 */

const PRIORITIES = ["critical", "normal", "low"];

// Текст джерела для перевірки дослівності: заголовок (Reddit, новини) — теж
// текст джерела, код чи тікер із нього не вигадка моделі.
const sourceText = (input) => [input.title, input.text].filter((s) => s && String(s).trim() !== "").join("\n");

export class LLMGateway {
  constructor(opts = {}) {
    this.quota = opts.quota ?? ProviderQuota;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
    this.tierUpBelow = opts.tierUpBelow ?? LLM_TIER_UP_BELOW;
    this.quotaReserve = opts.quotaReserve ?? LLM_QUOTA_RESERVE;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? LLM_MAX_CONCURRENCY);
    this.tierUp = opts.tierUp ?? LLM_TIER_UP; // stronger model id, or null

    const metas = opts.providersMeta ?? LLM_PROVIDERS;
    const instances = opts.providers ?? LLMGateway._buildProviders(metas);

    // name -> { provider, meta, breaker }
    //
    // Breaker — на провайдера: недоступний провайдер недоступний для всіх
    // своїх моделей. А квота й RPM — на МОДЕЛЬ: Google рахує їх окремо для
    // кожної (в AI Studio кожна модель — свій рядок), тож flash-lite з RPD 500
    // і embedding-2 з RPD 1000 — два незалежні бюджети. Спільний лічильник на
    // провайдера вдвічі занижував би пропускну здатність: пост — це enrich і
    // embed, і обидва списувались би з одного бюджету.
    this.providers = new Map();
    for (const [name, provider] of Object.entries(instances)) {
      const meta = metas[name] ?? {};
      this.providers.set(name, {
        provider,
        meta,
        breaker: new CircuitBreaker({ now: this.now }),
      });
    }
    this._buckets = new Map(); // quotaKey -> TokenBucket

    this.order = (opts.order ?? [LLM_PRIMARY, LLM_FALLBACK]).filter(Boolean);

    this.cache = new TtlCache({
      ttlMs: opts.cacheTtlMs ?? LLM_CACHE_TTL_MS,
      maxSize: opts.cacheMaxSize ?? LLM_CACHE_MAX_SIZE,
      now: this.now,
    });

    this._lanes = { critical: [], normal: [], low: [] };
    this._inFlight = 0;
  }

  static _buildProviders(metas) {
    const out = {};
    if (metas.gemini) out.gemini = new GeminiProvider(metas.gemini);
    if (metas.openrouter) out.openrouter = new OpenAICompatProvider("openrouter", metas.openrouter);
    return out;
  }

  // ── public API ─────────────────────────────────────────────────

  async enrich(input, { priority = "critical" } = {}) {
    return this._enqueue(priority, () => this._enrich(input, priority));
  }

  async embed(text, { priority = "critical" } = {}) {
    return this._enqueue(priority, () => this._embed(text, priority));
  }

  /**
   * Транскрипція зображення (VISION.md). Спільна з enrich квота, breaker і
   * rate limit на провайдера — інакше vision тихо з'їдав би добовий ліміт і
   * збагачення звичайних постів падало б як «класифікація зламалась».
   *
   * Пріоритет за замовчуванням `normal`, нижче за enrich (`critical`): під
   * тиском квоти першим скидається vision.
   *
   * @param {{data: Buffer, mimeType: string}} image  Уже зменшене зображення.
   * @returns {Promise<{text_ocr, description, legible, model, blocked}|{shed: true}|null>}
   *   null — жоден провайдер не має capability vision (стадію просто пропускають).
   */
  async vision(image, { priority = "normal" } = {}) {
    if (this._candidates("vision").length === 0) return null;
    return this._enqueue(priority, () => this._vision(image, priority));
  }

  /**
   * Що новий пост кластера додає до канонічного (ROADMAP §6.6,
   * DEDUPLICATION.md «Step 2»). Пріоритет `normal`: доповнення може
   * почекати, під тиском квоти воно поступається enrich — повертається shed,
   * і стадія спробує пізніше.
   *
   * @param {{ canonical: string, candidate: string }} input  Обидва — text_en.
   * @returns {Promise<{relation, adds, confidence, model_used}|{shed: true}>}
   */
  async delta(input, { priority = "normal" } = {}) {
    return this._enqueue(priority, () => this._delta(input, priority));
  }

  async _delta(input, priority) {
    const key = "delta:" + this._hash(JSON.stringify({ a: this._norm(input.canonical), b: this._norm(input.candidate) }));
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const prompt = buildDeltaPrompt({ canonical: input.canonical, candidate: input.candidate });
    const run = await this._runComplete(prompt, priority, {});
    if (run.shed) return run;

    const checked = validateDeltaResponse(run.parsed);
    if (!checked.ok) {
      const err = new Error(`delta: invalid response — ${checked.errors.join("; ")}`);
      err.kind = "bad_response";
      throw err;
    }
    const result = { ...checked.value, model_used: run.model };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Переклад українською для доставки (prompts/translate.js). Окремий виклик,
   * не поле enrich, і лише для поста, що справді йде в канал. Пріоритет
   * `normal`: під тиском квоти поступається enrich — shed, і доставка бере
   * оригінал.
   *
   * @param {{ text: string, title?: string|null }} input  raw_text поста.
   * @returns {Promise<{ text_uk: string, model_used: string }|{ shed: true }>}
   */
  async translate(input, { priority = "normal" } = {}) {
    return this._enqueue(priority, () => this._translate(input, priority));
  }

  async _translate(input, priority) {
    // Ключ — точний текст, не _norm: регістр промокоду в перекладі має збігтися з джерелом.
    const key = "translate:" + this._hash(JSON.stringify({ t: String(input.text ?? ""), h: String(input.title ?? "") }));
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const run = await this._runComplete(buildTranslatePrompt({ text: input.text, title: input.title }), priority, {});
    if (run.shed) return run;

    const checked = validateTranslateResponse(run.parsed);
    if (!checked.ok) {
      const err = new Error(`translate: invalid response — ${checked.errors.join("; ")}`);
      err.kind = "bad_response";
      throw err;
    }
    const result = { text_uk: checked.value, model_used: run.model };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Triage заголовків новин пакетом (NEWS_INTAKE.md §2.3). Пріоритет
   * `normal`: заголовки можуть почекати, під тиском квоти поступаються
   * enrich — shed, і стадія спробує пізніше.
   *
   * @param {{ items: object[], profile: object, examples?: object[], examplesHash?: string|null }} input
   * @returns {Promise<{ decisions: Array<{ index, relevant, area, reason }>, model_used }|{ shed: true }>}
   *   decisions — лише для кандидатів, на які модель коректно відповіла.
   */
  async triage(input, { priority = "normal" } = {}) {
    return this._enqueue(priority, () => this._triage(input, priority));
  }

  async _triage(input, priority) {
    const key = "triage:" + this._hash(JSON.stringify({
      i: input.items.map((it) => [this._norm(it.title), this._norm(it.teaser), it.section ?? null]),
      p: input.profile?.version ?? null,
      x: input.examplesHash ?? null,
    }));
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const prompt = buildTriagePrompt({ items: input.items, profile: input.profile, examples: input.examples });
    const run = await this._runComplete(prompt, priority, {});
    if (run.shed) return run;

    const checked = validateTriageResponse(run.parsed, {
      count: input.items.length,
      areas: Object.keys(input.profile?.areas ?? {}),
    });
    if (!checked.ok) {
      const err = new Error(`triage: invalid response — ${checked.errors.join("; ")}`);
      err.kind = "bad_response";
      throw err;
    }
    const result = { decisions: checked.value, model_used: run.model };
    this.cache.set(key, result);
    return result;
  }

  get cacheSize() {
    return this.cache.size;
  }

  // ── priority queue ─────────────────────────────────────────────

  _enqueue(priority, taskFn) {
    const lane = this._lanes[priority] ?? this._lanes.normal;
    return new Promise((resolve, reject) => {
      lane.push({ taskFn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._inFlight < this.maxConcurrency) {
      const job = this._nextJob();
      if (!job) return;
      this._inFlight += 1;
      Promise.resolve()
        .then(job.taskFn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this._inFlight -= 1;
          this._drain();
        });
    }
  }

  _nextJob() {
    for (const p of PRIORITIES) {
      if (this._lanes[p].length) return this._lanes[p].shift();
    }
    return null;
  }

  /**
   * День квоти в поясі, де провайдер скидає добовий ліміт. Фейкові реєстри в
   * тестах не мають today() — тоді undefined, і реєстр бере свій дефолт.
   */
  _quotaDay(entry) {
    return this.quota.today?.(entry.meta?.quotaTimeZone ?? "UTC");
  }

  // ── routing helpers ────────────────────────────────────────────

  _candidates(capability) {
    const out = [];
    for (const name of this.order) {
      const entry = this.providers.get(name);
      if (entry && entry.provider.capabilities()[capability]) out.push(entry);
    }
    return out;
  }

  // ── per-model quota ────────────────────────────────────────────

  /** Яку модель використає виклик цієї capability на цьому провайдері. */
  _modelFor(entry, capability, modelOverride = null) {
    const c = entry.provider.config ?? {};
    if (capability === "embed") return c.embedModel ?? null;
    if (capability === "vision") return c.visionModel ?? null;
    return modelOverride ?? c.completeModel ?? null;
  }

  /**
   * Ліміти моделі. Спершу `meta.modelLimits[model]`, інакше ліміти провайдера
   * (`meta.rpd` / `meta.rpm`) — для моделі без власного запису, напр. tier-up.
   */
  _limitsFor(entry, model) {
    const own = model ? entry.meta.modelLimits?.[model] : null;
    return {
      rpd: own?.rpd ?? entry.meta.rpd ?? Infinity,
      rpm: own?.rpm ?? entry.meta.rpm ?? 12,
    };
  }

  /**
   * Ключ у реєстрі квоти: `provider:model`. Без моделі — лише провайдер.
   * Колонка `provider` у provider_quota — рядок, тож складений ключ не
   * потребує міграції.
   */
  _quotaKey(entry, model) {
    return model ? `${entry.provider.name}:${model}` : entry.provider.name;
  }

  _bucketFor(entry, model) {
    const key = this._quotaKey(entry, model);
    if (!this._buckets.has(key)) {
      // Сплеск — не більше секунди ліміту (для 15 RPM це 1, рівний темп).
      // Повне відро на 15 RPM пропускало 30 запитів у першу хвилину, і Gemini
      // відповідав 429 (пілот 2026-09-30).
      const { rpm } = this._limitsFor(entry, model);
      this._buckets.set(key, new TokenBucket(rpm, this.now, { burst: Math.max(1, Math.ceil(rpm / 60)) }));
    }
    return this._buckets.get(key);
  }

  async _gate(entry, priority, model = null) {
    if (!entry.breaker.allow()) return "circuit open";

    const { rpd } = this._limitsFor(entry, model);
    const used = await this.quota.used(this._quotaKey(entry, model), this._quotaDay(entry));
    if (used >= rpd) return "quota exhausted";

    if (priority !== "critical" && rpd !== Infinity) {
      if (rpd - used <= rpd * this.quotaReserve) return "shed";
    }
    return "ok";
  }

  // ── enrich ────────────────────────────────────────────────────

  async _enrich(input, priority) {
    const taxonomy = input.taxonomy;
    const key = "enrich:" + this._hash(JSON.stringify({
      t: this._norm(input.text),
      h: this._norm(input.title),
      d: input.postedAt ? new Date(input.postedAt).toISOString().slice(0, 10) : null,
      // Інший набір прикладів — інший промпт: кешований вердикт не підходить.
      x: input.examplesHash ?? null,
      o: this._norm(input.textOcr),
      c: input.candidates ?? {},
      v: taxonomy?.version ?? null,
      // Інший промпт (нові поля, інші правила) — кешований вердикт не підходить.
      pv: ENRICH_PROMPT_VERSION,
    }));
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const prompt = buildEnrichPrompt({
      text: input.text,
      title: input.title,
      postedAt: input.postedAt,
      examples: input.examples,
      candidates: input.candidates,
      textOcr: input.textOcr,
      taxonomy,
    });

    const run = await this._runComplete(prompt, priority, {});
    if (run.shed) return run;

    const validated = validateEnrichResponse(run.parsed, { taxonomy, rawText: sourceText(input), textOcr: input.textOcr });
    if (!validated.ok) {
      const err = new Error(`enrich: invalid response — ${validated.errors.join("; ")}`);
      err.kind = "bad_response";
      throw err;
    }

    let result = {
      value: validated.value,
      model_used: run.model,
      discarded: validated.discarded,
      unverified: validated.unverified,
    };

    // Tiering (NOT fallback): re-run a low-confidence verdict on a stronger
    // model, once. A failure here keeps the base verdict.
    if (this.tierUp && Number(validated.value.confidence) < this.tierUpBelow) {
      try {
        const tierRun = await this._runComplete(prompt, priority, { modelOverride: this.tierUp });
        if (!tierRun.shed) {
          const tv = validateEnrichResponse(tierRun.parsed, { taxonomy, rawText: sourceText(input), textOcr: input.textOcr });
          if (tv.ok) {
            result = { value: tv.value, model_used: tierRun.model, discarded: tv.discarded, unverified: tv.unverified, tiered: true };
          }
        }
      } catch (err) {
        print(`[LLM] tier-up failed, keeping base verdict: ${err.message}`, "debug");
      }
    }

    this.cache.set(key, result);
    return result;
  }

  async _runComplete(prompt, priority, { modelOverride } = {}) {
    return this._runWithFallback("complete", priority, { modelOverride }, async (entry) => {
      const provider = modelOverride
        ? this._withModel(entry.provider, modelOverride)
        : entry.provider;
      const res = await provider.complete(
        { system: prompt.system, user: prompt.user },
        { schema: prompt.responseSchema, temperature: 0, timeoutMs: this.timeoutMs },
      );
      return { parsed: this._parseJson(res.text), model: res.model };
    });
  }

  /**
   * Матриця fallback (LLM_GATEWAY.md), спільна для complete і vision.
   *
   * Винесена, а не скопійована: це найпідступніша частина gateway — квота,
   * breaker, rate limit, повтор bad_response, перехід на наступного
   * провайдера — і дві копії розійшлися б при першій же правці.
   *
   * @param {string} capability  complete | vision
   * @param {string} priority
   * @param {(entry) => Promise<object>} invoke  Робить виклик і повертає
   *   результат; кидає класифіковану помилку. Розбір JSON — теж тут, щоб
   *   невалідна відповідь проходила як bad_response і отримувала свій повтор.
   */
  async _runWithFallback(capability, priority, { modelOverride = null } = {}, invoke) {
    const cands = this._candidates(capability);
    if (cands.length === 0) throw this._unavailable(capability);

    let lastErr;
    const refused = [];
    for (const entry of cands) {
      const model = this._modelFor(entry, capability, modelOverride);
      const quotaKey = this._quotaKey(entry, model);
      const gate = await this._gate(entry, priority, model);
      if (gate === "shed") return { shed: true, reason: "quota reserve" };
      if (gate !== "ok") {
        refused.push(`${entry.provider.name}: ${gate}`);
        continue;
      }

      // One retry on the same provider for rate_limit / bad_response before
      // moving to the next (fallback matrix, LLM_GATEWAY.md).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this._bucketFor(entry, model).take(this.sleep);
          await this.quota.bump(quotaKey, this._quotaDay(entry));
          const result = await invoke(entry);
          entry.breaker.recordSuccess();
          return result;
        } catch (err) {
          lastErr = err;
          const kind = err.kind ?? "server";
          if (kind === "quota") {
            await this.quota.markExhausted(quotaKey, this._quotaDay(entry));
            break;
          }
          if (kind === "server" || kind === "network") {
            entry.breaker.recordFailure();
            break;
          }
          if (kind === "rate_limit") {
            // Скільки просить провайдер (Gemini: RetryInfo, ~20–60 с), але не
            // більше хвилини; без підказки — коротка пауза, як раніше.
            const hinted = Number.isFinite(err.retryAfterMs) ? Math.min(err.retryAfterMs, 60_000) : 0;
            await this.sleep(Math.max(500 * (attempt + 1), hinted));
            continue;
          }
          if (attempt === 0) continue; // bad_response: one retry
          break;
        }
      }
    }
    // Жоден провайдер не був викликаний: усі відмовили на вході (breaker
    // відкритий, денна квота). Це не збій поста, а «зараз не можна» — як
    // shed. Раніше тут летіла помилка, і воркер списував спробу: на
    // вичерпаній квоті кожен тік брав 10 найстаріших pending і за три тіки
    // робив їх failed, поки не спалив би всю чергу.
    if (!lastErr && refused.length) return { shed: true, reason: refused.join("; ") };
    throw lastErr ?? this._unavailable(capability);
  }


  // ── vision ───────────────────────────────────────────────────

  async _vision(image, priority) {
    const prompt = buildVisionPrompt();
    return this._runWithFallback("vision", priority, {}, async (entry) => {
      const res = await entry.provider.vision(image, {
        system: prompt.system,
        user: prompt.user,
        schema: prompt.responseSchema,
        temperature: prompt.settings.temperature,
        timeoutMs: this.timeoutMs,
      });
      const checked = validateVisionResponse(this._parseJson(res.text));
      if (!checked.ok) {
        const err = new Error(`vision: invalid response — ${checked.errors.join("; ")}`);
        err.kind = "bad_response";
        throw err;
      }
      return { ...checked.value, model: res.model, blocked: Boolean(res.blocked) };
    });
  }

  // ── embed ────────────────────────────────────────────────────

  async _embed(text, priority) {
    const key = "embed:" + this._hash(this._norm(text));
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const cands = this._candidates("embed");
    if (cands.length === 0) return null; // no embed provider — degrade to tier 1

    let lastErr;
    for (const entry of cands) {
      const model = this._modelFor(entry, "embed");
      // quotaKey, а не key: `key` вище — ключ кешу. Однакове ім'я затінило б
      // його, і результат кешувався б під ключем квоти — кеш тихо промахувався б.
      const quotaKey = this._quotaKey(entry, model);
      const gate = await this._gate(entry, priority, model);
      if (gate === "shed") return { shed: true, reason: "quota reserve" };
      if (gate !== "ok") {
        lastErr = new Error(`${entry.provider.name}: ${gate}`);
        continue;
      }
      try {
        await this._bucketFor(entry, model).take(this.sleep);
        await this.quota.bump(quotaKey, this._quotaDay(entry));
        const out = await entry.provider.embed(String(text ?? ""));
        entry.breaker.recordSuccess();
        const result = { vector: out.vector, model: out.model, dim: out.dim };
        this.cache.set(key, result);
        return result;
      } catch (err) {
        lastErr = err;
        const kind = err.kind ?? "server";
        if (kind === "quota") await this.quota.markExhausted(quotaKey, this._quotaDay(entry));
        else if (kind === "server" || kind === "network") entry.breaker.recordFailure();
      }
    }
    throw lastErr ?? this._unavailable("embed");
  }

  // ── misc ─────────────────────────────────────────────────────

  _withModel(provider, model) {
    const clone = Object.create(Object.getPrototypeOf(provider));
    Object.assign(clone, provider, { config: { ...provider.config, completeModel: model } });
    return clone;
  }

  _parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      const m = String(text).match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch { /* fall through */ }
      }
      const err = new Error("provider response is not valid JSON");
      err.kind = "bad_response";
      throw err;
    }
  }

  _hash(s) {
    return crypto.createHash("sha1").update(String(s)).digest("hex");
  }

  _norm(s) {
    return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  _unavailable(cap) {
    const err = new Error(`LLMGateway: no available provider for ${cap}`);
    err.kind = "unavailable";
    return err;
  }
}

export default LLMGateway;

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
import { buildEnrichPrompt } from "./prompts/enrich.js";
import { GeminiProvider } from "./providers/GeminiProvider.js";
import { OpenAICompatProvider } from "./providers/OpenAICompatProvider.js";

/**
 * TheFlow — LLM gateway (ROADMAP §3.5, LLM_GATEWAY.md).
 *
 * The pipeline sees only enrich() / embed() / vision(). Everything else —
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

    // name -> { provider, meta, bucket, breaker }
    this.providers = new Map();
    for (const [name, provider] of Object.entries(instances)) {
      const meta = metas[name] ?? {};
      this.providers.set(name, {
        provider,
        meta,
        bucket: new TokenBucket(meta.rpm ?? 12, this.now),
        breaker: new CircuitBreaker({ now: this.now }),
      });
    }

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

  // eslint-disable-next-line no-unused-vars
  async vision(image, options = {}) {
    throw new Error("LLMGateway.vision(): phase 1.5, not implemented");
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

  async _gate(entry, priority) {
    if (!entry.breaker.allow()) return "circuit open";

    const rpd = entry.meta.rpd ?? Infinity;
    const used = await this.quota.used(entry.provider.name, this._quotaDay(entry));
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
      o: this._norm(input.textOcr),
      c: input.candidates ?? {},
      v: taxonomy?.version ?? null,
    }));
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };

    const prompt = buildEnrichPrompt({
      text: input.text,
      candidates: input.candidates,
      textOcr: input.textOcr,
      taxonomy,
    });

    const run = await this._runComplete(prompt, priority, {});
    if (run.shed) return run;

    const validated = validateEnrichResponse(run.parsed, { taxonomy, rawText: input.text });
    if (!validated.ok) {
      const err = new Error(`enrich: invalid response — ${validated.errors.join("; ")}`);
      err.kind = "bad_response";
      throw err;
    }

    let result = {
      value: validated.value,
      model_used: run.model,
      discarded: validated.discarded,
    };

    // Tiering (NOT fallback): re-run a low-confidence verdict on a stronger
    // model, once. A failure here keeps the base verdict.
    if (this.tierUp && Number(validated.value.confidence) < this.tierUpBelow) {
      try {
        const tierRun = await this._runComplete(prompt, priority, { modelOverride: this.tierUp });
        if (!tierRun.shed) {
          const tv = validateEnrichResponse(tierRun.parsed, { taxonomy, rawText: input.text });
          if (tv.ok) {
            result = { value: tv.value, model_used: tierRun.model, discarded: tv.discarded, tiered: true };
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
    const cands = this._candidates("complete");
    if (cands.length === 0) throw this._unavailable("complete");

    let lastErr;
    for (const entry of cands) {
      const gate = await this._gate(entry, priority);
      if (gate === "shed") return { shed: true, reason: "quota reserve" };
      if (gate !== "ok") {
        lastErr = new Error(`${entry.provider.name}: ${gate}`);
        continue;
      }

      // One retry on the same provider for rate_limit / bad_response before
      // moving to the next (fallback matrix, LLM_GATEWAY.md).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await entry.bucket.take(this.sleep);
          await this.quota.bump(entry.provider.name, this._quotaDay(entry));
          const provider = modelOverride
            ? this._withModel(entry.provider, modelOverride)
            : entry.provider;
          const res = await provider.complete(
            { system: prompt.system, user: prompt.user },
            { schema: prompt.responseSchema, temperature: 0, timeoutMs: this.timeoutMs },
          );
          entry.breaker.recordSuccess();
          return { parsed: this._parseJson(res.text), model: res.model };
        } catch (err) {
          lastErr = err;
          const kind = err.kind ?? "server";
          if (kind === "quota") {
            await this.quota.markExhausted(entry.provider.name, this._quotaDay(entry));
            break;
          }
          if (kind === "server" || kind === "network") {
            entry.breaker.recordFailure();
            break;
          }
          if (kind === "rate_limit") {
            await this.sleep(500 * (attempt + 1));
            continue;
          }
          if (attempt === 0) continue; // bad_response: one retry
          break;
        }
      }
    }
    throw lastErr ?? this._unavailable("complete");
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
      const gate = await this._gate(entry, priority);
      if (gate === "shed") return { shed: true, reason: "quota reserve" };
      if (gate !== "ok") {
        lastErr = new Error(`${entry.provider.name}: ${gate}`);
        continue;
      }
      try {
        await entry.bucket.take(this.sleep);
        await this.quota.bump(entry.provider.name, this._quotaDay(entry));
        const out = await entry.provider.embed(String(text ?? ""));
        entry.breaker.recordSuccess();
        const result = { vector: out.vector, model: out.model, dim: out.dim };
        this.cache.set(key, result);
        return result;
      } catch (err) {
        lastErr = err;
        const kind = err.kind ?? "server";
        if (kind === "quota") await this.quota.markExhausted(entry.provider.name, this._quotaDay(entry));
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
      const err = new Error("enrich: response is not valid JSON");
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

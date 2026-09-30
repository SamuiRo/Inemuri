/**
 * TheFlow — provider contract (ROADMAP §3.2).
 *
 * A provider is a thin adapter over one vendor's HTTP API. It does no
 * retrying, no rate limiting, no caching, no fallback — all of that is the
 * gateway's job. It normalizes one request and one response, and classifies
 * its errors so the gateway's fallback matrix can branch.
 *
 * Normalized returns:
 *   complete(...) -> { text: string, model: string, raw: object }
 *                    `text` is the model's raw JSON string; the caller parses
 *                    and validates it (schemas.js).
 *   embed(text)   -> { vector: Float32Array, model: string, dim: number }
 *                    the vector is L2-normalized to unit length.
 *   vision(image, opts) -> { text: string, model: string, blocked?: boolean }
 *                          (сирий JSON; розбір і валідація — у gateway)
 *
 * Errors thrown carry `.kind` where determinable:
 *   'rate_limit' | 'quota' | 'server' | 'network' | 'bad_response'
 * and `.status` (HTTP status) when there was a response.
 */

export class ProviderError extends Error {
  constructor(message, { kind = "server", status = null, cause, retryAfterMs = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    // Для rate_limit: скільки провайдер просить почекати (null — не сказав).
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }
}

export class BaseProvider {
  /**
   * @param {string} name    Provider key (gemini | openrouter | ...).
   * @param {object} config  Entry from LLM_PROVIDERS.
   * @param {object} [http]  axios-like client (injectable for tests).
   */
  constructor(name, config = {}, http = null) {
    if (new.target === BaseProvider) {
      throw new Error("BaseProvider is abstract");
    }
    this.name = name;
    this.config = config;
    this.http = http;
  }

  /**
   * Which capabilities this provider can serve, given its config.
   * @returns {{ complete: boolean, embed: boolean, vision: boolean }}
   */
  capabilities() {
    const hasKey = Boolean(this.config.apiKey);
    return {
      complete: hasKey && Boolean(this.config.completeModel),
      embed: hasKey && Boolean(this.config.embedModel),
      vision: hasKey && Boolean(this.config.visionModel),
    };
  }

  // eslint-disable-next-line no-unused-vars
  async complete(messages, options = {}) {
    throw new ProviderError(`${this.name}: complete() not implemented`, { kind: "bad_response" });
  }

  // eslint-disable-next-line no-unused-vars
  async embed(text) {
    throw new ProviderError(`${this.name}: embed() not supported`, { kind: "bad_response" });
  }

  // eslint-disable-next-line no-unused-vars
  async vision(image, options = {}) {
    throw new ProviderError(`${this.name}: vision() not supported`, { kind: "bad_response" });
  }

  // ── helpers for subclasses ──────────────────────────────────────

  /** Normalize a number[] embedding to unit length as a Float32Array. */
  static toUnitVector(values) {
    const arr = Float32Array.from(values ?? []);
    let sumSq = 0;
    for (const v of arr) sumSq += v * v;
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    }
    return arr;
  }

  /**
   * Що 429 каже про себе. Google (google.rpc): `details[]` з
   * `QuotaFailure.violations[].quotaId` (напр.
   * "GenerateRequestsPerMinutePerProjectPerModel-FreeTier") і
   * `RetryInfo.retryDelay` ("43s"). Інші — заголовок Retry-After (секунди).
   *
   * @returns {{ quotaIds: string[], retryAfterMs: number|null }}
   */
  static rateLimitInfo(response) {
    const details = response?.data?.error?.details;
    const quotaIds = [];
    let retryAfterMs = null;
    for (const d of Array.isArray(details) ? details : []) {
      for (const v of Array.isArray(d?.violations) ? d.violations : []) {
        if (typeof v?.quotaId === "string") quotaIds.push(v.quotaId);
      }
      const m = typeof d?.retryDelay === "string" && d.retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
      if (m) retryAfterMs = Math.ceil(Number(m[1]) * 1000);
    }
    if (retryAfterMs === null) {
      const h = response?.headers?.["retry-after"];
      if (h != null && /^\d+(\.\d+)?$/.test(String(h).trim())) retryAfterMs = Math.ceil(Number(h) * 1000);
    }
    return { quotaIds, retryAfterMs };
  }

  /** Turn an axios error into a classified ProviderError. */
  classifyHttpError(error, label) {
    const status = error?.response?.status ?? null;
    const bodyText = JSON.stringify(error?.response?.data ?? "").toLowerCase();

    if (status === 429) {
      const info = BaseProvider.rateLimitInfo(error?.response);
      // Gemini віддає "RESOURCE_EXHAUSTED" і "You exceeded your current quota"
      // на КОЖЕН 429 — і на хвилинний ліміт теж. Раніше саме за цими словами
      // 429 вважався денною квотою: перше ж перевищення RPM позначало модель
      // вичерпаною до тихоокеанської півночі (пілот 2026-09-30, 117 з 500).
      // Розрізняє їх лише quotaId у QuotaFailure; без нього — лише явне
      // "per day", інакше rate limit: помилково повторити дешевше, ніж
      // помилково вимкнути провайдера на добу.
      const daily = info.quotaIds.length
        ? info.quotaIds.some((id) => /perday/i.test(id))
        : /daily|per[ -]day/.test(bodyText);
      const detail = info.quotaIds.length ? ` [${info.quotaIds.join(", ")}]` : "";
      return new ProviderError(`${this.name} ${label}: ${daily ? "daily quota" : "rate limit"} (429)${detail}`, {
        kind: daily ? "quota" : "rate_limit",
        status,
        cause: error,
        retryAfterMs: daily ? null : info.retryAfterMs,
      });
    }
    if (status && status >= 500) {
      return new ProviderError(`${this.name} ${label}: server error ${status}`, {
        kind: "server", status, cause: error,
      });
    }
    if (status) {
      return new ProviderError(`${this.name} ${label}: HTTP ${status} ${bodyText.slice(0, 200)}`, {
        kind: "bad_response", status, cause: error,
      });
    }
    return new ProviderError(`${this.name} ${label}: ${error?.code || error?.message || "network error"}`, {
      kind: "network", status: null, cause: error,
    });
  }
}

export default BaseProvider;

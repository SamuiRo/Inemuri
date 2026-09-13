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
  constructor(message, { kind = "server", status = null, cause } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
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

  /** Turn an axios error into a classified ProviderError. */
  classifyHttpError(error, label) {
    const status = error?.response?.status ?? null;
    const bodyText = JSON.stringify(error?.response?.data ?? "").toLowerCase();

    if (status === 429) {
      const daily = /daily|per day|quota exceeded|resource_exhausted/.test(bodyText);
      return new ProviderError(`${this.name} ${label}: ${daily ? "daily quota" : "rate limit"} (429)`, {
        kind: daily ? "quota" : "rate_limit",
        status,
        cause: error,
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

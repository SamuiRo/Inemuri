import { API_BASE, messagesPath, requestHeaders, parseRateLimit } from "./rest.js";

/**
 * REST user-акаунта: лише читання, один запит за раз, повільно навмисно.
 * Масове гортання історії — саме той шаблон, за яким дивиться антиабуз
 * (CloakCord NEXT_STEPS, «Slow by policy»): пауза між запитами `minGapMs`,
 * 429 — чекати `retry_after`, вичерпаний `X-RateLimit-Remaining` — чекати
 * скидання.
 */
export class RestClient {
  /**
   * @param {{ token: string, identity: object, fetch?: typeof fetch, minGapMs?: number,
   *           maxRetries?: number, sleep?: (ms: number) => Promise<void>, now?: () => number,
   *           timeZone?: string }} opts
   */
  constructor({
    token, identity, fetch = globalThis.fetch, minGapMs = 2_000, maxRetries = 2,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  }) {
    this.headers = requestHeaders({ token, identity, timeZone });
    this.fetch = fetch;
    this.minGapMs = minGapMs;
    this.maxRetries = maxRetries;
    this.sleep = sleep;
    this.now = now;
    this._chain = Promise.resolve();
    this._nextAt = 0;
  }

  /** GET шляху API; серіалізовано — ніколи двох запитів одночасно. */
  get(path) {
    const run = this._chain.then(() => this._get(path));
    this._chain = run.catch(() => {});
    return run;
  }

  async _get(path) {
    for (let attempt = 0; ; attempt++) {
      const wait = this._nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      const res = await this.fetch(API_BASE + path, { headers: this.headers, signal: AbortSignal.timeout(15_000) });
      this._nextAt = this.now() + this.minGapMs;
      const body = await res.json().catch(() => null);
      const rl = parseRateLimit(res.status, (name) => res.headers.get(name), body);
      if (rl.limited) {
        if (attempt >= this.maxRetries) throw restError(res.status, body, path);
        this._nextAt = this.now() + rl.retryAfterMs;
        continue;
      }
      if (rl.remaining === 0 && rl.resetAfterMs) this._nextAt = Math.max(this._nextAt, this.now() + rl.resetAfterMs);
      if (!res.ok) throw restError(res.status, body, path);
      return body;
    }
  }

  /** Канал: назва, тип, сервер. */
  channel(channelId) {
    return this.get(`/channels/${encodeURIComponent(channelId)}`);
  }

  /** Сторінка повідомлень, найновіші першими. */
  messages(channelId, opts = {}) {
    return this.get(messagesPath(channelId, opts));
  }
}

function restError(status, body, path) {
  const error = new Error(`Discord API ${status} on ${path.split("?")[0]}${body?.message ? `: ${body.message}` : ""}`);
  error.status = status;
  error.code = body?.code ?? null;
  return error;
}

/**
 * TheFlow — LLM gateway internals: a token bucket, a circuit breaker, and a
 * TTL cache. Small, dependency-free, and each takes an injectable `now()` so
 * the gateway's behaviour is testable without real timers.
 */

/**
 * Per-provider RPM limiter. `take()` resolves when a token is available.
 *
 * `burst` — місткість відра, за замовчуванням дорівнює швидкості. Повне відро
 * на RPM разом із поповненням пропускає до 2×RPM запитів у першу ж хвилину, а
 * провайдер рахує ліміт у хвилинному вікні — тож gateway бере сплеск не
 * більший за секунду ліміту: для 15 RPM це рівний темп, один запит на 4 с.
 */
export class TokenBucket {
  constructor(ratePerMinute, now = () => Date.now(), { burst = ratePerMinute } = {}) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillPerMs = Math.max(1, ratePerMinute) / 60_000;
    this.last = now();
    this._now = now;
  }

  _refill() {
    const t = this._now();
    const gained = (t - this.last) * this.refillPerMs;
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.last = t;
    }
  }

  /** Non-blocking: consume a token if one is available. */
  tryTake() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** ms until the next token, 0 if one is available now. */
  msUntilNext() {
    this._refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /** Block until a token can be consumed. */
  async take(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    // Guard against pathological loops if the clock never advances in a test.
    for (let i = 0; i < 10_000; i++) {
      if (this.tryTake()) return;
      const wait = this.msUntilNext();
      if (wait <= 0) continue;
      await sleep(wait);
    }
    throw new Error("TokenBucket.take: gave up waiting for a token");
  }
}

/**
 * Per-provider circuit breaker. Opens on server/network/timeout failures,
 * half-opens after `coolOffMs`, closes on the next success. `threshold`
 * defaults to 1 — LLM_GATEWAY.md's fallback matrix says a 5xx/timeout opens
 * the breaker and traffic moves to the fallback with a periodic probe.
 */
export class CircuitBreaker {
  constructor({ threshold = 1, coolOffMs = 60_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.coolOffMs = coolOffMs;
    this._now = now;
    this.state = "closed"; // closed | open | half
    this.failures = 0;
    this.openedAt = 0;
  }

  /** Can a call go through right now? */
  allow() {
    if (this.state === "closed") return true;
    if (this.state === "open" && this._now() - this.openedAt >= this.coolOffMs) {
      this.state = "half"; // allow a single probe
      return true;
    }
    return this.state === "half";
  }

  recordSuccess() {
    this.state = "closed";
    this.failures = 0;
  }

  recordFailure() {
    this.failures += 1;
    if (this.state === "half" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = this._now();
    }
  }
}

/** TTL + size-capped cache. Modelled on TelegramDeduplicator. */
export class TtlCache {
  constructor({ ttlMs, maxSize, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this._now = now;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this._now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this._now() + this.ttlMs });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}

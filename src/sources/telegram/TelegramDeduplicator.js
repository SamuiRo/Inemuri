import { DEDUP_TTL_MS, DEDUP_MAX_SIZE } from "../../config/app.config.js";

/**
 * TelegramDeduplicator
 *
 * In-memory TTL-сет для дедуплікації повідомлень у режимі "both".
 * Коли listener отримує повідомлення, воно реєструється тут,
 * і polling-цикл пропускає його якщо знаходить запис у сеті.
 *
 * Захист від memory leak: при перевищенні MAX_SIZE запускається
 * ленива очистка протермінованих записів.
 */
class TelegramDeduplicator {
  constructor() {
    // key -> expiry timestamp (ms)
    this._set     = new Map();
    this._ttl     = DEDUP_TTL_MS;
    this._maxSize = DEDUP_MAX_SIZE;
  }

  /**
   * Позначає повідомлення як оброблене listener-ом.
   */
  mark(channelId, messageId) {
    const key = this._key(channelId, messageId);
    this._set.set(key, Date.now() + this._ttl);

    if (this._set.size > this._maxSize) {
      this._evictExpired();
    }
  }

  /**
   * Перевіряє чи було повідомлення оброблене listener-ом.
   * Протерміновані записи видаляє на льоту.
   */
  has(channelId, messageId) {
    const key    = this._key(channelId, messageId);
    const expiry = this._set.get(key);

    if (!expiry) return false;

    if (Date.now() > expiry) {
      this._set.delete(key);
      return false;
    }

    return true;
  }

  clear() {
    this._set.clear();
  }

  get size() {
    return this._set.size;
  }

  // ── internal ─────────────────────────────────────────────────────────────

  _key(channelId, messageId) {
    return `${channelId}:${messageId}`;
  }

  _evictExpired() {
    const now = Date.now();
    for (const [k, expiry] of this._set) {
      if (expiry < now) this._set.delete(k);
    }
  }
}

export default TelegramDeduplicator;
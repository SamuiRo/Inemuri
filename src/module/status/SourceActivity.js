import { STATUS } from "../../config/app.config.js";
import { MINUTE } from "../../shared/time.js";
import { print } from "../../shared/utils.js";
import { SourceState } from "../teapot/models/index.js";

/**
 * Коли джерело востаннє публікувало — для статус-борду (StatusBoard).
 *
 * Викликається з кожного шляху ingest (listener, polling, стрічки) і не має
 * права його гальмувати чи ламати: запис — у фоні, помилка — лише в лог.
 * Пише не частіше ніж раз на `minIntervalMs` на джерело: статус оперує днями,
 * а сплеск каналу інакше дав би запис на кожне повідомлення.
 */
export class SourceActivity {
  constructor({ Model = SourceState, minIntervalMs = STATUS.activityThrottleMin * MINUTE, now = Date.now, log = print } = {}) {
    this.Model = Model;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.log = log;
    this._written = new Map(); // sourceId -> { at: ms публікації, wroteAt: ms запису }
  }

  /**
   * @param {number|null|undefined} sourceId
   * @param {Date|number|string|null} [publishedAt]  Час публікації в джерелі
   *   (Telegram — unix-секунди, стрічки — Date/ms). Немає — «зараз».
   * @returns {Promise<boolean>} чи був запис (для тестів; викликачі не чекають).
   */
  async touch(sourceId, publishedAt = null) {
    if (sourceId == null) return false;
    const at = SourceActivity.toDate(publishedAt) ?? new Date(this.now());
    const seen = this._written.get(sourceId);
    if (seen && at.getTime() <= seen.at) return false;
    if (seen && this.now() - seen.wroteAt < this.minIntervalMs) {
      // Новіше, але ще рано писати: запам'ятати, запишеться наступного разу.
      seen.pending = Math.max(seen.pending ?? 0, at.getTime());
      return false;
    }
    const target = new Date(Math.max(at.getTime(), seen?.pending ?? 0));
    this._written.set(sourceId, { at: target.getTime(), wroteAt: this.now() });
    try {
      await this.Model.touch(sourceId, target);
      return true;
    } catch (error) {
      this._written.delete(sourceId);
      this.log(`[STATUS] last-seen for source #${sourceId} not saved: ${error.message}`, "debug");
      return false;
    }
  }

  /** Telegram: unix-секунди; стрічки: Date або ms. Невалідне — null. */
  static toDate(value) {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

const sourceActivity = new SourceActivity();
export default sourceActivity;

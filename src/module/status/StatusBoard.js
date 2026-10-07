import { MINUTE, HOUR } from "../../shared/time.js";
import { print } from "../../shared/utils.js";

const DEFAULT_MAX_LINES = 25; // на розділ — щоб повідомлення лишалось читабельним і в межах 4096

// Кольори смуги embed: усе гаразд / щось мовчить.
export const STATUS_COLOR = { ok: 0x2f9e44, attention: 0xf08c00 };

/** «5 д 3 год», «7 год», «40 хв». */
export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "?";
  const totalMin = Math.max(0, Math.floor(ms / MINUTE));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  if (d) return h ? `${d} д ${h} год` : `${d} д`;
  return h ? `${h} год` : `${totalMin % 60} хв`;
}

/**
 * Знімок → текст статус-борду. Чиста функція.
 *
 * @param {{
 *   sources: Array<{ name: string, platform: string, lastSeenAt: Date|null }>,
 *   channels: Array<{ platform: string, id: string, name: string|null, lastActivityAt: Date|null, error?: string }>,
 * }} snapshot
 * @param {{ sourceSilentHours: number, channelSilentHours: number }} thresholds
 * @param {number} now
 * @returns {{ text: string, silentSources: number, silentChannels: number, allGood: boolean }}
 */
export function buildStatus({ sources = [], channels = [] }, thresholds, now) {
  const sourceLimit = thresholds.sourceSilentHours * HOUR;
  const channelLimit = thresholds.channelSilentHours * HOUR;
  const maxLines = thresholds.maxLines ?? DEFAULT_MAX_LINES;
  const age = (d) => (d ? now - new Date(d).getTime() : null);

  const silentSources = sources
    .filter((s) => s.lastSeenAt && age(s.lastSeenAt) > sourceLimit)
    .sort((a, b) => age(b.lastSeenAt) - age(a.lastSeenAt));
  const neverSeen = sources.filter((s) => !s.lastSeenAt);
  const silentChannels = channels
    .filter((c) => !c.error && (!c.lastActivityAt || age(c.lastActivityAt) > channelLimit))
    .sort((a, b) => (age(b.lastActivityAt) ?? Infinity) - (age(a.lastActivityAt) ?? Infinity));
  const brokenChannels = channels.filter((c) => c.error);

  const lines = [`🕒 Оновлено ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC`];
  const section = (title, items, render) => {
    lines.push("", title);
    for (const item of items.slice(0, maxLines)) lines.push(render(item));
    if (items.length > maxLines) lines.push(`…і ще ${items.length - maxLines}`);
  };

  if (silentSources.length) {
    section(`🔇 **Джерела мовчать понад ${formatAge(sourceLimit)}** · ${silentSources.length} з ${sources.length}`, silentSources,
      (s) => `• ${s.name} · ${s.platform} — ${formatAge(age(s.lastSeenAt))}`);
  }
  if (neverSeen.length) {
    section(`👀 **Ще не бачили з початку відстеження** · ${neverSeen.length}`, neverSeen,
      (s) => `• ${s.name} · ${s.platform}`);
  }
  if (silentChannels.length) {
    section(`📭 **Канали без оновлень понад ${formatAge(channelLimit)}** · ${silentChannels.length} з ${channels.length}`, silentChannels,
      (c) => `• ${c.name ?? c.id} · ${c.platform} — ${c.lastActivityAt ? formatAge(age(c.lastActivityAt)) : "ніколи"}`);
  }
  if (brokenChannels.length) {
    section(`⛔ **Не вдалося перевірити** · ${brokenChannels.length}`, brokenChannels,
      (c) => `• ${c.name ?? c.id} · ${c.platform} — ${c.error}`);
  }
  const allGood = !silentSources.length && !neverSeen.length && !silentChannels.length && !brokenChannels.length;
  if (allGood) {
    lines.push("", `✅ Усе активне: джерел — ${sources.length}, каналів — ${channels.length}`);
  }
  return { text: lines.join("\n"), silentSources: silentSources.length, silentChannels: silentChannels.length, allGood };
}

/**
 * Статус-борд: джерела, що мовчать, і канали доставки без оновлень — одним
 * повідомленням у кожному призначенні, яке оновлюється на місці.
 *
 * Модуль не знає ні Telegram, ні Discord, ні бази: збір, надсилання, правку
 * й пам'ять про надіслане ін'єктує inemuri.js.
 */
export class StatusBoard {
  /**
   * @param {{
   *   collect: () => Promise<{ sources: object[], channels: object[] }>,
   *   destinations: Record<string, string[]>,
   *   send: (platform: string, channelId: string, messageData: object) => Promise<{ message_id: string|number }|null>,
   *   edit: (platform: string, channelId: string, messageId: string, messageData: object) => Promise<unknown>,
   *   store: { find: (platform: string, channelId: string) => Promise<{ message_id: string }|null>, remember: (platform: string, channelId: string, messageId: string) => Promise<unknown> },
   *   thresholds: { sourceSilentHours: number, channelSilentHours: number },
   *   intervalMs?: number,
   *   now?: () => number,
   *   log?: (msg: string, level?: string) => void,
   * }} deps
   */
  constructor({ collect, destinations, send, edit, store, thresholds, intervalMs = HOUR, now = Date.now, log = print }) {
    this.collect = collect;
    this.destinations = destinations;
    this.send = send;
    this.edit = edit;
    this.store = store;
    this.thresholds = thresholds;
    this.intervalMs = intervalMs;
    this.now = now;
    this.log = log;
    this._timer = null;
    this._running = false;
  }

  start({ firstDelayMs = MINUTE } = {}) {
    if (this._running) return;
    this._running = true;
    const loop = async () => {
      try {
        await this.runOnce();
      } catch (error) {
        this.log(`[STATUS] update failed: ${error.message}`, "warning");
      }
      this._schedule(this.intervalMs, loop);
    };
    // Перший прохід — трохи після старту: адаптери й listener встигнуть піднятись.
    this._schedule(firstDelayMs, loop);
  }

  _schedule(ms, fn) {
    if (!this._running) return;
    this._timer = setTimeout(fn, ms);
    this._timer.unref?.();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  /** Зібрати, відрендерити, оновити кожне призначення. */
  async runOnce() {
    const status = buildStatus(await this.collect(), this.thresholds, this.now());
    const messageData = {
      platform: "inemuri",
      text: status.text,
      rawText: status.text.replace(/\*\*/g, ""),
      source: { name: "📡 Статус Inemuri" },
      // Discord: смуга — зелена, коли все гаразд; footer — як часто оновлюється.
      embed: {
        color: status.allGood ? STATUS_COLOR.ok : STATUS_COLOR.attention,
        footer: `Оновлюється кожні ${Math.round(this.intervalMs / MINUTE)} хв`,
      },
      metadata: { source: "status" },
    };
    for (const [platform, ids] of Object.entries(this.destinations)) {
      for (const id of ids) await this._publish(platform, String(id), messageData);
    }
    return status;
  }

  /** Правка збереженого повідомлення; немає або видалене — нове й запам'ятати. */
  async _publish(platform, channelId, messageData) {
    const saved = await this.store.find(platform, channelId);
    if (saved) {
      try {
        await this.edit(platform, channelId, saved.message_id, messageData);
        return "edited";
      } catch (error) {
        this.log(`[STATUS] ${platform}:${channelId} edit failed (${error.message}) — posting a new message`, "warning");
      }
    }
    const sent = await this.send(platform, channelId, messageData);
    if (sent?.message_id == null) {
      this.log(`[STATUS] ${platform}:${channelId} could not post the status message`, "warning");
      return "failed";
    }
    await this.store.remember(platform, channelId, sent.message_id);
    return "posted";
  }
}

export default StatusBoard;

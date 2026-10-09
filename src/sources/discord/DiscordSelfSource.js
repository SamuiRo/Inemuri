import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import BaseSourceAdapter from "../base/BaseSourceAdapter.js";
import { Source } from "../../module/teapot/models/index.js";
import messageFilter from "../../module/filters/MessageFilter.js";
import FlowIngest from "../../module/theflow/FlowIngest.js";
import { toAdapterMedia } from "../../module/theflow/delivery/FlowDelivery.js";
import sourceActivity from "../../module/status/SourceActivity.js";
import { print } from "../../shared/utils.js";
import { MINUTE } from "../../shared/time.js";
import { DISCORD_USER_TOKEN, DISCORD_SOURCE } from "../../config/app.config.js";
import { toDiscordMessageData, passesClassic } from "./discordMessage.js";
import {
  FATAL_EXIT_CODE, restartDelayMs, assessStats, formatStats, describeMissing, compareSeen,
} from "./supervisor.js";

/** Транспорт → файл дочірнього процесу. Обидва говорять тим самим IPC. */
const CHILD_PATHS = {
  library: fileURLToPath(new URL("./transport/selfbotChild.js", import.meta.url)),
  own: fileURLToPath(new URL("./transport/ownChild.js", import.meta.url)),
};
const OTHER = { library: "own", own: "library" };

/**
 * Джерело platform "discord": канали чужих серверів через user-акаунт
 * (docs/DISCORD_SOURCE.md). Перенесено з CloakCord.
 *
 * Транспорт — у дочірньому процесі зі своєю стелею heap: бібліотека
 * discord.js-selfbot-v13 (transport/selfbotChild.js) або власний клієнт
 * (transport/ownChild.js), DISCORD_SOURCE.transport. RSS понад maxRssMb —
 * перезапуск дитини, падіння — перезапуск із паузою, що росте. Основний
 * процес (Telegram, TheFlow, discordapp) від цього не страждає. Невалідний
 * токен — без перезапусків: повтор не допоможе, а повторні логіни — саме те,
 * що бачить антиабуз.
 *
 * DISCORD_SOURCE.shadow: другий транспорт паралельно, у тіні — лише рахує
 * побачене; раз на звіт основного — порівняння id (рядок [DISCORD] shadow).
 * Так власний клієнт перевіряється на тих самих каналах, перш ніж замінить
 * бібліотеку.
 *
 * Дитина шле лише повідомлення з відстежуваних каналів, уже як plain-об'єкти;
 * далі все як у стрічок (FeedPoller.ingestItem): replacements → для
 * flow-джерела FlowIngest, інакше фільтр і `message.received`.
 */
export class DiscordSelfSource extends BaseSourceAdapter {
  /**
   * @param {object} eventBus
   * @param {{
   *   token?: string|null,
   *   config?: typeof DISCORD_SOURCE,
   *   flowIngest?: FlowIngest,
   *   resolveMedia?: ((post: object, opts: object) => Promise<object[]>)|null,
   *   activity?: object,
   *   loadSources?: () => Promise<object[]>,
   *   forkChild?: typeof fork,
   *   now?: () => number,
   *   log?: (msg: string, level?: string) => void,
   * }} [deps]
   */
  constructor(eventBus, {
    token = DISCORD_USER_TOKEN,
    config = DISCORD_SOURCE,
    flowIngest = new FlowIngest(),
    resolveMedia = null,
    activity = sourceActivity,
    loadSources = () => Source.getActiveByPlatform("discord"),
    forkChild = fork,
    now = Date.now,
    log = print,
  } = {}) {
    super("discord", eventBus);
    this.token = token;
    this.config = config;
    this.flowIngest = flowIngest;
    this.resolveMedia = resolveMedia;
    this.activity = activity;
    this.loadSources = loadSources;
    this.forkChild = forkChild;
    this.now = now;
    this.log = log;

    const transport = config.transport ?? "library";
    this.sources = new Map(); // channel_id → Source
    this.slots = {
      primary: newSlot("primary", transport),
      shadow: config.shadow ? newSlot("shadow", OTHER[transport]) : null,
    };
    this.counters = { matched: 0, ingested: 0, errors: 0 };
    // id повідомлень, побачених кожним транспортом, — лише в режимі тіні.
    this._seen = { primary: new Map(), shadow: new Map() };
    this.shadowTotals = { both: 0, onlyPrimary: 0, onlyShadow: 0 };
    this._stopping = false;
  }

  async connect() {
    const rows = await this.loadSources();
    this.sources = new Map(rows.map((s) => [String(s.channel_id), s]));
  }

  async startListening() {
    if (this.sources.size === 0) {
      this.log("[DISCORD] no active discord sources", "debug");
      return;
    }
    if (!this.token) {
      this.log(`[DISCORD] ${this.sources.size} discord source(s), but DISCORD_USER_TOKEN is not set — not started`, "warning");
      return;
    }
    this._stopping = false;
    this._spawn(this.slots.primary);
    if (this.slots.shadow) {
      this.log(`[DISCORD] shadow: ${this.slots.shadow.transport} runs next to ${this.slots.primary.transport}, counting only`, "info");
      this._spawn(this.slots.shadow);
    }
    this.isListening = true;
  }

  async stopListening() {
    this._stopping = true;
    this.isListening = false;
    await Promise.all(this._slots().map((slot) => this._stopSlot(slot)));
  }

  /** BaseSourceAdapter: plain-повідомлення від дитини → messageData. */
  parseMessage(message) {
    return toDiscordMessageData(message);
  }

  getStatus() {
    const { primary } = this.slots;
    return {
      ...super.getStatus(),
      transport: primary.transport,
      running: Boolean(primary.child),
      fatal: primary.fatal,
      shadow: this.slots.shadow ? { transport: this.slots.shadow.transport, ...this.shadowTotals } : null,
      ...this.counters,
    };
  }

  // ── Дочірні процеси ────────────────────────────────────────────────

  _slots() {
    return [this.slots.primary, this.slots.shadow].filter(Boolean);
  }

  _tag(slot) {
    return slot.role === "shadow" ? `[DISCORD:shadow ${slot.transport}]` : "[DISCORD]";
  }

  _spawn(slot) {
    const child = this.forkChild(CHILD_PATHS[slot.transport], [], {
      execArgv: [`--max-old-space-size=${this.config.heapMb}`],
      // stdout/stderr бібліотеки — у лог сервісу як є; наші рядки йдуть
      // через IPC і print().
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    slot.child = child;
    child.on("message", (msg) => {
      this._onChildMessage(slot, msg).catch((error) => {
        this.counters.errors++;
        this.log(`${this._tag(slot)} ${error.message}`, "error");
      });
    });
    child.on("error", (error) => this.log(`${this._tag(slot)} child process: ${error.message}`, "error"));
    child.on("exit", (code, signal) => this._onExit(slot, child, code, signal));

    // Токен — через IPC, не через argv: argv видно в списку процесів.
    child.send({ type: "watch", channelIds: [...this.sources.keys()] });
    child.send({
      type: "login",
      token: this.token,
      statsMs: this.config.statsMin * MINUTE,
      readyTimeoutMs: this.config.readyTimeoutMs,
    });
  }

  async _stopSlot(slot) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    const child = slot.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, this.config.shutdownGraceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.send({ type: "shutdown" });
      } catch {
        child.kill(); // канал уже закритий
      }
    });
  }

  _onExit(slot, child, code, signal) {
    if (slot.child !== child) return;
    slot.child = null;
    if (this._stopping) return;

    if (code === FATAL_EXIT_CODE || slot.fatal) {
      const detail = slot.fatal ?? `exit code ${code}`;
      if (slot.role === "shadow") {
        this.log(`${this._tag(slot)} stopped: ${detail}`, "error");
        return;
      }
      this.isListening = false;
      this.log(`[DISCORD] reader stopped: ${detail}. Fix DISCORD_USER_TOKEN and restart Inemuri`, "error");
      this.eventBus.emit("error.occurred", { source: "discord-source", error: `reader stopped: ${detail}` });
      return;
    }

    slot.attempt++;
    const delay = restartDelayMs(slot.attempt, this.config);
    this.log(`${this._tag(slot)} reader exited (${signal ?? `code ${code}`}), restart ${slot.attempt} in ${Math.round(delay / 1000)}s`, "warning");
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (!this._stopping) this._spawn(slot);
    }, delay);
    slot.timer.unref?.();
  }

  async _onChildMessage(slot, msg) {
    switch (msg?.type) {
      case "message":
        if (this.slots.shadow) this._seen[slot.role].set(String(msg.message?.id), this.now());
        // Тінь лише рахує: пересилає й пише в TheFlow тільки основний.
        if (slot.role === "shadow") return undefined;
        return this.handleDiscordMessage(msg.message);
      case "status":
        return this._onStatus(slot, msg);
      case "stats":
        return this._onStats(slot, msg.stats);
      case "log":
        return this.log(`${this._tag(slot)} ${msg.text}`, msg.level ?? "info");
      default:
        return undefined;
    }
  }

  _onStatus(slot, { state, detail }) {
    const tag = this._tag(slot);
    if (state === "ready") {
      slot.attempt = 0;
      this.log(`${tag} reader (${slot.transport}) ready as ${detail?.user ?? "?"}: ${detail?.guilds ?? 0} server(s), watching ${this.sources.size} channel(s)`, "success");
      const missing = describeMissing(detail?.missing, (id) => this.sources.get(id)?.channel_name ?? "?");
      if (missing) this.log(`${tag} ${missing}`, "warning");
    } else if (state === "fatal") {
      slot.fatal = String(detail ?? "fatal");
    } else if (state === "reconnecting") {
      this.log(`${tag} reconnecting${detail ? `: ${detail}` : ""}`, "warning");
    } else if (state === "resumed") {
      this.log(`${tag} session resumed`, "debug");
    }
  }

  _onStats(slot, stats) {
    const counters = slot.role === "primary" ? this.counters : { matched: "-", ingested: "-", errors: "-" };
    this.log(`${this._tag(slot)} stats ${formatStats(stats, counters)}`, "info");
    const verdict = assessStats(stats, this.config);
    if (verdict.restart && slot.child) {
      this.log(`${this._tag(slot)} ${verdict.reason} — restarting the reader`, "warning");
      slot.child.kill();
    }
    if (slot.role === "primary" && this.slots.shadow) this._compareShadow();
  }

  _compareShadow() {
    const r = compareSeen(this._seen.primary, this._seen.shadow, {
      now: this.now(), settleMs: this.config.shadowSettleMs,
    });
    for (const id of r.done) {
      this._seen.primary.delete(id);
      this._seen.shadow.delete(id);
    }
    this.shadowTotals.both += r.both;
    this.shadowTotals.onlyPrimary += r.onlyPrimary;
    this.shadowTotals.onlyShadow += r.onlyShadow;
    const t = this.shadowTotals;
    const p = this.slots.primary.transport;
    const s = this.slots.shadow.transport;
    const level = r.onlyPrimary || r.onlyShadow ? "warning" : "info";
    this.log(
      `[DISCORD] shadow ${s} vs ${p}: both=${r.both} only-${p}=${r.onlyPrimary} only-${s}=${r.onlyShadow}` +
        ` | since start both=${t.both} only-${p}=${t.onlyPrimary} only-${s}=${t.onlyShadow}`,
      level,
    );
  }

  // ── Повідомлення ───────────────────────────────────────────────────

  /**
   * Повідомлення з відстежуваного каналу → TheFlow або класичне пересилання.
   * @returns {Promise<object|null>} пост flow-джерела; null — класика або відсіяно.
   */
  async handleDiscordMessage(message) {
    const source = this.sources.get(String(message?.channelId));
    if (!source) return null;
    this.activity.touch(source.id, message.createdAt);

    const messageData = this.parseMessage(message);
    const replacements = messageFilter.getCompiledReplacements(source);
    const filter = messageFilter.getCompiledFilter(source);

    if (source.isFlowEnabled()) {
      const text = messageFilter.preprocessText(replacements, messageData.body);
      const { created, post, status } = await this.flowIngest.ingest({
        source,
        messageData,
        text,
        blacklist: filter?.blacklist ?? null,
        caseSensitive: filter?.caseSensitive ?? false,
        rejectShouty: filter?.rejectShouty ?? null,
        minLength: filter?.minLength ?? null,
      });
      if (created) {
        this.counters.ingested++;
        this.log(`[THEFLOW] ${source.channel_name} ${message.id} → posts#${post.id} [${status}]`, status === "pending" ? "success" : "debug");
      }
      return post;
    }

    const plain = messageFilter.preprocessText(replacements, messageData.rawText) ?? "";
    const pass = passesClassic({
      text: plain,
      hasMedia: messageData.mediaUrls.length > 0,
      filter,
      check: (text) => messageFilter.checkMessageFast(null, filter, text),
    });
    if (!pass) return null;

    this.counters.matched++;
    this.eventBus.emit("message.received", {
      ...messageData,
      rawText: plain,
      text: plain === messageData.rawText ? messageData.text : plain,
      downloadedMedia: await this._downloadMedia(messageData.mediaUrls),
      source: { id: source.id, name: source.channel_name, destinations: source.getAllDestinations() },
    });
    return null;
  }

  /**
   * Вкладення для класичного пересилання — одразу: підписані посилання CDN
   * Discord живуть близько доби. Помилка — пересилання без медіа.
   */
  async _downloadMedia(urls) {
    if (!urls.length || !this.resolveMedia) return [];
    try {
      const files = await this.resolveMedia(
        { media_ref: { kind: "url", urls } },
        { types: this.config.mediaTypes, limit: this.config.mediaLimit },
      );
      return toAdapterMedia(files);
    } catch (error) {
      this.log(`[DISCORD] media download failed: ${error.message}`, "warning");
      return [];
    }
  }
}

function newSlot(role, transport) {
  return { role, transport, child: null, attempt: 0, fatal: null, timer: null };
}

export default DiscordSelfSource;

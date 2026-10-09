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
  FATAL_EXIT_CODE, restartDelayMs, assessStats, formatStats, describeMissing,
} from "./supervisor.js";

const CHILD_PATH = fileURLToPath(new URL("./transport/selfbotChild.js", import.meta.url));

/**
 * Джерело platform "discord": канали чужих серверів через user-акаунт
 * (docs/DISCORD_SOURCE.md). Перенесено з CloakCord.
 *
 * Транспорт — у дочірньому процесі (transport/selfbotChild.js) зі своєю
 * стелею heap; RSS понад DISCORD_SOURCE.maxRssMb — перезапуск дитини, падіння —
 * перезапуск із паузою, що росте. Основний процес (Telegram, TheFlow,
 * discordapp) від цього не страждає. Невалідний токен — без перезапусків:
 * повтор не допоможе, а повторні логіни — саме те, що бачить антиабуз.
 *
 * Один акаунт — одна сесія на всі discord-джерела. Дитина шле лише
 * повідомлення з відстежуваних каналів, уже як plain-об'єкти; далі все як у
 * стрічок (FeedPoller.ingestItem): replacements → для flow-джерела FlowIngest,
 * інакше фільтр і `message.received` для класичного пересилання.
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
    this.log = log;

    this.sources = new Map(); // channel_id → Source
    this.child = null;
    this.counters = { matched: 0, ingested: 0, errors: 0 };
    this._attempt = 0;
    this._fatal = null;
    this._stopping = false;
    this._restartTimer = null;
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
    this._spawn();
    this.isListening = true;
  }

  async stopListening() {
    this._stopping = true;
    this.isListening = false;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = null;
    const child = this.child;
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

  /** BaseSourceAdapter: plain-повідомлення від дитини → messageData. */
  parseMessage(message) {
    return toDiscordMessageData(message);
  }

  getStatus() {
    return { ...super.getStatus(), running: Boolean(this.child), fatal: this._fatal, ...this.counters };
  }

  // ── Дочірній процес ────────────────────────────────────────────────

  _spawn() {
    const child = this.forkChild(CHILD_PATH, [], {
      execArgv: [`--max-old-space-size=${this.config.heapMb}`],
      // stdout/stderr бібліотеки — у лог сервісу як є; наші рядки йдуть
      // через IPC і print().
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    child.on("message", (msg) => {
      this._onChildMessage(msg).catch((error) => {
        this.counters.errors++;
        this.log(`[DISCORD] ${error.message}`, "error");
      });
    });
    child.on("error", (error) => this.log(`[DISCORD] child process: ${error.message}`, "error"));
    child.on("exit", (code, signal) => this._onExit(child, code, signal));

    // Токен — через IPC, не через argv: argv видно в списку процесів.
    child.send({ type: "watch", channelIds: [...this.sources.keys()] });
    child.send({
      type: "login",
      token: this.token,
      statsMs: this.config.statsMin * MINUTE,
      readyTimeoutMs: this.config.readyTimeoutMs,
    });
  }

  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    if (this._stopping) return;

    if (code === FATAL_EXIT_CODE || this._fatal) {
      this.isListening = false;
      const detail = this._fatal ?? `exit code ${code}`;
      this.log(`[DISCORD] reader stopped: ${detail}. Fix DISCORD_USER_TOKEN and restart Inemuri`, "error");
      this.eventBus.emit("error.occurred", { source: "discord-source", error: `reader stopped: ${detail}` });
      return;
    }

    this._attempt++;
    const delay = restartDelayMs(this._attempt, this.config);
    this.log(`[DISCORD] reader exited (${signal ?? `code ${code}`}), restart ${this._attempt} in ${Math.round(delay / 1000)}s`, "warning");
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._stopping) this._spawn();
    }, delay);
    this._restartTimer.unref?.();
  }

  async _onChildMessage(msg) {
    switch (msg?.type) {
      case "message":
        return this.handleDiscordMessage(msg.message);
      case "status":
        return this._onStatus(msg);
      case "stats":
        return this._onStats(msg.stats);
      case "log":
        return this.log(`[DISCORD] ${msg.text}`, msg.level ?? "info");
      default:
        return undefined;
    }
  }

  _onStatus({ state, detail }) {
    if (state === "ready") {
      this._attempt = 0;
      this.log(`[DISCORD] reader ready as ${detail?.user ?? "?"}: ${detail?.guilds ?? 0} server(s), watching ${this.sources.size} channel(s)`, "success");
      const missing = describeMissing(detail?.missing, (id) => this.sources.get(id)?.channel_name ?? "?");
      if (missing) this.log(`[DISCORD] ${missing}`, "warning");
    } else if (state === "fatal") {
      this._fatal = String(detail ?? "fatal");
    } else if (state === "reconnecting") {
      this.log(`[DISCORD] reconnecting${detail ? `: ${detail}` : ""}`, "warning");
    } else if (state === "resumed") {
      this.log("[DISCORD] session resumed", "debug");
    }
  }

  _onStats(stats) {
    this.log(`[DISCORD] stats ${formatStats(stats, this.counters)}`, "info");
    const verdict = assessStats(stats, this.config);
    if (verdict.restart && this.child) {
      this.log(`[DISCORD] ${verdict.reason} — restarting the reader`, "warning");
      this.child.kill();
    }
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

export default DiscordSelfSource;

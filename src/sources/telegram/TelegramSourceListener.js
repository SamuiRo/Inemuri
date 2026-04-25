import { NewMessage } from "telegram/events/index.js";

import { print, sleep } from "../../shared/utils.js";
import { Source, SourceState } from "../../module/teapot/models/index.js";
import telegramClient from "../../module/telegram/TelegramClient.js";
import BaseSourceAdapter from "../base/BaseSourceAdapter.js";
import messageFilter from "../../module/filters/MessageFilter.js";
import {
  POLLING_INTERVAL_MS,
  POLLING_FETCH_LIMIT,
  POLLING_CHANNEL_DELAY_MS,
} from "../../config/app.config.js";

import TelegramMessageParser  from "./TelegramMessageParser.js";
import TelegramMediaDownloader from "./TelegramMediaDownloader.js";
import TelegramGroupBuffer    from "./TelegramGroupBuffer.js";
import TelegramDeduplicator   from "./TelegramDeduplicator.js";

class TelegramSourceListener extends BaseSourceAdapter {
  constructor(eventBus) {
    super("telegram", eventBus);
    this.client = null;

    // ── Listener ──────────────────────────────────────────────────
    this.whitelistedIds      = [];
    this.boundHandleMessage  = null;

    // ── Caches (спільні для listener і polling) ───────────────────
    this.sourcesCache      = new Map(); // channelId  -> Source
    this.filtersCache      = new Map(); // channelId  -> compiled filter
    this.replacementsCache = new Map(); // channelId  -> compiled replacements

    // ── Polling ───────────────────────────────────────────────────
    this.stateCache        = new Map(); // source_id  -> SourceState
    this.channelToSourceId = new Map(); // channel_id -> source_id
    this.pollingTimer      = null;      // глобальний таймер циклу
    this.isPolling         = false;     // захист від паралельних циклів

    // ── Допоміжні модулі ──────────────────────────────────────────
    this._parser      = TelegramMessageParser;   // singleton, без стану
    this._downloader  = null;                    // ініціалізується після connect()
    this._groupBuffer = new TelegramGroupBuffer(
      (groupedMessage) => this._filterAndProcess(groupedMessage),
    );
    this._dedup = new TelegramDeduplicator();
  }

  // ================================================================
  //  ПІДКЛЮЧЕННЯ
  // ================================================================

  async connect() {
    try {
      this.client      = telegramClient.getClient();
      this._downloader = new TelegramMediaDownloader(this.client);
      print(`${this.platform} adapter connected`, "success");
    } catch (error) {
      throw new Error(`Failed to connect ${this.platform}: ${error.message}`);
    }
  }

  // ================================================================
  //  СТАРТ / СТОП
  // ================================================================

  async startListening() {
    if (this.isListening) {
      print(`${this.platform} listener already started`, "warning");
      return;
    }

    const sources = await Source.getActiveByPlatform(this.platform);

    if (sources.length === 0) {
      print(`No active ${this.platform} sources found`, "warning");
      return;
    }

    await this._buildCaches(sources);

    const listenerSources = sources.filter((s) => s.mode === "listener" || s.mode === "both");
    const pollingSources  = sources.filter((s) => s.mode === "polling"  || s.mode === "both");

    if (listenerSources.length > 0) await this._startListener(listenerSources);
    if (pollingSources.length  > 0) await this._startPolling(pollingSources);

    this.isListening = true;
    print(`${this.platform} adapter started successfully`, "success");
  }

  async stopListening() {
    if (!this.isListening) return;

    if (this.client && this.boundHandleMessage) {
      this.client.removeEventHandler(this.boundHandleMessage);
      this.boundHandleMessage = null;
    }

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    this._groupBuffer.clear();
    this._dedup.clear();

    this.sourcesCache.clear();
    this.filtersCache.clear();
    this.replacementsCache.clear();
    this.stateCache.clear();
    this.channelToSourceId.clear();

    this.isListening = false;
    print(`${this.platform} listener stopped`);
  }

  async disconnect() {
    await this.stopListening();
  }

  // ================================================================
  //  LISTENER РЕЖИМ
  // ================================================================

  async _startListener(sources) {
    this.whitelistedIds = sources.map((s) => s.channel_id);
    const chatIds       = this.whitelistedIds.map((id) => BigInt(id));

    this.boundHandleMessage = (event) => this.handleMessage(event);
    this.client.addEventHandler(
      this.boundHandleMessage,
      new NewMessage({ chats: chatIds }),
    );

    print(`[LISTENER] Subscribed to ${chatIds.length} channel(s) via MTProto events`);
  }

  // ================================================================
  //  POLLING РЕЖИМ
  // ================================================================

  async _startPolling(sources) {
    for (const source of sources) {
      const state = await SourceState.getOrCreate(source.id);
      this.stateCache.set(source.id, state);
      this.channelToSourceId.set(source.channel_id, source.id);

      if (state.last_message_id === null) {
        await this._setBaseline(source, state);
      }
    }

    print(
      `[POLLING] Initialized ${sources.length} channel(s), interval: ${POLLING_INTERVAL_MS / 1000}s, delay between channels: ${POLLING_CHANNEL_DELAY_MS}ms`,
    );

    this._scheduleNextPoll();
  }

  _scheduleNextPoll() {
    this.pollingTimer = setTimeout(async () => {
      await this._runPollingCycle();
      if (this.isListening) this._scheduleNextPoll();
    }, POLLING_INTERVAL_MS);
  }

  async _runPollingCycle() {
    if (this.isPolling) {
      print("[POLLING] Previous cycle still running, skipping", "debug");
      return;
    }

    this.isPolling = true;
    print(`[POLLING] Starting poll cycle for ${this.stateCache.size} channel(s)`, "debug");

    let isFirst = true;
    for (const [sourceId, state] of this.stateCache) {
      // Пауза перед кожним каналом крім першого
      if (!isFirst) await sleep(POLLING_CHANNEL_DELAY_MS);
      isFirst = false;

      const source = this._getSourceById(sourceId);
      if (!source) continue;

      try {
        await this._pollChannel(source, state);
      } catch (error) {
        print(`[POLLING] Error polling "${source.channel_name}": ${error.message}`, "error");
        this.eventBus.emit("error.occurred", {
          source:  this.platform,
          error:   error.message,
          context: `polling:${source.channel_id}`,
          stack:   error.stack,
        });
      }
    }

    this.isPolling = false;
    print("[POLLING] Poll cycle complete", "debug");
  }

  async _pollChannel(source, state) {
    const lastId = state.last_message_id ?? 0;

    const messages = await this.client.getMessages(source.channel_id, {
      limit:    POLLING_FETCH_LIMIT,
      offsetId: lastId,
      reverse:  true,
    });

    if (!messages?.length) {
      print(`[POLLING] No new messages in "${source.channel_name}"`, "debug");
      return;
    }

    const sorted = [...messages].sort((a, b) => a.id - b.id);
    print(`[POLLING] "${source.channel_name}": ${sorted.length} new message(s) since id=${lastId}`);

    for (const msg of sorted) {
      if (source.mode === "both" && this._dedup.has(source.channel_id, msg.id)) {
        print(`[POLLING] Skipping duplicate msg_id=${msg.id} (handled by listener)`, "debug");
        await state.advance(msg.id);
        continue;
      }

      const messageData = this._parser.parseRaw(msg, source.channel_id, this.platform);
      await this._routeIncoming(messageData);
      await state.advance(msg.id);
    }
  }

  // ================================================================
  //  ОБРОБКА ПОВІДОМЛЕНЬ
  // ================================================================

  /**
   * Entry point для MTProto listener подій.
   */
  async handleMessage(rawEvent) {
    try {
      const messageData = this._parser.parseEvent(rawEvent, this.platform);

      if (!messageData?.channelId) {
        print(`Invalid message from ${this.platform}, skipping`, "warning");
        return;
      }

      // Реєструємо в dedup якщо канал у режимі "both"
      const source = this.sourcesCache.get(messageData.channelId);
      if (source?.mode === "both") {
        this._dedup.mark(messageData.channelId, messageData.messageId);
      }

      await this._routeIncoming(messageData);
    } catch (error) {
      print(`Error handling ${this.platform} message: ${error.message}`, "error");
      console.error(error);
      this.eventBus.emit("error.occurred", {
        source: this.platform,
        error:  error.message,
        stack:  error.stack,
      });
    }
  }

  /**
   * Маршрутизація після парсингу:
   * альбом → буфер, звичайне → фільтр+обробка.
   */
  async _routeIncoming(messageData) {
    if (messageData.groupedId) {
      this._groupBuffer.add(messageData);
    } else {
      await this._filterAndProcess(messageData);
    }
  }

  /**
   * Фільтрація і подальша обробка.
   */
  async _filterAndProcess(messageData) {
    const compiledReplacements = this.replacementsCache.get(messageData.channelId);
    const compiledFilter       = this.filtersCache.get(messageData.channelId);

    const passed = messageFilter.checkMessageFast(
      compiledReplacements,
      compiledFilter,
      messageData.text,
    );

    if (!passed) {
      print(
        `[${this.platform.toUpperCase()}] Message filtered out from channel ${messageData.channelId}`,
        "debug",
      );
      return;
    }

    await this._processFiltered(messageData);
  }

  /**
   * Збагачення метаданими, завантаження медіа, emit події.
   */
  async _processFiltered(messageData) {
    const source = this.sourcesCache.get(messageData.channelId);
    if (source) {
      messageData.source = {
        id:           source.id,
        name:         source.channel_name,
        destinations: source.getAllDestinations(),
      };
    }

    if (messageData.media) {
      print(
        `[${this.platform.toUpperCase()}] Downloading media for message ${messageData.messageId}...`,
        "debug",
      );
      const downloaded = await this._downloader.download(messageData);
      if (downloaded) {
        messageData.downloadedMedia = downloaded;
        print(
          `[${this.platform.toUpperCase()}] ✓ Downloaded ${downloaded.length} media file(s)`,
          "success",
        );
      }
    }

    print(
      `[${this.platform.toUpperCase()}] ✓ Message ${messageData.messageId} from channel ${messageData.channelId} passed filters`,
      "success",
    );

    this.eventBus.emit("message.received", messageData);
  }

  // ================================================================
  //  ДОПОМІЖНІ МЕТОДИ
  // ================================================================

  async _buildCaches(sources) {
    this.sourcesCache.clear();
    this.filtersCache.clear();
    this.replacementsCache.clear();

    for (const source of sources) {
      this.sourcesCache.set(source.channel_id, source);
      this.replacementsCache.set(
        source.channel_id,
        messageFilter.compileReplacements(source.id, source.text_replacements),
      );
      this.filtersCache.set(
        source.channel_id,
        messageFilter.compileFilter(source.id, source.filters),
      );
    }

    print(`Cached ${this.sourcesCache.size} sources with filters and replacements`);
  }

  _getSourceById(sourceId) {
    for (const source of this.sourcesCache.values()) {
      if (source.id === sourceId) return source;
    }
    return null;
  }

  async reloadWhitelist() {
    print(`Reloading ${this.platform} sources...`);
    await this.stopListening();
    messageFilter.clearCache();
    await this.startListening();
  }

  // ── Конфігурація ───────────────────────────────────────────────

  setDownloadableMediaTypes(types) {
    this._downloader.setDownloadableTypes(types);
  }

  setGroupTimeout(timeout) {
    if (typeof timeout !== "number" || timeout < 0)
      throw new Error("Timeout must be a positive number");
    this._groupBuffer._timeout = timeout;
    print(`Message group timeout set to ${timeout}ms`);
  }

  // ── Статистика ─────────────────────────────────────────────────

  getStats() {
    return {
      platform:           this.platform,
      isListening:        this.isListening,
      listenerChannels:   this.whitelistedIds.length,
      pollingChannels:    this.stateCache.size,
      cachedSources:     this.sourcesCache.size,
      cachedFilters:     this.filtersCache.size,
      cachedReplacements: this.replacementsCache.size,
      activeGroups:      this._groupBuffer.activeGroups,
      dedupSetSize:      this._dedup.size,
      filterCacheStats:  messageFilter.getCacheStats(),
    };
  }
}

export default TelegramSourceListener;
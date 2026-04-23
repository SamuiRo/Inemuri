import { NewMessage } from "telegram/events/index.js";

import { print } from "../../shared/utils.js";
import { Source, SourceState } from "../../module/teapot/models/index.js";
import telegramClient from "../../module/telegram/TelegramClient.js";
import BaseSourceAdapter from "../base/BaseSourceAdapter.js";
import messageFilter from "../../module/filters/MessageFilter.js";
import { POLLING_INTERVAL_MS, POLLING_FETCH_LIMIT  } from "../../config/app.config.js";

class TelegramSourceListener extends BaseSourceAdapter {
  constructor(eventBus) {
    super("telegram", eventBus);
    this.client = null;

    // ── Listener ──────────────────────────────────────────────────
    this.whitelistedIds = [];          // channel_id для listener підписки
    this.boundHandleMessage = null;

    // ── Caches (спільні для listener і polling) ───────────────────
    // channelId -> Source instance
    this.sourcesCache = new Map();
    // channelId -> compiled filter
    this.filtersCache = new Map();
    // channelId -> compiled replacements
    this.replacementsCache = new Map();

    // ── Polling ───────────────────────────────────────────────────
    // source_id -> SourceState instance
    this.stateCache = new Map();
    // channel_id -> source_id  (для швидкого lookup під час дедуплікації в режимі both)
    this.channelToSourceId = new Map();
    // Таймер глобального polling циклу
    this.pollingTimer = null;
    // Прапор щоб не запускати паралельні polling цикли
    this.isPolling = false;

    // ── Групування повідомлень (альбоми) ──────────────────────────
    // groupedId -> { messages: [], timer: timeout }
    this.messageGroups = new Map();
    this.groupTimeout = 5000;

    // ── Медіа ─────────────────────────────────────────────────────
    this.downloadableMediaTypes = ["photo", "video", "document", "animation"];
  }

  // ================================================================
  //  ПІДКЛЮЧЕННЯ
  // ================================================================

  async connect() {
    try {
      this.client = telegramClient.getClient();
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

    // Будуємо всі кеші одразу для всіх sources
    await this._buildCaches(sources);

    // Розбиваємо за режимом
    const listenerSources = sources.filter(
      (s) => s.mode === "listener" || s.mode === "both",
    );
    const pollingSources = sources.filter(
      (s) => s.mode === "polling" || s.mode === "both",
    );

    if (listenerSources.length > 0) {
      await this._startListener(listenerSources);
    }

    if (pollingSources.length > 0) {
      await this._startPolling(pollingSources);
    }

    this.isListening = true;
    print(`${this.platform} adapter started successfully`, "success");
  }

  async stopListening() {
    if (!this.isListening) return;

    // Зупиняємо listener
    if (this.client && this.boundHandleMessage) {
      this.client.removeEventHandler(this.boundHandleMessage);
      this.boundHandleMessage = null;
    }

    // Зупиняємо polling
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    // Очищаємо таймери груп
    for (const [, group] of this.messageGroups) {
      if (group.timer) clearTimeout(group.timer);
    }
    this.messageGroups.clear();

    // Очищаємо кеші
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
    const chatIds = this.whitelistedIds.map((id) => BigInt(id));

    this.boundHandleMessage = (event) => this.handleMessage(event);
    this.client.addEventHandler(
      this.boundHandleMessage,
      new NewMessage({ chats: chatIds }),
    );

    print(
      `[LISTENER] Subscribed to ${chatIds.length} channel(s) via MTProto events`,
    );
  }

  // ================================================================
  //  POLLING РЕЖИМ
  // ================================================================

  async _startPolling(sources) {
    // Ініціалізуємо SourceState для кожного polling каналу
    for (const source of sources) {
      const state = await SourceState.getOrCreate(source.id);
      this.stateCache.set(source.id, state);
      this.channelToSourceId.set(source.channel_id, source.id);

      // Перший запуск: baseline ще не встановлено — тягнемо
      // останнє повідомлення і використовуємо його як точку відліку,
      // не обробляючи його вміст (щоб не залити старими даними).
      if (state.last_message_id === null) {
        await this._setBaseline(source, state);
      }
    }

    print(
      `[POLLING] Initialized ${sources.length} channel(s), interval: ${POLLING_INTERVAL_MS / 1000}s`,
    );

    // Запускаємо перший цикл
    this._scheduleNextPoll();
  }

  /**
   * Встановлює baseline для каналу при першому запуску.
   * Бере ID останнього повідомлення без його обробки.
   */
  async _setBaseline(source, state) {
    try {
      const messages = await this.client.getMessages(source.channel_id, {
        limit: 1,
      });

      if (messages && messages.length > 0) {
        const latestId = messages[0].id;
        await state.setBaseline(latestId);
        print(
          `[POLLING] Baseline set for "${source.channel_name}": message_id=${latestId}`,
        );
      } else {
        // Порожній канал — baseline = 0, обробляємо все що прийде
        await state.setBaseline(0);
        print(
          `[POLLING] Baseline set for "${source.channel_name}": empty channel`,
        );
      }
    } catch (error) {
      print(
        `[POLLING] Failed to set baseline for "${source.channel_name}": ${error.message}`,
        "error",
      );
    }
  }

  /**
   * Планує наступний polling цикл через POLLING_INTERVAL_MS.
   * Використовує setTimeout щоб цикли не накладались.
   */
  _scheduleNextPoll() {
    this.pollingTimer = setTimeout(async () => {
      await this._runPollingCycle();
      // Якщо listener ще живий — плануємо наступний цикл
      if (this.isListening) {
        this._scheduleNextPoll();
      }
    }, POLLING_INTERVAL_MS);
  }

  /**
   * Один повний цикл polling по всіх polling-каналах
   */
  async _runPollingCycle() {
    if (this.isPolling) {
      print("[POLLING] Previous cycle still running, skipping", "debug");
      return;
    }

    this.isPolling = true;
    print(`[POLLING] Starting poll cycle for ${this.stateCache.size} channel(s)`, "debug");

    for (const [sourceId, state] of this.stateCache) {
      const source = this._getSourceById(sourceId);
      if (!source) continue;

      try {
        await this._pollChannel(source, state);
      } catch (error) {
        print(
          `[POLLING] Error polling "${source.channel_name}": ${error.message}`,
          "error",
        );
        this.eventBus.emit("error.occurred", {
          source: this.platform,
          error: error.message,
          context: `polling:${source.channel_id}`,
          stack: error.stack,
        });
      }
    }

    this.isPolling = false;
    print("[POLLING] Poll cycle complete", "debug");
  }

  /**
   * Polling одного каналу.
   * Тягне повідомлення починаючи з last_message_id + 1
   * і обробляє їх від старіших до новіших.
   */
  async _pollChannel(source, state) {
    const lastId = state.last_message_id ?? 0;

    // getMessages з min_id повертає повідомлення з ID > min_id
    // у зворотньому порядку (новіші першими), тому реверсуємо
    const messages = await this.client.getMessages(source.channel_id, {
      limit: POLLING_FETCH_LIMIT,
      min_id: lastId,
    });

    if (!messages || messages.length === 0) {
      print(`[POLLING] No new messages in "${source.channel_name}"`, "debug");
      return;
    }

    // Від старіших до новіших для правильного порядку обробки
    const sorted = [...messages].sort((a, b) => a.id - b.id);

    print(
      `[POLLING] "${source.channel_name}": ${sorted.length} new message(s) since id=${lastId}`,
    );

    let maxProcessedId = lastId;

    for (const msg of sorted) {
      // Режим 'both': пропускаємо якщо listener вже обробив це повідомлення.
      // Listener виставляє processed_ids через markAsProcessedByListener.
      if (source.mode === "both" && this._isProcessedByListener(source.channel_id, msg.id)) {
        print(`[POLLING] Skipping duplicate msg_id=${msg.id} (handled by listener)`, "debug");
        maxProcessedId = Math.max(maxProcessedId, msg.id);
        continue;
      }

      await this._handleRawTelegramMessage(msg, source.channel_id);
      maxProcessedId = Math.max(maxProcessedId, msg.id);
    }

    // Зберігаємо прогрес
    await state.advance(maxProcessedId);
  }

  // ================================================================
  //  ДЕДУПЛІКАЦІЯ ДЛЯ РЕЖИМУ 'both'
  // ================================================================

  /**
   * In-memory короткочасний set повідомлень оброблених listener-ом.
   * Ключ: `${channelId}:${messageId}`, TTL: ~groupTimeout + буфер.
   * Зберігаємо не більше MAX_DEDUP_SIZE записів щоб уникнути memory leak.
   */
  _dedupSet = new Map(); // key -> expiry timestamp
  _DEDUP_TTL_MS = 10 * 60 * 1000; // 10 хвилин
  _DEDUP_MAX_SIZE = 5000;

  _dedupKey(channelId, messageId) {
    return `${channelId}:${messageId}`;
  }

  markAsProcessedByListener(channelId, messageId) {
    const key = this._dedupKey(channelId, messageId);
    this._dedupSet.set(key, Date.now() + this._DEDUP_TTL_MS);

    // Тримаємо розмір в межах
    if (this._dedupSet.size > this._DEDUP_MAX_SIZE) {
      const now = Date.now();
      for (const [k, expiry] of this._dedupSet) {
        if (expiry < now) this._dedupSet.delete(k);
      }
    }
  }

  _isProcessedByListener(channelId, messageId) {
    const key = this._dedupKey(channelId, messageId);
    const expiry = this._dedupSet.get(key);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this._dedupSet.delete(key);
      return false;
    }
    return true;
  }

  // ================================================================
  //  ОБРОБКА ПОВІДОМЛЕНЬ (спільна логіка)
  // ================================================================

  /**
   * Entry point для MTProto listener подій
   */
  async handleMessage(rawEvent) {
    try {
      const messageData = this.parseMessage(rawEvent);

      if (!messageData || !messageData.channelId) {
        print(`Invalid message from ${this.platform}, skipping`, "warning");
        return;
      }

      // Для режиму 'both': реєструємо повідомлення як оброблене listener-ом
      const source = this.sourcesCache.get(messageData.channelId);
      if (source?.mode === "both") {
        this.markAsProcessedByListener(messageData.channelId, messageData.messageId);
      }

      // Групування (альбоми)
      if (messageData.groupedId) {
        await this._addToGroup(messageData);
        return;
      }

      await this._filterAndProcess(messageData);
    } catch (error) {
      print(`Error handling ${this.platform} message: ${error.message}`, "error");
      console.error(error);
      this.eventBus.emit("error.occurred", {
        source: this.platform,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Entry point для polling — отримуємо сирий об'єкт message (не event)
   */
  async _handleRawTelegramMessage(msg, channelId) {
    try {
      // Будуємо уніфікований messageData вручну з raw message
      const messageData = {
        platform: this.platform,
        channelId: String(channelId),
        messageId: msg.id,
        text: msg.message || "",
        media: msg.media ? this.parseMedia(msg) : null,
        timestamp: msg.date,
        sender: msg.senderId?.toString(),
        isForwarded: msg.fwdFrom !== undefined,
        replyToMessageId: msg.replyTo?.replyToMsgId,
        groupedId: msg.groupedId?.toString() ?? null,
        raw: msg,
      };

      // Групування для polling теж підтримуємо
      if (messageData.groupedId) {
        await this._addToGroup(messageData);
        return;
      }

      await this._filterAndProcess(messageData);
    } catch (error) {
      print(`[POLLING] Error handling message ${msg.id}: ${error.message}`, "error");
      console.error(error);
    }
  }

  /**
   * Фільтрація + подальша обробка повідомлення
   */
  async _filterAndProcess(messageData) {
    const compiledReplacements = this.replacementsCache.get(messageData.channelId);
    const compiledFilter = this.filtersCache.get(messageData.channelId);

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

    await this.processFilteredMessage(messageData);
  }

  /**
   * Обробка повідомлення що пройшло фільтри:
   * додає source мета-дані, завантажує медіа, емітить подію
   */
  async processFilteredMessage(messageData) {
    const source = this.sourcesCache.get(messageData.channelId);
    if (source) {
      messageData.source = {
        id: source.id,
        name: source.channel_name,
        destinations: source.getAllDestinations(),
      };
    }

    if (messageData.media) {
      print(
        `[${this.platform.toUpperCase()}] Downloading media for message ${messageData.messageId}...`,
        "debug",
      );
      const downloadedMedia = await this.downloadMedia(messageData);
      if (downloadedMedia) {
        messageData.downloadedMedia = downloadedMedia;
        print(
          `[${this.platform.toUpperCase()}] ✓ Downloaded ${downloadedMedia.length} media file(s)`,
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
  //  ГРУПУВАННЯ (альбоми)
  // ================================================================

  async _addToGroup(messageData) {
    const groupId = messageData.groupedId;
    let group = this.messageGroups.get(groupId);

    if (!group) {
      group = { messages: [], timer: null };
      this.messageGroups.set(groupId, group);
    }

    group.messages.push(messageData);

    if (group.timer) clearTimeout(group.timer);

    group.timer = setTimeout(() => {
      this.processMessageGroup(groupId);
    }, this.groupTimeout);

    print(
      `[${this.platform.toUpperCase()}] Grouped message added (${group.messages.length} items, waiting ${this.groupTimeout}ms)`,
      "debug",
    );
  }

  async processMessageGroup(groupedId) {
    const group = this.messageGroups.get(groupedId);

    if (!group || group.messages.length === 0) {
      this.messageGroups.delete(groupedId);
      return;
    }

    try {
      group.messages.sort((a, b) => a.messageId - b.messageId);

      const firstMessage = group.messages[0];
      const allMedia = group.messages
        .map((msg) => msg.media)
        .filter((media) => media !== null);
      const combinedText = group.messages
        .map((msg) => msg.text)
        .filter((text) => text && text.trim().length > 0)
        .join("\n");

      const groupedMessage = {
        ...firstMessage,
        text: combinedText,
        media: allMedia.length > 0 ? allMedia : null,
        isGrouped: true,
        groupSize: group.messages.length,
        groupedId,
      };

      print(
        `[${this.platform.toUpperCase()}] Processing grouped message: ${group.messages.length} items`,
      );

      await this.processFilteredMessage(groupedMessage);
    } catch (error) {
      print(`Error processing message group ${groupedId}: ${error.message}`, "error");
      console.error(error);
      this.eventBus.emit("error.occurred", {
        source: this.platform,
        error: error.message,
        context: `message_group:${groupedId}`,
        stack: error.stack,
      });
    } finally {
      this.messageGroups.delete(groupedId);
    }
  }

  // ================================================================
  //  ПАРСИНГ ПОВІДОМЛЕННЯ
  // ================================================================

  parseMessage(event) {
    const message = event.message;
    return {
      platform: this.platform,
      channelId: message.chatId?.toString(),
      messageId: message.id,
      text: message.text || "",
      media: this.parseMedia(message),
      timestamp: message.date,
      sender: message.senderId?.toString(),
      isForwarded: message.fwdFrom !== undefined,
      replyToMessageId: message.replyTo?.replyToMsgId,
      groupedId: message.groupedId?.toString() ?? null,
      raw: message,
    };
  }

  parseMedia(message) {
    if (!message.media) return null;

    const media = message.media;
    const mediaType = this.getMediaType(media.className || media.constructor.name);
    const mediaInfo = { type: mediaType, raw: media };

    if (media.photo) {
      mediaInfo.mimeType = "image/jpeg";
    } else if (media.document) {
      const doc = media.document;
      mediaInfo.mimeType = doc.mimeType;
      mediaInfo.fileSize = doc.size;
      mediaInfo.filename = doc.attributes?.find(
        (attr) => attr.className === "DocumentAttributeFilename",
      )?.fileName;

      if (doc.attributes) {
        for (const attr of doc.attributes) {
          if (attr.className === "DocumentAttributeVideo") {
            mediaInfo.type = attr.roundMessage ? "video_note" : "video";
            mediaInfo.duration = attr.duration;
            mediaInfo.width = attr.w;
            mediaInfo.height = attr.h;
          } else if (attr.className === "DocumentAttributeAnimated") {
            mediaInfo.type = "animation";
          } else if (attr.className === "DocumentAttributeAudio") {
            mediaInfo.type = "audio";
            mediaInfo.duration = attr.duration;
            mediaInfo.title = attr.title;
            mediaInfo.performer = attr.performer;
          }
        }
      }
    }

    return mediaInfo;
  }

  getMediaType(className) {
    const typeMap = {
      MessageMediaPhoto: "photo",
      MessageMediaDocument: "document",
      MessageMediaWebPage: "webpage",
      MessageMediaGeo: "location",
      MessageMediaContact: "contact",
      MessageMediaPoll: "poll",
    };
    return typeMap[className] || "unknown";
  }

  // ================================================================
  //  ЗАВАНТАЖЕННЯ МЕДІА
  // ================================================================

  async downloadMedia(messageData) {
    if (!messageData.media) return null;

    try {
      if (Array.isArray(messageData.media)) {
        const downloadedFiles = [];
        for (const media of messageData.media) {
          if (this.downloadableMediaTypes.includes(media.type)) {
            const buffer = await this.client.downloadMedia(media.raw, {});
            if (buffer) {
              downloadedFiles.push({
                type: media.type,
                data: buffer,
                filename: media.filename,
                mimeType: media.mimeType,
                fileSize: media.fileSize,
                duration: media.duration,
                width: media.width,
                height: media.height,
              });
            }
          }
        }
        return downloadedFiles.length > 0 ? downloadedFiles : null;
      }

      if (this.downloadableMediaTypes.includes(messageData.media.type)) {
        const buffer = await this.client.downloadMedia(messageData.media.raw, {});
        if (buffer) {
          return [{
            type: messageData.media.type,
            data: buffer,
            filename: messageData.media.filename,
            mimeType: messageData.media.mimeType,
            fileSize: messageData.media.fileSize,
            duration: messageData.media.duration,
            width: messageData.media.width,
            height: messageData.media.height,
          }];
        }
      }

      return null;
    } catch (error) {
      print(`Error downloading media for message ${messageData.messageId}: ${error.message}`, "error");
      console.error(error);
      return null;
    }
  }

  // ================================================================
  //  ДОПОМІЖНІ МЕТОДИ
  // ================================================================

  /**
   * Будує всі кеші для списку sources
   */
  async _buildCaches(sources) {
    this.sourcesCache.clear();
    this.filtersCache.clear();
    this.replacementsCache.clear();

    for (const source of sources) {
      this.sourcesCache.set(source.channel_id, source);

      const compiledReplacements = messageFilter.compileReplacements(
        source.id,
        source.text_replacements,
      );
      this.replacementsCache.set(source.channel_id, compiledReplacements);

      const compiledFilter = messageFilter.compileFilter(
        source.id,
        source.filters,
      );
      this.filtersCache.set(source.channel_id, compiledFilter);
    }

    print(`Cached ${this.sourcesCache.size} sources with filters and replacements`);
  }

  /**
   * Шукає Source в кеші по source_id (для polling циклу)
   */
  _getSourceById(sourceId) {
    for (const source of this.sourcesCache.values()) {
      if (source.id === sourceId) return source;
    }
    return null;
  }

  /**
   * Перезавантаження всіх джерел (після оновлення бази)
   */
  async reloadWhitelist() {
    print(`Reloading ${this.platform} sources...`);
    await this.stopListening();
    messageFilter.clearCache();
    await this.startListening();
  }

  // ── Конфігурація ───────────────────────────────────────────────

  setDownloadableMediaTypes(types) {
    if (!Array.isArray(types)) throw new Error("Media types must be an array");
    this.downloadableMediaTypes = types;
    print(`Downloadable media types set to: ${types.join(", ")}`);
  }

  setGroupTimeout(timeout) {
    if (typeof timeout !== "number" || timeout < 0)
      throw new Error("Timeout must be a positive number");
    this.groupTimeout = timeout;
    print(`Message group timeout set to ${timeout}ms`);
  }

  // ── Статистика ─────────────────────────────────────────────────

  getStats() {
    const pollingSources = [...this.stateCache.keys()].length;
    const listenerSources = this.whitelistedIds.length;

    return {
      platform: this.platform,
      isListening: this.isListening,
      listenerChannels: listenerSources,
      pollingChannels: pollingSources,
      cachedSources: this.sourcesCache.size,
      cachedFilters: this.filtersCache.size,
      cachedReplacements: this.replacementsCache.size,
      activeGroups: this.messageGroups.size,
      dedupSetSize: this._dedupSet.size,
      filterCacheStats: messageFilter.getCacheStats(),
    };
  }
}

export default TelegramSourceListener;
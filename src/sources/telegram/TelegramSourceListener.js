import { NewMessage } from "telegram/events/index.js";

import { print, sleep } from "../../shared/utils.js";
import { Source, SourceState } from "../../module/teapot/models/index.js";
import telegramClient from "../../module/telegram/TelegramClient.js";
import BaseSourceAdapter from "../base/BaseSourceAdapter.js";
import messageFilter from "../../module/filters/MessageFilter.js";
import {
  POLLING_INTERVAL_MIN,
  POLLING_INTERVAL_MS,
  POLLING_FETCH_LIMIT,
  POLLING_CHANNEL_DELAY_MS,
  POLLING_FLOOD_MARGIN_MS,
  POLLING_TICK_MS,
  POLLING_MAX_PER_TICK,
  POLLING_MAX_DRAIN_PAGES,
} from "../../config/app.config.js";

import TelegramMessageParser  from "./TelegramMessageParser.js";
import TelegramMediaDownloader from "./TelegramMediaDownloader.js";
import TelegramGroupBuffer    from "./TelegramGroupBuffer.js";
import TelegramDeduplicator   from "./TelegramDeduplicator.js";
import FlowIngest             from "../../module/theflow/FlowIngest.js";

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
    this.pollingTimer      = null;      // один таймер-тік, не N на джерело
    this.isPolling         = false;     // захист від паралельних циклів
    this.pollDueAt         = new Map(); // source_id -> коли опитувати (ms epoch)
    this.pollEveryMs       = new Map(); // source_id -> власний інтервал (ms)
    this.pollPhased        = new Set(); // кому зсув фази вже застосовано

    // ── Допоміжні модулі ──────────────────────────────────────────
    this._parser      = TelegramMessageParser;   // singleton, без стану
    this._downloader  = null;                    // ініціалізується після connect()
    this._groupBuffer = new TelegramGroupBuffer(
      (groupedMessage) => this._filterAndProcess(groupedMessage),
    );
    this._dedup = new TelegramDeduplicator();

    // ── TheFlow (стадія 1: ingest у таблицю posts) ────────────────
    this._flowIngest = new FlowIngest();
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
    this.pollDueAt.clear();
    this.pollEveryMs.clear();
    this.pollPhased.clear();

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

    // Розклад: коли кожне джерело опитувати наступного разу.
    // Детермінований зсув фази — див. _phaseOffsetMs.
    const now = Date.now();
    for (const source of sources) {
      const everyMs = source.getPollIntervalMin(POLLING_INTERVAL_MIN) * 60_000;
      // Перший тік: усе due одразу. Наздогін після простою — бажаний, а
      // стелю на тік і паузу 500 мс ніхто не скасовував, тож він обмежений.
      this.pollDueAt.set(source.id, now);
      this.pollEveryMs.set(source.id, everyMs);
    }

    const intervals = sources
      .map((s) => s.getPollIntervalMin(POLLING_INTERVAL_MIN))
      .sort((a, b) => a - b);
    print(
      `[POLLING] Initialized ${sources.length} channel(s), tick ${POLLING_TICK_MS / 1000}s, ` +
        `intervals ${intervals[0]}..${intervals[intervals.length - 1]}min, ` +
        `max ${POLLING_MAX_PER_TICK}/tick, ${POLLING_CHANNEL_DELAY_MS}ms between channels`,
    );

    this._scheduleNextPoll(0);
  }

  /**
   * Детермінований зсув фази для джерела, у межах [0, everyMs).
   *
   * Без нього кілька джерел з однаковим інтервалом назавжди залишаються
   * синхронними: виставлені разом — стають due разом, і «раз на добу» для
   * шести каналів означає шість запитів в одну секунду щодоби. Зсув від
   * id джерела, а не від Math.random, щоб розклад відтворювався після
   * рестарту, а не перетасовувався щоразу.
   */
  static _phaseOffsetMs(sourceId, everyMs) {
    if (!Number.isFinite(everyMs) || everyMs <= 0) return 0;
    // FNV-1a над рядком id: дешево, без залежностей, добре розсіює малі числа.
    let hash = 0x811c9dc5;
    for (const ch of String(sourceId)) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % Math.floor(everyMs);
  }

  /** Джерела, чий час настав, найпрострочені першими, не більше стелі. */
  _dueSources(now = Date.now()) {
    const due = [];
    for (const [sourceId, dueAt] of this.pollDueAt) {
      if (dueAt <= now) due.push([sourceId, dueAt]);
    }
    // Найдовше очікуване — першим: інакше джерело з коротким інтервалом
    // може вічно витісняти те, що чекає з минулого тіку.
    due.sort((a, b) => a[1] - b[1]);
    return due.slice(0, POLLING_MAX_PER_TICK).map(([sourceId]) => sourceId);
  }

  /** Наступний час опитування для джерела, з рознесенням фази. */
  _rescheduleSource(sourceId, now = Date.now()) {
    const everyMs = this.pollEveryMs.get(sourceId) ?? POLLING_INTERVAL_MS;
    const offset = TelegramSourceListener._phaseOffsetMs(sourceId, everyMs);
    // Зсув застосовуємо один раз, при першому перепланувані: далі він уже
    // «вшитий» у dueAt і інтервал лишається рівним.
    const base = this.pollPhased.has(sourceId) ? everyMs : everyMs + offset;
    this.pollPhased.add(sourceId);
    this.pollDueAt.set(sourceId, now + base);
  }

  /**
   * Скільки секунд просить чекати FLOOD_WAIT, або null якщо помилка інша.
   *
   * GramJS сам засинає на флуд у межах `floodSleepThreshold` (60 с за
   * замовчуванням) і прозоро повторює запит, тож сюди доходить лише те, що
   * перевищило поріг. Чиста функція — перевіряється тестом без мережі.
   */
  static floodWaitSeconds(error) {
    if (!error || typeof error !== "object") return null;
    const seconds = Number(error.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    // `seconds` саме по собі не доказ: перевіряємо, що це справді flood.
    const label = [
      error.className,
      error.errorMessage,
      error.constructor?.name,
      error.message,
    ].filter(Boolean).join(" ");
    return /flood/i.test(label) ? seconds : null;
  }

  _scheduleNextPoll(delayMs = POLLING_TICK_MS) {
    this.pollingTimer = setTimeout(async () => {
      const backoffMs = await this._runPollingCycle();
      if (this.isListening) this._scheduleNextPoll(backoffMs ?? POLLING_TICK_MS);
    }, delayMs);
  }

  /**
   * Один прохід по всіх polling-каналах.
   * @returns {Promise<number|null>} Затримка перед наступним циклом (мс),
   *   або null — планувати як зазвичай.
   */
  async _runPollingCycle() {
    if (this.isPolling) {
      print("[POLLING] Previous cycle still running, skipping", "debug");
      return null;
    }

    this.isPolling = true;
    print(`[POLLING] Tick: ${this.pollDueAt.size} channel(s) scheduled`, "debug");

    try {
      const due = this._dueSources();
      if (due.length === 0) {
        print("[POLLING] Nothing due this tick", "debug");
        return null;
      }

      let isFirst = true;
      for (const sourceId of due) {
        // Пауза перед кожним каналом крім першого
        if (!isFirst) await sleep(POLLING_CHANNEL_DELAY_MS);
        isFirst = false;

        const source = this._getSourceById(sourceId);
        const state = this.stateCache.get(sourceId);
        if (!source || !state) {
          // Джерело зникло з кешу (деактивоване, перезаряджений whitelist) —
          // прибираємо з розкладу, інакше воно due назавжди.
          this.pollDueAt.delete(sourceId);
          continue;
        }

        try {
          await this._pollChannel(source, state);
          this._rescheduleSource(sourceId);
        } catch (error) {
          const floodSeconds = TelegramSourceListener.floodWaitSeconds(error);
          if (floodSeconds !== null) {
            // Ліміти Telegram діють на АКАУНТ, не на канал. Піти до
            // наступного каналу означає стукати тим самим заблокованим
            // акаунтом і подовжувати покарання. Обриваємо цикл цілком і
            // відкладаємо наступний на стільки, скільки просить сервер.
            const waitMs = floodSeconds * 1_000 + POLLING_FLOOD_MARGIN_MS;
            print(
              `[POLLING] FLOOD_WAIT ${floodSeconds}s on "${source.channel_name}" — ` +
                `aborting cycle, next poll in ${Math.round(waitMs / 1000)}s`,
              "error",
            );
            this.eventBus.emit("error.occurred", {
              source:  this.platform,
              error:   `FLOOD_WAIT ${floodSeconds}s`,
              context: `polling:${source.channel_id}`,
              stack:   error.stack,
            });
            return waitMs;
          }

          // Звичайна помилка: джерело все одно переплановуємо, інакше воно
          // лишиться due і буде повторюватись кожен тік.
          this._rescheduleSource(sourceId);
          print(`[POLLING] Error polling "${source.channel_name}": ${error.message}`, "error");
          this.eventBus.emit("error.occurred", {
            source:  this.platform,
            error:   error.message,
            context: `polling:${source.channel_id}`,
            stack:   error.stack,
          });
        }
      }

      print(`[POLLING] Tick complete: ${due.length} channel(s)`, "debug");
      return null;
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Забирає нові повідомлення каналу, за потреби кількома сторінками.
   *
   * Наздогін сторінками потрібен саме через пер-джерельні інтервали: канал з
   * інтервалом «раз на добу» і `POLLING_FETCH_LIMIT` 50 інакше відстає
   * назавжди — за тік він забирає 50 повідомлень, а за добу їх приходить
   * більше. Стеля `POLLING_MAX_DRAIN_PAGES` тримає один тік обмеженим: решта
   * добереться наступного разу.
   */
  async _pollChannel(source, state) {
    for (let page = 0; page < POLLING_MAX_DRAIN_PAGES; page++) {
      const lastId = state.last_message_id ?? 0;

      const messages = await this.client.getMessages(source.channel_id, {
        limit:    POLLING_FETCH_LIMIT,
        offsetId: lastId,
        reverse:  true,
      });

      if (!messages?.length) {
        if (page === 0) {
          print(`[POLLING] No new messages in "${source.channel_name}"`, "debug");
        }
        return;
      }

      const sorted = [...messages].sort((a, b) => a.id - b.id);
      print(
        `[POLLING] "${source.channel_name}": ${sorted.length} new message(s) since id=${lastId}` +
          (page > 0 ? ` (catch-up page ${page + 1})` : ""),
      );

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

      // Неповна сторінка — канал вичерпано, більше нічого немає.
      if (sorted.length < POLLING_FETCH_LIMIT) return;

      print(`[POLLING] "${source.channel_name}": page full, continuing catch-up`, "debug");
      await sleep(POLLING_CHANNEL_DELAY_MS);
    }

    print(
      `[POLLING] "${source.channel_name}": drain cap (${POLLING_MAX_DRAIN_PAGES} pages) reached — ` +
        `resuming next tick`,
      "warning",
    );
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
   *
   * Порядок операцій:
   *  1. Text replacements застосовуються до rawText (plain text, без Markdown).
   *  2. Фільтрація (keyword / blacklist) перевіряє оброблений rawText.
   *  3. Якщо повідомлення проходить — оновлюємо messageData.rawText і
   *     перегенеровуємо messageData.text через parser.entitiesToMarkdown,
   *     щоб посилання та форматування залишались консистентними з оновленим текстом.
   *
   * Таким чином фільтри і replacements завжди працюють з plain text,
   * а destinations завжди отримують коректний Markdown.
   */
  async _filterAndProcess(messageData) {
    const compiledReplacements = this.replacementsCache.get(messageData.channelId);
    const compiledFilter       = this.filtersCache.get(messageData.channelId);
    const source               = this.sourcesCache.get(messageData.channelId);

    // Крок 1 (спільний препроцесинг): replacements до rawText (plain text).
    const processedRawText = messageFilter.preprocessText(
      compiledReplacements,
      messageData.rawText ?? messageData.text,
    );

    // ── Розгалуження: TheFlow чи класичний форвардинг ──────────────
    // Спільне вище цієї точки — препроцесинг (replacements). Нижче розходяться
    // рівно дві речі: семантика фільтра (для flow-джерел whitelist вимкнено,
    // лишається тільки blacklist) і фінальна дія (persist у posts замість
    // emit + завантаження медіа). Медіа для flow їде на стадію 3, після
    // дедуплікації, тому гілку не можна ставити в _processFiltered.
    if (source?.isFlowEnabled()) {
      this._syncMarkdown(messageData, processedRawText);
      await this._ingestToFlow(messageData, processedRawText, compiledFilter, source);
      return;
    }

    // Крок 2: фільтрація по обробленому plain text (keyword / blacklist).
    const passed = messageFilter.checkMessageFast(
      null,             // replacements вже застосовані вище
      compiledFilter,
      processedRawText,
    );

    if (!passed) {
      print(
        `[${this.platform.toUpperCase()}] Message filtered out from channel ${messageData.channelId}`,
        "debug",
      );
      return;
    }

    // Крок 3: синхронізуємо Markdown text із оновленим plain text.
    this._syncMarkdown(messageData, processedRawText);

    await this._processFiltered(messageData);
  }

  /**
   * Якщо replacements змінили plain text — оновлюємо messageData.rawText і
   * перегенеровуємо messageData.text (Markdown) з оригінальних entities.
   *
   * Entities прив'язані до позицій в оригінальному тексті, тому якщо
   * replacement видалив / змінив ділянку — entities для неї парсер безпечно
   * ігнорує (String.prototype.slice повертає '' для out-of-range offset).
   */
  _syncMarkdown(messageData, processedRawText) {
    if (processedRawText === messageData.rawText) return;

    messageData.rawText = processedRawText;

    const hasActiveEntities = (messageData.entities ?? []).length > 0;
    messageData.text = hasActiveEntities
      ? this._parser.entitiesToMarkdown(processedRawText, messageData.entities)
      : processedRawText;
  }

  /**
   * TheFlow стадія 1: regex-стадія + ідемпотентний INSERT у `posts`.
   * Помилка ingest НЕ валить update-loop — логуємо як подію і рухаємось далі.
   */
  async _ingestToFlow(messageData, text, compiledFilter, source) {
    try {
      const { created, post, status } = await this._flowIngest.ingest({
        source,
        messageData,
        text,
        blacklist: compiledFilter?.blacklist ?? null,
        caseSensitive: compiledFilter?.caseSensitive ?? false,
      });

      if (created) {
        print(
          `[THEFLOW] ${source.channel_name} msg ${messageData.messageId} → posts#${post.id} [${status}]`,
          status === "pending" ? "success" : "debug",
        );
      } else {
        print(
          `[THEFLOW] Duplicate ingest ignored: ${source.channel_name} msg ${messageData.messageId}`,
          "debug",
        );
      }
    } catch (error) {
      print(`[THEFLOW] Ingest failed for msg ${messageData.messageId}: ${error.message}`, "error");
      console.error(error);
      this.eventBus.emit("error.occurred", {
        source:  this.platform,
        error:   error.message,
        context: `theflow-ingest:${messageData.channelId}`,
        stack:   error.stack,
      });
    }
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

  /**
   * Встановлює початкову baseline для нового джерела:
   * отримує поточний останній message_id і зберігає його як точку старту,
   * щоб polling не обробляв всю історію каналу при першому запуску.
   */
  async _setBaseline(source, state) {
    try {
      const messages = await this.client.getMessages(source.channel_id, { limit: 1 });

      const lastId = messages?.[0]?.id ?? 0;
      await state.advance(lastId);

      print(
        `[POLLING] Baseline set for "${source.channel_name}": last_message_id=${lastId}`,
      );
    } catch (error) {
      print(
        `[POLLING] Failed to set baseline for "${source.channel_name}": ${error.message}`,
        "error",
      );
      // Не кидаємо помилку далі — polling запуститься з id=0,
      // що гірше але не критично
    }
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
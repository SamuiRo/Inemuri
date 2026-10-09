import { MINUTE, HOUR } from "./shared/time.js";
import { WELCOM_MESSAGE, SUB_TITTLE } from "./shared/message.js";
import { print, banner, printStack, loadImage } from "./shared/utils.js";
import database from "./module/teapot/sqlite/sqlite_db.js";
import EventBus from "./module/eventbus/EventBus.js";
import MessageRouter from "./module/routing/MessageRouter.js";
import telegramClient from "./module/telegram/TelegramClient.js";
import discordGateway from "./module/discord/DiscordGateway.js";
import TelegramSourceListener from "./sources/telegram/TelegramSourceListener.js";
import FeedPoller from "./sources/feeds/FeedPoller.js";
import DiscordSelfSource from "./sources/discord/DiscordSelfSource.js";
import DiscordDestinationAdapter from "./destinations/discord/DiscordDestination.js";
import TelegramDestinationAdapter from "./destinations/telegram/TelegramDestination.js";
import CronScheduler from "./module/cron/CronScheduler.js";
import DiscordApp from "./module/discordapp/DiscordApp.js";
import { createDailyJob } from "./module/cron/dailyReport.js";
import CryptoDataService from "./services/crypto/CryptoDataService.js";
import LLMGateway from "./services/ai/LLMGateway.js";
import EnrichWorker from "./module/theflow/EnrichWorker.js";
import VisionStage from "./module/theflow/VisionStage.js";
import { FlowHealthMonitor, collectHealthSnapshot, primaryQuota } from "./module/theflow/FlowHealth.js";
import DedupStage from "./module/theflow/dedup/DedupStage.js";
import DeltaStage from "./module/theflow/dedup/DeltaStage.js";
import HistorySearch from "./module/theflow/search/HistorySearch.js";
import FlowDelivery from "./module/theflow/delivery/FlowDelivery.js";
import FewShotStore from "./module/theflow/FewShot.js";
import TriageStage from "./module/theflow/triage/TriageStage.js";
import { createTriageExamples } from "./module/theflow/triage/examples.js";
import { collectStorage, assessStorage } from "./module/theflow/Storage.js";
import { buildDigestMessage } from "./module/theflow/digest/Digest.js";
import mediaResolver from "./module/theflow/media/index.js";
import TelegramMediaResolver from "./sources/telegram/TelegramMediaResolver.js";
import UrlMediaResolver from "./sources/feeds/UrlMediaResolver.js";
import StatusBoard from "./module/status/StatusBoard.js";
import { collectStatus } from "./module/status/collect.js";
import { Source, VisionCache, DiscoveredItem, StatusMessage } from "./module/teapot/models/index.js";
import { validateRouting } from "./module/theflow/ResolveStage.js";
import { copyDestinations, destinationIdProblems } from "./shared/destinations.js";
import {
  VISION_CACHE_TTL_HOURS,
  CRON_CONFIG,
  DAILY_REPORT,
  MAINTENANCE_SWEEP_HOURS,
  CATEGORIES,
  ROUTING,
  CONFIG_WARNINGS,
  ENRICH_WORKER_ENABLED,
  FLOW_HEALTH,
  DEDUP,
  FLOW_DELIVERY,
  FLOW_FEWSHOT,
  FLOW_TRIAGE,
  FLOW_DIGEST,
  STATUS,
  LLM_PRIMARY,
  LLM_PROVIDERS,
  DISCORD_BOT_TOKEN,
  DISCORD_APP_ENABLED,
  DISCORD_GUILD_IDS,
  DISCORD_COMMAND_WHITELIST,
} from "./config/app.config.js";

class Inemuri {
  constructor() {
    // Event Bus для комунікації між модулями
    this.eventBus = new EventBus();

    // Message Router
    this.messageRouter = new MessageRouter(this.eventBus);

    // Listeners
    this.telegramListener = null;

    // Destination adapters
    this.discordDestination = null;
    this.telegramDestination = null;

    // Cron Scheduler
    this.cronScheduler = null;

    // discordapp — керування Discord-серверами (docs/DISCORDAPP.md)
    this.discordApp = null;

    // TheFlow enrichment worker (phase 1, shadow mode)
    this.enrichWorker = null;
    // LLM gateway — створюється разом із воркером; ним же користується пошук
    this.llmGateway = null;

    // Нагляд за TheFlow (ROADMAP §13.10)
    this.flowHealth = null;

    // Конфіг TheFlow джерела — кешується на весь процес, як і кеші
    // TelegramSourceListener: зміна flow через reseed діє після перезапуску.
    // Спільний для воркера й доставки.
    const flowConfigs = new Map();
    this.flowFor = async (post) => {
      if (!flowConfigs.has(post.source_id)) flowConfigs.set(post.source_id, await Source.findByPk(post.source_id));
      return flowConfigs.get(post.source_id)?.getFlowConfig() ?? null;
    };

    this.setupEventHandlers();
  }

  /** Правка надісланого через адаптер платформи (доставка TheFlow, статус-борд). */
  editVia(platform, channelId, messageId, messageData, identity) {
    const adapter = this.messageRouter.adapters.get(platform);
    if (!adapter?.capabilities?.edit) throw new Error(`${platform} adapter cannot edit`);
    return adapter.editMessageData(channelId, messageId, messageData, identity);
  }

  /**
   * Налаштування обробників подій
   */
  setupEventHandlers() {
    // Обробка критичних помилок на рівні системи
    this.eventBus.on("error.occurred", (errorData) => {
      print(`[ERROR] ${errorData.source}: ${errorData.error}`, "error");
      printStack({ stack: errorData?.stack });
    });
  }

  /**
   * Головний метод запуску системи
   */
  async main() {
    try {
      banner(WELCOM_MESSAGE, SUB_TITTLE);

      // 0. Проблеми конфігурації — до того, як щось стартує. Мовчазний
      //    фолбек гірший за гучний: саме він ховає неповний .env.
      for (const warning of CONFIG_WARNINGS) {
        print(`[CONFIG] ${warning}`, "warning");
      }
      // Помилка в routing.json не падає, а тихо змінює поведінку: правило з
      // топіком не з таксономії не збігається ніколи, з опечаткою в ключі —
      // збігається з усім. Попередження, не зупинка: маршрутизація за
      // вердиктами ще в тіні, класичний форвардинг від неї не залежить.
      for (const problem of validateRouting(ROUTING, CATEGORIES)) {
        print(`[ROUTING] ${problem}`, "warning");
      }
      // Ембеддинги лише з однієї моделі. Порівнювати вектори між моделями
      // заборонено (ROADMAP 13.2), тож вектор від fallback-моделі лягає в
      // простір, у якому дедуплікація основну масу корпусу не шукає, — і пост
      // стає для неї невидимим. `null` краще: його дозаповнює та сама модель.
      const embedModels = Object.entries(LLM_PROVIDERS)
        .filter(([, p]) => p.apiKey && p.embedModel)
        .map(([name, p]) => `${name}:${p.embedModel}`);
      if (embedModels.length > 1) {
        print(
          `[LLM] ${embedModels.length} embedding models configured (${embedModels.join(", ")}). ` +
            "A fallback embedding lands in a vector space dedup does not search — " +
            "keep embeddings on one provider and leave the others' *_EMBED_MODEL empty",
          "warning",
        );
      }

      // 1. Підключення до бази даних
      print("Connecting to database...");
      await database.connect();

      // 2. Синхронізація моделей
      print("Synchronizing database models...");
      await database.sync();

      // Лінивий медіа-шар TheFlow: резолвери платформ реєструються тут, у
      // корені композиції, — TheFlow знає лише контракт resolve(post).
      mediaResolver.register("telegram", new TelegramMediaResolver());
      mediaResolver.register("url", new UrlMediaResolver());

      // 3. Підключення до Telegram
      print("Connecting to Telegram...");
      await telegramClient.connect();

      // 4. Discord destination adapter — лише REST, без gateway-сесії.
      //    Без токена пересилання в Discord вимкнене, решта працює: Discord
      //    не повинен зупиняти Telegram → Telegram (docs/DISCORDAPP.md D2).
      print("Initializing Discord destination adapter...");
      try {
        const discordDestination = new DiscordDestinationAdapter(this.eventBus);
        await discordDestination.connect();
        this.discordDestination = discordDestination;
        this.messageRouter.registerAdapter("discord", discordDestination);
      } catch (error) {
        print(`Discord delivery disabled: ${error.message}`, "warning");
      }

      // 5. Ініціалізація та реєстрація Telegram destination adapter
      print("Initializing Telegram destination adapter...");
      this.telegramDestination = new TelegramDestinationAdapter(this.eventBus);
      await this.telegramDestination.connect();
      this.messageRouter.registerAdapter("telegram", this.telegramDestination);

      // 6. Запуск Telegram source listener
      print("Starting Telegram listener...");
      this.telegramListener = new TelegramSourceListener(this.eventBus);
      await this.telegramListener.start();

      // 6b. Стрічки: Reddit і RSS (ROADMAP §7). Лише опитування; без активних
      //     reddit/rss-джерел нічого не запускається.
      this.feedPoller = new FeedPoller({ eventBus: this.eventBus });
      await this.feedPoller.start();

      // 6c. Discord як джерело — user-акаунт у дочірньому процесі
      //     (docs/DISCORD_SOURCE.md). Без discord-джерел чи токена не
      //     запускається; збій тут не зупиняє решту старту.
      this.discordSource = new DiscordSelfSource(this.eventBus, {
        resolveMedia: (post, opts) => mediaResolver.resolve(post, opts),
      });
      try {
        await this.discordSource.connect();
        await this.discordSource.startListening();
      } catch (error) {
        print(`Discord source disabled: ${error.message}`, "warning");
      }

      // 7. Ініціалізація Cron Scheduler
      print("Initializing Cron Scheduler...");
      this.cronScheduler = new CronScheduler(this.eventBus);
      await this.cronScheduler.initialize([
        createDailyJob({
          crypto: new CryptoDataService(),
          loadImage,
          destinations: CRON_CONFIG.dailyinfo?.destinations ?? {},
          schedule: DAILY_REPORT.schedule,
          enabled: DAILY_REPORT.enabled,
          log: print,
        }),
      ]);

      // 7b. Дайджест TheFlow (фаза 5) — той самий шлях, що й cron-звіт:
      //     синтетичний message.received у digest_destinations з routing.json.
      const digestDestinations = copyDestinations(ROUTING.digest_destinations);
      if (Object.keys(digestDestinations).length > 0) {
        this.cronScheduler.scheduleJob({
          id: "theflow-digest",
          schedule: FLOW_DIGEST.schedule,
          description: `TheFlow digest (last ${FLOW_DIGEST.hours}h)`,
          handler: () => buildDigestMessage({
            hours: FLOW_DIGEST.hours,
            perTopic: FLOW_DIGEST.perTopic,
            excludeSignals: FLOW_DIGEST.excludeSignals,
            topicOrder: Object.keys(CATEGORIES.topics ?? {}),
            destinations: digestDestinations,
          }),
        });
      }

      // 8. TheFlow enrichment worker — drains `pending` posts through the
      //    LLM gateway. Shadow mode: verdicts land in `posts`, routing
      //    ignores them (phase 1). Off unless a primary provider key is set.
      const primaryKey = LLM_PROVIDERS[LLM_PRIMARY]?.apiKey;
      if (ENRICH_WORKER_ENABLED && primaryKey) {
        print("Starting TheFlow enrichment worker...");
        const gateway = new LLMGateway();
        // Той самий gateway — і для семантичного пошуку (§9.1): одна черга,
        // один облік квоти, пошук іде з пріоритетом `low` і першим поступається.
        this.llmGateway = gateway;
        // Стадія 1.5 (vision) ін'єктується, а не імпортується воркером: вона
        // ходить у Telegram через резолвер медіа, а воркер за дизайном
        // Telegram не знає. Без провайдера з vision стадія сама повертає
        // "unavailable", і збагачення йде як раніше.
        const vision = new VisionStage({ gateway, resolver: mediaResolver, ttlHours: VISION_CACHE_TTL_HOURS });
        const flowFor = this.flowFor;
        // Дедуплікація (§6) — у тіку воркера, одразу після збагачення.
        const dedup = DEDUP.enabled
          ? new DedupStage({
            taxonomy: CATEGORIES,
            thresholds: DEDUP,
            flowFor,
            batchSize: DEDUP.batchSize,
            boilerplateMin: DEDUP.boilerplateMin,
            boilerplateDays: DEDUP.boilerplateDays,
            log: print,
          })
          : null;
        // Delta-виклик (§6.6) — що новий пост кластера додає до канонічного.
        const delta = DEDUP.enabled ? new DeltaStage({ gateway, log: print }) : null;
        // Few-shot з міток `flow review` (фаза 5); без міток — порожньо.
        const fewShot = FLOW_FEWSHOT.enabled ? new FewShotStore(FLOW_FEWSHOT) : null;
        // Triage заголовків новин (§14.3): пропущене стає постом через опитувач
        // стрічок — тим самим шляхом, що й елемент без triage.
        const triage = new TriageStage({
          gateway,
          promote: (row) => this.feedPoller.promote(row),
          examples: FLOW_FEWSHOT.enabled ? createTriageExamples({ refreshMs: FLOW_FEWSHOT.refreshMs }) : null,
        });
        this.enrichWorker = new EnrichWorker({ gateway, vision, flowFor, dedup, delta, fewShot, triage });
        this.enrichWorker.start();

        // Прибирання кешу vision: на старті й далі кожні 6 год. unref() — щоб
        // таймер обслуговування не тримав процес живим при зупинці.
        const sweepVisionCache = () =>
          VisionCache.sweep({ ttlHours: VISION_CACHE_TTL_HOURS })
            .then((n) => n && print(`[VISION] cache sweep removed ${n} row(s)`, "debug"))
            .catch((error) => print(`[VISION] cache sweep failed: ${error.message}`, "warning"));
        sweepVisionCache();
        this.visionSweepTimer = setInterval(sweepVisionCache, MAINTENANCE_SWEEP_HOURS * HOUR);
        this.visionSweepTimer.unref();

        // Кандидати triage — лише заголовки, живуть FLOW_TRIAGE.retentionDays.
        const sweepDiscovered = () =>
          DiscoveredItem.sweep({ retentionDays: FLOW_TRIAGE.retentionDays })
            .then((n) => n && print(`[TRIAGE] swept ${n} old candidate(s)`, "debug"))
            .catch((error) => print(`[TRIAGE] sweep failed: ${error.message}`, "warning"));
        sweepDiscovered();
        this.triageSweepTimer = setInterval(sweepDiscovered, MAINTENANCE_SWEEP_HOURS * HOUR);
        this.triageSweepTimer.unref();
      } else {
        print(
          `TheFlow enrichment worker inactive (${
            !ENRICH_WORKER_ENABLED ? "ENRICH_WORKER_ENABLED=false" : `no ${LLM_PRIMARY} API key`
          })`,
          "warning",
        );
      }

      // 8a'. Точка перегляду зберігання (§13.9): одне попередження на старті,
      //      не алерт — нічого не зламалось, просто час вирішити.
      try {
        const storage = assessStorage(await collectStorage());
        if (storage.reviewDue) print(`[THEFLOW] ${storage.note}`, "warning");
      } catch (error) {
        print(`[THEFLOW] storage check failed: ${error.message}`, "debug");
      }

      // 8b. Нагляд за TheFlow: застій pending, лавина failed, тиша ingest.
      //     Алерт іде тим самим шляхом, що й cron-повідомлення — синтетичним
      //     message.received у health_destinations з routing.json. Без них —
      //     лише в лог: мовчазний нагляд кращий, ніж жодного.
      const healthDestinations = copyDestinations(ROUTING.health_destinations);
      if (Object.keys(healthDestinations).length === 0) {
        print("[FLOW HEALTH] no health_destinations in routing.json — alerts go to the log only", "warning");
      }
      this.flowHealth = new FlowHealthMonitor({
        collect: () => collectHealthSnapshot({
          failureWindowMin: FLOW_HEALTH.failureWindowMin,
          quota: primaryQuota(LLM_PROVIDERS, LLM_PRIMARY),
        }),
        notify: (text) => {
          if (Object.keys(healthDestinations).length === 0) return;
          this.eventBus.emitMessageReceived({
            platform: "theflow",
            text,
            source: { name: "TheFlow health", destinations: healthDestinations },
            metadata: { source: "theflow-health" },
          });
        },
        thresholds: FLOW_HEALTH,
        intervalMs: FLOW_HEALTH.intervalMin * MINUTE,
        repeatMs: FLOW_HEALTH.repeatHours * HOUR,
        workerRunning: Boolean(this.enrichWorker),
        log: print,
      });
      this.flowHealth.start();

      // 8b'. Доставка TheFlow (§5.4–5.6). Вимкнена, доки оператор не
      //      ввімкне FLOW_DELIVERY_ENABLED — тіньовий режим. Відправка — через
      //      наявний MessageRouter, медіа — через резолвер, ліниво.
      if (FLOW_DELIVERY.enabled) {
        this.flowDelivery = new FlowDelivery({
          route: (messageData) => this.messageRouter.routeMessage(messageData),
          // §6.6: відповідь в одне призначення і правка надісланого — через
          // ті самі адаптери, що й відправка.
          sendTo: (platform, id, messageData) => this.messageRouter.sendToDestination(platform, id, messageData),
          edit: (...args) => this.editVia(...args),
          resolveMedia: (post, opts) => mediaResolver.resolve(post, opts),
          routing: ROUTING,
          flowFor: this.flowFor,
          // Переклад постів не українською — через той самий gateway (одна
          // черга й облік квоти). Без провайдера доставка шле оригінал.
          translate: this.llmGateway ? (input) => this.llmGateway.translate(input) : null,
          dedupEnabled: DEDUP.enabled,
          maxAgeHours: FLOW_DELIVERY.maxAgeHours,
          batchSize: FLOW_DELIVERY.batchSize,
          maxAttempts: FLOW_DELIVERY.maxAttempts,
          intervalMs: FLOW_DELIVERY.intervalMs,
          log: print,
        });
        this.flowDelivery.start();
        print(`TheFlow delivery ON — posts newer than ${FLOW_DELIVERY.maxAgeHours}h are sent`, "warning");
      } else {
        print("TheFlow delivery off (shadow mode) — FLOW_DELIVERY_ENABLED=true to send; `flow preview` to look first");
      }

      // 8b''. Статус-борд: джерела, що мовчать, і канали без оновлень —
      //      одне повідомлення в кожному status_destinations, правиться на
      //      місці. Без них не запускається.
      const statusDestinations = copyDestinations(ROUTING.status_destinations);
      const statusIdProblems = destinationIdProblems(statusDestinations, "status_destinations");
      if (statusIdProblems.length) {
        // Заглушка до створення каналу — не стукати в неї щогодини.
        print(`[STATUS] board off: ${statusIdProblems.join("; ")}`, "warning");
      } else if (Object.keys(statusDestinations).length > 0) {
        this.statusBoard = new StatusBoard({
          collect: () => collectStatus({ routing: ROUTING, adapterFor: (platform) => this.messageRouter.adapters.get(platform) }),
          destinations: statusDestinations,
          send: (platform, id, messageData) => this.messageRouter.sendToDestination(platform, id, messageData),
          edit: (platform, channelId, messageId, messageData) => this.editVia(platform, channelId, messageId, messageData),
          store: StatusMessage,
          thresholds: STATUS,
          intervalMs: STATUS.intervalMin * MINUTE,
          log: print,
        });
        this.statusBoard.start({ firstDelayMs: STATUS.firstDelayMs });
        print(`Status board ON — every ${STATUS.intervalMin} min`);
      }

      // 8c. Пошук по історії (§9.1). Відповідає на запит "theflow.search" —
      //     так його питає discordapp (/search), не імпортуючи ядро (D1).
      //     Keyword працює завжди; semantic — лише коли є gateway.
      const historySearch = new HistorySearch({ gateway: this.llmGateway ?? null });
      this.eventBus.handle("theflow.search", (query) => historySearch.search(query));

      // 9. discordapp — останнім і без права зупинити старт (D3): невдалий
      //    логін лише попереджає і повторюється у фоні.
      print("Starting discordapp...");
      this.discordApp = new DiscordApp({
        eventBus: this.eventBus,
        gateway: discordGateway,
        config: {
          enabled: DISCORD_APP_ENABLED,
          hasToken: Boolean(DISCORD_BOT_TOKEN),
          whitelist: DISCORD_COMMAND_WHITELIST,
          guildIds: DISCORD_GUILD_IDS,
        },
      });
      await this.discordApp.start();

      print("Inemuri started successfully", "success");
      print("System is now routing messages...", "success");
    } catch (error) {
      print(error.message, "error");
      printStack(error);
      await this.stop();
    }
  }

  /**
   * Зупинка системи та очищення ресурсів
   */
  async stop() {
    print("Shutting down Inemuri...", "warning");

    try {
      // Зупиняємо enrichment worker
      // Воркер і доставка дописують поточний тік до того, як закриється база.
      // Паралельно, бо незалежні; кожен чекає не довше за свій grace.
      if (this.enrichWorker) print("Stopping TheFlow enrichment worker...");
      if (this.flowHealth) this.flowHealth.stop();
      if (this.statusBoard) this.statusBoard.stop();
      const finished = await Promise.all([
        this.enrichWorker?.stop() ?? true,
        this.flowDelivery?.stop() ?? true,
      ]);
      if (finished.includes(false)) print("TheFlow tick still running after the grace period — stopping anyway", "warning");
      if (this.feedPoller) this.feedPoller.stop();
      if (this.discordSource) {
        print("Stopping Discord source...");
        await this.discordSource.stopListening();
      }
      if (this.visionSweepTimer) {
        clearInterval(this.visionSweepTimer);
        this.visionSweepTimer = null;
      }
      if (this.triageSweepTimer) {
        clearInterval(this.triageSweepTimer);
        this.triageSweepTimer = null;
      }

      // Зупиняємо cron scheduler
      if (this.cronScheduler) {
        print("Stopping Cron Scheduler...");
        await this.cronScheduler.stop();
      }

      // Зупиняємо discordapp (gateway-сесію)
      if (this.discordApp) {
        print("Stopping discordapp...");
        await this.discordApp.stop();
      }

      // Зупиняємо listeners
      if (this.telegramListener) {
        print("Stopping Telegram listener...");
        await this.telegramListener.stop();
      }

      // Відключаємо destination adapters
      if (this.discordDestination) {
        print("Disconnecting Discord destination adapter...");
        await this.discordDestination.disconnect();
      }

      if (this.telegramDestination) {
        print("Disconnecting Telegram destination adapter...");
        await this.telegramDestination.disconnect();
      }

      // Від'єднуємося від клієнтів
      print("Disconnecting from Telegram...");
      await telegramClient.disconnect();

      // Закриваємо з'єднання з базою
      print("Disconnecting from database...");
      await database.disconnect();

      print("Inemuri stopped successfully", "success");
    } catch (error) {
      print(`Error during shutdown: ${error.message}`, "error");
    } finally {
      process.exit(0);
    }
  }
}

const inemuri = new Inemuri();

// Graceful shutdown handlers
process.on("SIGTERM", () => inemuri.stop());
process.on("SIGINT", () => inemuri.stop());

inemuri.main();

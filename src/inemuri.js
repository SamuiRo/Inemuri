import { WELCOM_MESSAGE, SUB_TITTLE } from "./shared/message.js";
import { print, banner } from "./shared/utils.js";
import database from "./module/teapot/sqlite/sqlite_db.js";
import EventBus from "./module/eventbus/EventBus.js";
import MessageRouter from "./module/routing/MessageRouter.js";
import telegramClient from "./module/telegram/TelegramClient.js";
import discordGateway from "./module/discord/DiscordGateway.js";
import TelegramSourceListener from "./sources/telegram/TelegramSourceListener.js";
import DiscordDestinationAdapter from "./destinations/discord/DiscordDestination.js";
import TelegramDestinationAdapter from "./destinations/telegram/TelegramDestination.js";
import CronScheduler from "./module/cron/CronScheduler.js";
import DiscordApp from "./module/discordapp/DiscordApp.js";
import { CRON_JOBS } from "./config/cronjobs.js";
import LLMGateway from "./services/ai/LLMGateway.js";
import EnrichWorker from "./module/theflow/EnrichWorker.js";
import VisionStage from "./module/theflow/VisionStage.js";
import { Source, VisionCache } from "./module/teapot/models/index.js";
import { validateRouting } from "./module/theflow/ResolveStage.js";
import {
  VISION_CACHE_TTL_HOURS,
  CATEGORIES,
  ROUTING,
  CONFIG_WARNINGS,
  ENRICH_WORKER_ENABLED,
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

    this.setupEventHandlers();
  }

  /**
   * Налаштування обробників подій
   */
  setupEventHandlers() {
    // Обробка критичних помилок на рівні системи
    this.eventBus.on("error.occurred", (errorData) => {
      print(`[ERROR] ${errorData.source}: ${errorData.error}`, "error");
      console.error(errorData);
      // Тут можна додати логіку для критичних помилок
      // наприклад, запис в логи, алерти, тощо
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

      // 7. Ініціалізація Cron Scheduler
      print("Initializing Cron Scheduler...");
      this.cronScheduler = new CronScheduler(this.eventBus);
      await this.cronScheduler.initialize(CRON_JOBS);

      // 8. TheFlow enrichment worker — drains `pending` posts through the
      //    LLM gateway. Shadow mode: verdicts land in `posts`, routing
      //    ignores them (phase 1). Off unless a primary provider key is set.
      const primaryKey = LLM_PROVIDERS[LLM_PRIMARY]?.apiKey;
      if (ENRICH_WORKER_ENABLED && primaryKey) {
        print("Starting TheFlow enrichment worker...");
        const gateway = new LLMGateway();
        // Стадія 1.5 (vision) ін'єктується, а не імпортується воркером: вона
        // ходить у Telegram через резолвер медіа, а воркер за дизайном
        // Telegram не знає. Без провайдера з vision стадія сама повертає
        // "unavailable", і збагачення йде як раніше.
        const vision = new VisionStage({ gateway, ttlHours: VISION_CACHE_TTL_HOURS });
        // Конфіг джерела кешується на весь процес — як і в TelegramSourceListener,
        // що будує свої кеші на старті. Зміна flow.vision через reseed
        // підхоплюється перезапуском, як і решта налаштувань джерела.
        const sources = new Map();
        const flowFor = async (post) => {
          if (!sources.has(post.source_id)) sources.set(post.source_id, await Source.findByPk(post.source_id));
          return sources.get(post.source_id)?.getFlowConfig() ?? null;
        };
        this.enrichWorker = new EnrichWorker({ gateway, vision, flowFor });
        this.enrichWorker.start();

        // Прибирання кешу vision: на старті й далі кожні 6 год. unref() — щоб
        // таймер обслуговування не тримав процес живим при зупинці.
        const sweepVisionCache = () =>
          VisionCache.sweep({ ttlHours: VISION_CACHE_TTL_HOURS })
            .then((n) => n && print(`[VISION] cache sweep removed ${n} row(s)`, "debug"))
            .catch((error) => print(`[VISION] cache sweep failed: ${error.message}`, "warning"));
        sweepVisionCache();
        this.visionSweepTimer = setInterval(sweepVisionCache, 6 * 3_600_000);
        this.visionSweepTimer.unref();
      } else {
        print(
          `TheFlow enrichment worker inactive (${
            !ENRICH_WORKER_ENABLED ? "ENRICH_WORKER_ENABLED=false" : `no ${LLM_PRIMARY} API key`
          })`,
          "warning",
        );
      }

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
      console.error("An error occurred while starting Inemuri:", error);
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
      if (this.enrichWorker) {
        print("Stopping TheFlow enrichment worker...");
        this.enrichWorker.stop();
      }
      if (this.visionSweepTimer) {
        clearInterval(this.visionSweepTimer);
        this.visionSweepTimer = null;
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

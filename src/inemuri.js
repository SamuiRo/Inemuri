import { WELCOM_MESSAGE, SUB_TITTLE } from "./shared/message.js";
import { print, banner } from "./shared/utils.js";
import database from "./module/teapot/sqlite/sqlite_db.js";
import EventBus from "./module/eventbus/EventBus.js";
import MessageRouter from "./module/routing/MessageRouter.js";
import telegramClient from "./module/telegram/TelegramClient.js";
import discordClient from "./module/discord/DiscordClient.js";
import TelegramSourceListener from "./sources/telegram/TelegramSourceListener.js";
import DiscordDestinationAdapter from "./destinations/discord/DiscordDestination.js";
import TelegramDestinationAdapter from "./destinations/telegram/TelegramDestination.js";
import CronScheduler from "./module/cron/CronScheduler.js";
import DiscordCommandHandler from "./module/discord/DiscordCommandHandler.js";
import { CRON_JOBS, COMMANDS } from "./config/cronjobs.js";

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

    // Discord Command Handler
    this.commandHandler = null;

    this.setupEventHandlers();
  }

  /**
   * Налаштування обробників подій
   */
  setupEventHandlers() {
    // Обробка критичних помилок на рівні системи
    this.eventBus.on("error.occurred", (errorData) => {
      print(`[ERROR] ${errorData.source}: ${errorData.error}`, "error");
      console.log(errorData);
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

      // 1. Підключення до бази даних
      print("Connecting to database...");
      await database.connect();

      // 2. Синхронізація моделей
      print("Synchronizing database models...");
      await database.sync();

      // 3. Підключення до Telegram
      print("Connecting to Telegram...");
      await telegramClient.connect();

      // 4. Підключення до Discord
      print("Connecting to Discord...");
      await discordClient.connect();

      // 5. Ініціалізація та реєстрація Discord destination adapter
      print("Initializing Discord destination adapter...");
      this.discordDestination = new DiscordDestinationAdapter(this.eventBus);
      await this.discordDestination.connect();
      this.messageRouter.registerAdapter("discord", this.discordDestination);

      // 6. Ініціалізація та реєстрація Telegram destination adapter
      print("Initializing Telegram destination adapter...");
      this.telegramDestination = new TelegramDestinationAdapter(this.eventBus);
      await this.telegramDestination.connect();
      this.messageRouter.registerAdapter("telegram", this.telegramDestination);

      // 7. Запуск Telegram source listener
      print("Starting Telegram listener...");
      this.telegramListener = new TelegramSourceListener(this.eventBus);
      await this.telegramListener.start();

      // 8. Ініціалізація Cron Scheduler
      print("Initializing Cron Scheduler...");
      this.cronScheduler = new CronScheduler(this.eventBus);
      await this.cronScheduler.initialize(CRON_JOBS);

      // 9. Ініціалізація Discord Command Handler
      print("Initializing Discord Command Handler...");
      this.commandHandler = new DiscordCommandHandler(
        this.eventBus,
        discordClient,
        COMMANDS
      );
      await this.commandHandler.initialize();

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
      // Зупиняємо cron scheduler
      if (this.cronScheduler) {
        print("Stopping Cron Scheduler...");
        await this.cronScheduler.stop();
      }

      // Очищаємо Discord команди
      if (this.commandHandler) {
        print("Cleaning up Discord commands...");
        await this.commandHandler.cleanup();
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
      print("Disconnecting from Discord...");
      await discordClient.disconnect();

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
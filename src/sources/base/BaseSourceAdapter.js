import { print } from "../../shared/utils.js";

/**
 * Базовий абстрактний клас для всіх Source адаптерів
 * Визначає єдиний інтерфейс для роботи з різними платформами
 */
class BaseSourceAdapter {
  constructor(platform, eventBus) {
    if (new.target === BaseSourceAdapter) {
      throw new Error(
        "BaseSourceAdapter is abstract and cannot be instantiated directly",
      );
    }

    this.platform = platform;
    this.eventBus = eventBus;
    this.isListening = false;
  }

  /**
   * Підключення до платформи (має бути реалізовано в нащадках)
   */
  async connect() {
    throw new Error(
      `connect() must be implemented in ${this.constructor.name}`,
    );
  }

  /**
   * Початок прослуховування повідомлень (має бути реалізовано в нащадках)
   */
  async startListening() {
    throw new Error(
      `startListening() must be implemented in ${this.constructor.name}`,
    );
  }

  /**
   * Зупинка прослуховування (має бути реалізовано в нащадках)
   */
  async stopListening() {
    throw new Error(
      `stopListening() must be implemented in ${this.constructor.name}`,
    );
  }

  /**
   * Від'єднання від платформи (може бути перевизначено в нащадках)
   */
  async disconnect() {
    await this.stopListening();
  }

  /**
   * Парсинг повідомлення в уніфікований формат (має бути реалізовано в нащадках)
   */
  parseMessage(rawMessage) {
    throw new Error(
      `parseMessage() must be implemented in ${this.constructor.name}`,
    );
  }

  /**
   * Обробка вхідного повідомлення (спільна логіка для всіх адаптерів)
   */
  async handleMessage(rawMessage) {
    try {
      // Парсимо повідомлення в уніфікований формат
      const messageData = this.parseMessage(rawMessage);

      if (!messageData || !messageData.channelId) {
        print(`Invalid message from ${this.platform}, skipping`, "warning");
        return;
      }

      print(
        `[${this.platform.toUpperCase()}] New message from channel ${messageData.channelId}`,
      );

      // Емітимо подію в Event Bus
      this.eventBus.emit("message.received", messageData);
    } catch (error) {
      print(
        `Error handling ${this.platform} message: ${error.message}`,
        "error",
      );
      console.error(error);

      // Емітимо помилку в Event Bus
      this.eventBus.emit("error.occurred", {
        source: this.platform,
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Повний цикл запуску адаптера
   */
  async start() {
    try {
      print(`Starting ${this.platform} adapter...`);
      await this.connect();
      await this.startListening();
      print(`${this.platform} adapter started successfully`, "success");
    } catch (error) {
      print(
        `Failed to start ${this.platform} adapter: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Повний цикл зупинки адаптера
   */
  async stop() {
    try {
      print(`Stopping ${this.platform} adapter...`);
      await this.disconnect();
      print(`${this.platform} adapter stopped successfully`, "success");
    } catch (error) {
      print(
        `Error stopping ${this.platform} adapter: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Перезапуск адаптера
   */
  async restart() {
    print(`Restarting ${this.platform} adapter...`);
    await this.stop();
    await this.start();
  }

  /**
   * Перевірка статусу
   */
  getStatus() {
    return {
      platform: this.platform,
      isListening: this.isListening,
    };
  }
}

export default BaseSourceAdapter;

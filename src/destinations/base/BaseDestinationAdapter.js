import { print } from "../../shared/utils.js";

/**
 * Базовий абстрактний клас для всіх Destination адаптерів
 * Визначає єдиний інтерфейс для відправки повідомлень на різні платформи
 */
class BaseDestinationAdapter {
  constructor(platform, eventBus) {
    if (new.target === BaseDestinationAdapter) {
      throw new Error(
        "BaseDestinationAdapter is abstract and cannot be instantiated directly",
      );
    }

    this.platform = platform;
    this.eventBus = eventBus;
    this.isConnected = false;
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
   * Від'єднання від платформи (може бути перевизначено в нащадках)
   */
  async disconnect() {
    this.isConnected = false;
  }

  /**
   * Відправка повідомлення (має бути реалізовано в нащадках)
   * @param {string} destinationId - ID каналу/чату куди відправляти
   * @param {Object} messageData - Дані повідомлення в уніфікованому форматі
   */
  async sendMessage(destinationId, messageData) {
    throw new Error(
      `sendMessage() must be implemented in ${this.constructor.name}`,
    );
  }

  /**
   * Форматування повідомлення під специфіку платформи (може бути перевизначено)
   * @param {Object} messageData - Дані повідомлення
   * @returns {Object} - Відформатовані дані
   */
  async formatMessage(messageData) {
    // За замовчуванням - без форматування
    return messageData;
  }

  /**
   * Завантаження медіа файлів (може бути перевизначено)
   * @param {Array|Object} media - Медіа з повідомлення
   * @returns {Array} - Масив завантажених медіа
   */
  async downloadMedia(media) {
    // Реалізується в нащадках якщо потрібно
    return null;
  }

  /**
   * Відправка медіа файлів (може бути перевизначено)
   * @param {string} destinationId - ID каналу
   * @param {Array} media - Масив медіа для відправки
   */
  async uploadMedia(destinationId, media) {
    // Реалізується в нащадках якщо потрібно
  }

  /**
   * Повний цикл запуску адаптера
   */
  async start() {
    try {
      print(`Starting ${this.platform} destination adapter...`);
      await this.connect();
      print(
        `${this.platform} destination adapter started successfully`,
        "success",
      );
    } catch (error) {
      print(
        `Failed to start ${this.platform} destination adapter: ${error.message}`,
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
      print(`Stopping ${this.platform} destination adapter...`);
      await this.disconnect();
      print(
        `${this.platform} destination adapter stopped successfully`,
        "success",
      );
    } catch (error) {
      print(
        `Error stopping ${this.platform} destination adapter: ${error.message}`,
        "error",
      );
      throw error;
    }
  }
}

export default BaseDestinationAdapter;

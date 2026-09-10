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
   * Опційні можливості адаптера. Шлях доставки перевіряє це замість того,
   * щоб припускати. Нащадки перевизначають потрібне.
   * @returns {{ edit: boolean }}
   */
  get capabilities() {
    return { edit: false };
  }

  /**
   * Відправка повідомлення (має бути реалізовано в нащадках)
   * @param {string} destinationId - ID каналу/чату куди відправляти
   * @param {Object} messageData - Дані повідомлення в уніфікованому форматі
   * @returns {Promise<object|null>} Надіслане повідомлення платформи (або null).
   */
  async sendMessage(destinationId, messageData) {
    throw new Error(
      `sendMessage() must be implemented in ${this.constructor.name}`,
    );
  }

  /**
   * Ідентичність надісланого повідомлення — для clusters.delivered і механізму
   * linked (docs/theflow/DELIVERY.md). Нащадки перевизначають; база не знає
   * форми platform-об'єкта.
   * @param {object} sentMessage  Те, що повернув sendMessage().
   * @param {string} destinationId
   * @returns {{ platform: string, channel_id: string, message_id: (number|string|null), sent_at: Date } | null}
   */
  describeSent(sentMessage, destinationId) {
    return null;
  }

  /**
   * Редагування вже надісланого повідомлення. Опційна можливість —
   * див. `capabilities.edit`. База кидає, щоб виклик без перевірки був гучним.
   * @param {string} destinationId
   * @param {(number|string)} messageId
   * @param {(string|object)} payload  Текст або готовий payload платформи.
   */
  async editMessage(destinationId, messageId, payload) {
    throw new Error(`editMessage() is not supported by the ${this.platform} adapter`);
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

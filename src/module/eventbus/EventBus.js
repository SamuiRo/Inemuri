import { EventEmitter } from "events";

/**
 * Центральна шина подій для комунікації між модулями системи Inemuri
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setupDefaultHandlers();
  }

  /**
   * Налаштування базових обробників подій
   */
  setupDefaultHandlers() {
    // Логування всіх подій для debugging (опціонально)
    // this.onAny((eventName, data) => {
    //   console.log(`[EventBus] ${eventName}`, data);
    // });
  }

  /**
   * Емітує подію отримання нового повідомлення
   * @param {Object} messageData - Дані повідомлення
   */
  emitMessageReceived(messageData) {
    this.emit("message.received", messageData);
  }

  /**
   * Емітує подію визначення маршруту
   * @param {Object} routeData - Дані маршруту
   */
  emitMessageRouted(routeData) {
    this.emit("message.routed", routeData);
  }

  /**
   * Емітує подію обробки повідомлення
   * @param {Object} processData - Дані обробки
   */
  emitMessageProcessed(processData) {
    this.emit("message.processed", processData);
  }

  /**
   * Емітує подію відправки повідомлення
   * @param {Object} sendData - Дані відправки
   */
  emitMessageSent(sendData) {
    this.emit("message.sent", sendData);
  }

  emitMessageScheduled(messageData) {
    this.emit("message.scheduled", messageData);
  }

  /**
   * Емітує подію помилки
   * @param {Object} errorData - Дані помилки
   */
  emitError(errorData) {
    this.emit("error.occurred", errorData);
  }
}

export default EventBus;

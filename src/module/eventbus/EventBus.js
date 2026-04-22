import { EventEmitter } from "events";
import { print } from "../../shared/utils.js";

/**
 * Центральна шина подій для комунікації між модулями системи Inemuri
 * З підтримкою обробки помилок в async handlers
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setupDefaultHandlers();
    this.setupErrorHandling();
  }

  /**
   * Налаштування обробки помилок для async event handlers
   */
  setupErrorHandling() {
    // Обробка необроблених помилок в async event handlers
    this.on("error", (error) => {
      print(`[EventBus] Uncaught error in event handler: ${error.message}`, "error");
      console.error(error);
    });
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
   * Безпечний emit з обробкою помилок для async handlers
   * @param {string} eventName - Назва події
   * @param {*} data - Дані події
   */
  async emitAsync(eventName, data) {
    const listeners = this.listeners(eventName);
    
    for (const listener of listeners) {
      try {
        const result = listener(data);
        // Якщо handler async - чекаємо його завершення
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        print(`[EventBus] Error in ${eventName} handler: ${error.message}`, "error");
        console.error(error);
        
        // Емітуємо помилку але не падаємо
        this.emitError({
          source: "eventbus",
          event: eventName,
          error: error.message,
          stack: error.stack,
        });
      }
    }
  }

  /**
   * Емітує подію отримання нового повідомлення
   * @param {Object} messageData - Дані повідомлення
   */
  emitMessageReceived(messageData) {
    // Використовуємо звичайний emit, але handlers мають обробляти помилки самі
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
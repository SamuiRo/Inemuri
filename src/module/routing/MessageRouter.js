import { print } from "../../shared/utils.js";

class MessageRouter {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.adapters = new Map();

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.eventBus.on("message.received", async (messageData) => {
      await this.routeMessage(messageData);
    });
  }

  /**
   * Реєстрація адаптера платформи
   * @param {string} platform - Назва платформи (telegram, discord, etc.)
   * @param {BaseDestinationAdapter} adapter - Екземпляр адаптера
   */
  registerAdapter(platform, adapter) {
    if (this.adapters.has(platform)) {
      print(
        `Adapter for ${platform} already registered, replacing...`,
        "warning",
      );
    }

    this.adapters.set(platform, adapter);
    print(`Registered destination adapter for ${platform}`, "success");
  }

  /**
   * Видалення адаптера
   */
  unregisterAdapter(platform) {
    this.adapters.delete(platform);
    print(`Unregistered destination adapter for ${platform}`);
  }

  /**
   * Головний метод маршрутизації повідомлення
   * @param {Object} messageData - Дані повідомлення з message.received події
   */
  async routeMessage(messageData) {
    try {
      // console.log("messageData", messageData)
      console.log("messageData", messageData.source)
      // Перевіряємо чи є destinations
      const destinations = messageData.source?.destinations;

      if (!destinations || Object.keys(destinations).length === 0) {
        print(
          `No destinations configured for source ${messageData.source?.name || messageData.channelId}`,
          "warning",
        );
        return;
      }

      print(
        `[ROUTER] Routing message from ${messageData.platform}:${messageData.source?.name || messageData.channelId}`,
      );

      for (const [platform, destinationList] of Object.entries(destinations)) {
        // Пропускаємо порожні масиви
        if (!Array.isArray(destinationList) || destinationList.length === 0) {
          continue;
        }
        print(
          `  ↳ Routing to ${destinationList.length} ${platform} destination(s)`,
        );

        for (const destinationId of destinationList) {
          await this.sendToDestination(
            platform,
            destinationId,
            messageData,
          );
        }
      }

      // Емітимо подію про завершення маршрутизації
      this.eventBus.emit("message.routed", {
        messageId: messageData.messageId,
        sourceChannel: messageData.channelId,
        sourcePlatform: messageData.platform,
      });
    } catch (error) {
      print(`[ROUTER] Error routing message: ${error.message}`, "error");
      console.error(error);

      this.eventBus.emit("error.occurred", {
        source: "router",
        error: error.message,
        messageId: messageData.messageId,
        stack: error.stack,
      });
    }
  }

  /**
   * Відправка до конкретного destination
   * @param {string} platform - Платформа (telegram, discord, etc.)
   * @param {string} destinationId - ID каналу/чату
   * @param {Object} messageData - Дані повідомлення
   * @returns {boolean} - true якщо успішно, false якщо помилка
   */
  async sendToDestination(platform, destinationId, messageData) {
    try {
      // Отримуємо адаптер для платформи
      const adapter = this.adapters.get(platform);

      if (!adapter) {
        print(
          `[ROUTER] No adapter registered for platform: ${platform}`,
          "error",
        );

        this.eventBus.emit("error.occurred", {
          source: "router",
          error: `No adapter for platform: ${platform}`,
          platform,
          destinationId,
        });

        return false;
      }

      // Перевіряємо чи адаптер підключений
      if (!adapter.isConnected) {
        print(
          `[ROUTER] Adapter for ${platform} is not connected, attempting to connect...`,
          "warning",
        );
        await adapter.connect();
      }

      await adapter.sendMessage(destinationId, messageData);

      // Емітимо подію про успішну відправку
      this.eventBus.emit("message.sent", {
        platform,
        destinationId,
        messageId: messageData.messageId,
        sourceChannel: messageData.channelId,
        timestamp: new Date(),
      });

      print(`[ROUTER] ✓ Sent to ${platform}:${destinationId}`, "success");

      return true;
    } catch (error) {
      print(
        `[ROUTER] ✗ Failed to send to ${platform}:${destinationId}: ${error.message}`,
        "error",
      );

      // Помилка вже була залогована в адаптері через handleSendError
      // Тут просто повертаємо false
      return false;
    }
  }
}

export default MessageRouter;
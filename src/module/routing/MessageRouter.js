import { print, printStack } from "../../shared/utils.js";

class MessageRouter {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.adapters = new Map();

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    // CRITICAL FIX: Обгортаємо async handler в try-catch
    // щоб помилки не ламали event listener
    this.eventBus.on("message.received", async (messageData) => {
      try {
        await this.routeMessage(messageData);
      } catch (error) {
        print(`[ROUTER] Critical error in message.received handler: ${error.message}`, "error");
        printStack(error);
        
        // Емітуємо помилку але продовжуємо роботу
        this.eventBus.emitError({
          source: "router",
          error: error.message,
          messageData,
          stack: error.stack,
        });
      }
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

      // Ідентичності всіх успішно надісланих повідомлень у цьому виклику.
      const delivered = [];

      for (const [platform, destinationList] of Object.entries(destinations)) {
        // Пропускаємо порожні масиви
        if (!Array.isArray(destinationList) || destinationList.length === 0) {
          continue;
        }
        print(
          `  ↳ Routing to ${destinationList.length} ${platform} destination(s)`,
        );

        for (const destinationId of destinationList) {
          // CRITICAL FIX: Обгортаємо кожну відправку в try-catch
          // щоб помилка в одному destination не ламала інші
          try {
            const identity = await this.sendToDestination(
              platform,
              destinationId,
              messageData,
            );
            // Ідентичність надісланого — для clusters.delivered / linked
            // (docs/theflow/DELIVERY.md). Класичний форвардинг її ігнорує.
            if (identity) delivered.push(identity);
          } catch {
            print(
              `[ROUTER] Failed to send to ${platform}:${destinationId}, but continuing with other destinations`,
              "warning",
            );
            // Помилка вже залогована, продовжуємо з іншими destinations
          }
        }
      }

      // Емітимо подію про завершення маршрутизації
      this.eventBus.emit("message.routed", {
        messageId: messageData.messageId,
        sourceChannel: messageData.channelId,
        sourcePlatform: messageData.platform,
        delivered,
      });

      return delivered;
    } catch (error) {
      print(`[ROUTER] Error routing message: ${error.message}`, "error");
      printStack(error);

      this.eventBus.emit("error.occurred", {
        source: "router",
        error: error.message,
        messageId: messageData.messageId,
        stack: error.stack,
      });
      
      // Кидаємо помилку далі щоб її спіймав handler в setupEventHandlers
      throw error;
    }
  }

  /**
   * Відправка до конкретного destination
   * @param {string} platform - Платформа (telegram, discord, etc.)
   * @param {string} destinationId - ID каналу/чату
   * @param {Object} messageData - Дані повідомлення
   * @returns {Promise<object|null>} Ідентичність надісланого повідомлення
   *   `{ platform, channel_id, message_id, sent_at }`, або `null` при помилці.
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

        return null;
      }

      // Перевіряємо чи адаптер підключений
      if (!adapter.isConnected) {
        print(
          `[ROUTER] Adapter for ${platform} is not connected, attempting to connect...`,
          "warning",
        );
        await adapter.connect();
      }

      const sent = await adapter.sendMessage(destinationId, messageData);
      const identity =
        adapter.describeSent?.(sent, destinationId) ?? {
          platform,
          channel_id: String(destinationId),
          message_id: sent?.id ?? null,
          sent_at: new Date(),
        };

      // Емітимо подію про успішну відправку
      this.eventBus.emit("message.sent", {
        platform,
        destinationId,
        messageId: messageData.messageId,
        deliveredMessageId: identity.message_id,
        sourceChannel: messageData.channelId,
        timestamp: new Date(),
      });

      print(`[ROUTER] ✓ Sent to ${platform}:${destinationId}`, "success");

      return identity;
    } catch (error) {
      print(
        `[ROUTER] ✗ Failed to send to ${platform}:${destinationId}: ${error.message}`,
        "error",
      );

      // Помилка вже була залогована в адаптері через handleSendError
      return null;
    }
  }
}

export default MessageRouter;

import { NewMessage } from "telegram/events/index.js";

import { appendToTxt, print, saveToJson } from "../../shared/utils.js";
import { Source } from "../../module/teapot/models/index.js";
import telegramClient from "../../module/telegram/TelegramClient.js";
import BaseSourceAdapter from "../base/BaseSourceAdapter.js";
import messageFilter from "../../module/filters/MessageFilter.js";

class TelegramSourceListener extends BaseSourceAdapter {
  constructor(eventBus) {
    super("telegram", eventBus);
    this.client = null;
    this.whitelistedIds = [];
    // Кеш Source об'єктів для швидкого доступу
    this.sourcesCache = new Map(); // channelId -> Source instance
    // Кеш компільованих фільтрів для максимальної швидкості
    this.filtersCache = new Map(); // channelId -> compiled filter
    // Кеш компільованих replacements для препроцесингу
    this.replacementsCache = new Map(); // channelId -> compiled replacements
    // Зберігаємо bound версію handleMessage для коректного видалення
    this.boundHandleMessage = null;

    // Групування повідомлень (для альбомів/grouped media)
    this.messageGroups = new Map(); // groupedId -> { messages: [], timer: timeout }
    this.groupTimeout = 5000; // 5 секунд на збір групи

    // Типи медіа які потрібно завантажувати
    this.downloadableMediaTypes = ["photo", "video", "document", "animation"];
  }

  /**
   * Підключення до платформи
   */
  async connect() {
    try {
      this.client = telegramClient.getClient();
      print(`${this.platform} adapter connected`, "success");
    } catch (error) {
      throw new Error(`Failed to connect ${this.platform}: ${error.message}`);
    }
  }

  /**
   * Початок прослуховування
   */
  async startListening() {
    if (this.isListening) {
      print(`${this.platform} listener already started`, "warning");
      return;
    }

    try {
      // Отримуємо активні джерела з бази
      const sources = await Source.getActiveByPlatform(this.platform);

      if (sources.length === 0) {
        print(
          `No active ${this.platform} sources found in whitelist`,
          "warning",
        );
        return;
      }

      // Будуємо кеш
      this.sourcesCache.clear();
      this.filtersCache.clear();
      this.replacementsCache.clear();

      for (const source of sources) {
        this.sourcesCache.set(source.channel_id, source);

        // Компілюємо replacements одразу
        const compiledReplacements = messageFilter.compileReplacements(
          source.id,
          source.text_replacements,
        );
        this.replacementsCache.set(source.channel_id, compiledReplacements);

        // Компілюємо фільтри одразу
        const compiledFilter = messageFilter.compileFilter(
          source.id,
          source.filters,
        );
        this.filtersCache.set(source.channel_id, compiledFilter);
      }

      this.whitelistedIds = sources.map((s) => s.channel_id);

      // Конвертуємо ID в BigInt для Telegram API
      const chatIds = this.whitelistedIds.map((id) => BigInt(id));

      print(
        `Starting ${this.platform} listener for ${chatIds.length} channel(s)`,
      );

      const LOG_FILE = "./logs/listener_debug.txt";
      const log = async (msg) => {
        console.log(msg);
        await appendToTxt(LOG_FILE, msg);
      };

      //       {
      //   CONSTRUCTOR_ID: 1299050149,
      //   SUBCLASS_OF_ID: 2331323052,
      //   className: 'UpdateShortChatMessage',
      //   classType: 'constructor',
      //   flags: 2,
      //   out: true,
      //   mentioned: false,
      //   mediaUnread: false,
      //   silent: false,
      //   id: 467762,
      //   fromId: Integer { value: 525331942n },
      //   chatId: Integer { value: 638290424n },
      //   message: 'Я скоро буду',
      //   pts: 1009475,
      //   ptsCount: 1,
      //   date: 1771760882,
      //   fwdFrom: null,
      //   viaBotId: null,
      //   replyTo: null,
      //   entities: null,
      //   ttlPeriod: null
      // }

      // Створюємо bound версію handleMessage один раз
      // this.boundHandleMessage = (event) => this.handleMessage(event);
      this.boundHandleMessage = async (event) => {
        console.log()
        console.log("======================");
        console.log("======================");
        console.log({
          classname: event.className,
          from: event.message?.fromId,
          peerid: event.message?.peerId,
          sender: event.message?.senderId,
          message: event.message?.message,
        });
        await log(
          `from ${event.message?.fromId?.userId}, peerId: ${event.message?.peerId?.channelId}, sender: ${event.message.senderId}, message: ${event.message.message}`,
        );
        // ─────────────────────────────────────────────
        // КРОК 1: Тип події
        // ─────────────────────────────────────────────
        // const type = event.constructor.name;
        // const className = event.className;

        // // Службові апдейти — мовчки ігноруємо
        // const IGNORED_TYPES = [
        //   "UpdateConnectionState",
        //   "UpdateUserStatus",
        //   "UpdateReadHistoryInbox",
        //   "UpdateReadChannelInbox",
        //   "UpdateChannelMessageViews",
        //   "UpdateChannelUserTyping",
        //   "UpdateEditChannelMessage",
        // ];
        // if (IGNORED_TYPES.includes(type) || IGNORED_TYPES.includes(className))
        //   return;

        // // ─────────────────────────────────────────────
        // // КРОК 2: Перевірка що це нове повідомлення каналу
        // // ─────────────────────────────────────────────
        // if (className !== "UpdateNewChannelMessage") {
        //   await log(
        //     `[LISTENER] ⏭ Пропускаємо тип події: constructor="${type}" className="${className}"`,
        //   );
        //   return;
        // }

        // const ts = new Date().toISOString();
        // await log(`\n${"=".repeat(60)}`);
        // await log(`[LISTENER] 📩 [${ts}] Нова подія: className="${className}"`);

        // // ─────────────────────────────────────────────
        // // КРОК 3: Перевірка структури повідомлення
        // // ─────────────────────────────────────────────
        // const msg = event.message;

        // if (!msg) {
        //   await log(`[LISTENER] ❌ КРОК 3 FAIL: event.message відсутній`);
        //   await log(
        //     `[LISTENER]    event keys: ${Object.keys(event).join(", ")}`,
        //   );
        //   return;
        // }

        // if (!msg.peerId) {
        //   await log(`[LISTENER] ❌ КРОК 3 FAIL: msg.peerId відсутній`);
        //   await log(`[LISTENER]    msg keys: ${Object.keys(msg).join(", ")}`);
        //   return;
        // }

        // if (!msg.peerId.channelId) {
        //   await log(
        //     `[LISTENER] ❌ КРОК 3 FAIL: msg.peerId.channelId відсутній`,
        //   );
        //   await log(
        //     `[LISTENER]    msg.peerId className: ${msg.peerId.className}`,
        //   );
        //   await log(
        //     `[LISTENER]    msg.peerId: ${JSON.stringify(msg.peerId, (_, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2)}`,
        //   );
        //   return;
        // }

        // // ─────────────────────────────────────────────
        // // КРОК 4: Діагностика типів channelId
        // // ─────────────────────────────────────────────
        // const rawChannelId = msg.peerId.channelId;

        // await log(`[LISTENER] 🔍 КРОК 4: Діагностика channelId`);
        // await log(
        //   `[LISTENER]    rawChannelId:             ${String(rawChannelId)}`,
        // );
        // await log(
        //   `[LISTENER]    typeof rawChannelId:      ${typeof rawChannelId}`,
        // );
        // await log(
        //   `[LISTENER]    constructor name:         ${rawChannelId?.constructor?.name}`,
        // );
        // await log(
        //   `[LISTENER]    rawChannelId.value:       ${String(rawChannelId?.value)}`,
        // );
        // await log(
        //   `[LISTENER]    typeof .value:            ${typeof rawChannelId?.value}`,
        // );

        // // Визначаємо реальний BigInt значення channelId
        // // gram.js може повертати або BigInt напряму, або об'єкт { value: BigInt }
        // let channelIdBigInt;
        // if (typeof rawChannelId === "bigint") {
        //   channelIdBigInt = rawChannelId;
        //   await log(`[LISTENER]    ✅ channelId — це чистий BigInt`);
        // } else if (
        //   rawChannelId?.value !== undefined &&
        //   typeof rawChannelId.value === "bigint"
        // ) {
        //   channelIdBigInt = rawChannelId.value;
        //   await log(`[LISTENER]    ✅ channelId — це об'єкт з .value BigInt`);
        // } else {
        //   try {
        //     channelIdBigInt = BigInt(rawChannelId.toString());
        //     await log(
        //       `[LISTENER]    ⚠️ channelId конвертовано через toString() → BigInt`,
        //     );
        //   } catch (e) {
        //     await log(
        //       `[LISTENER]    ❌ КРОК 4 FAIL: не вдалось отримати BigInt з channelId`,
        //     );
        //     await log(`[LISTENER]    Помилка: ${e.message}`);
        //     return;
        //   }
        // }

        // // ─────────────────────────────────────────────
        // // КРОК 5: Конвертація в формат -100XXXXXXXXXX
        // // ─────────────────────────────────────────────
        // const peerId = -1000000000000n - channelIdBigInt;

        // await log(`[LISTENER] 🔍 КРОК 5: Конвертація peerId`);
        // await log(
        //   `[LISTENER]    channelIdBigInt (raw):   ${channelIdBigInt.toString()}`,
        // );
        // await log(
        //   `[LISTENER]    peerId (конвертований):  ${peerId.toString()}`,
        // );

        // // ─────────────────────────────────────────────
        // // КРОК 6: Порівняння з whitelist
        // // ─────────────────────────────────────────────
        // const peerIdStr = peerId.toString();
        // const chatIdStrings = chatIds.map((id) => id.toString());
        // const isWhitelisted = chatIdStrings.includes(peerIdStr);

        // await log(`[LISTENER] 🔍 КРОК 6: Порівняння з whitelist`);
        // await log(
        //   `[LISTENER]    chatIds (${chatIds.length} шт): ${chatIdStrings.join(", ")}`,
        // );
        // await log(`[LISTENER]    Шукаємо peerId:  ${peerIdStr}`);
        // await log(
        //   `[LISTENER]    Результат:       ${isWhitelisted ? "✅ ЗНАЙДЕНО" : "🚫 НЕ ЗНАЙДЕНО"}`,
        // );

        // if (!isWhitelisted) {
        //   await log(
        //     `[LISTENER] 🚫 КРОК 6: Канал ${peerIdStr} НЕ в whitelist — пропускаємо`,
        //   );
        //   await log(
        //     `[LISTENER]    Текст: "${(msg.message ?? "").slice(0, 80)}"`,
        //   );
        //   return;
        // }

        // await log(
        //   `[LISTENER] ✅ КРОК 6: Канал ${peerIdStr} в whitelist — передаємо далі`,
        // );

        // // ─────────────────────────────────────────────
        // // КРОК 7: Передача в handleMessage
        // // ─────────────────────────────────────────────
        // await log(`[LISTENER] ▶️  КРОК 7: Викликаємо handleMessage`);
        // await log(`[LISTENER]    messageId:  ${msg.id}`);
        // await log(
        //   `[LISTENER]    groupedId:  ${msg.groupedId ? msg.groupedId.toString() : "відсутній"}`,
        // );
        // await log(
        //   `[LISTENER]    текст:      "${(msg.message ?? "").slice(0, 100)}"`,
        // );
        // await log(`${"=".repeat(60)}\n`);
      };
      console.log("=====================");
      console.log("=====================");
      console.log("chatIds", chatIds);
      // Додаємо обробник з фільтрацією на рівні API
      this.client.addEventHandler(
        this.boundHandleMessage,
        // new NewMessage({ chats: chatIds }), // ✅ Фільтрація на рівні Telegram API
      );

      //  this.client.addEventHandler(
      //   this.boundHandleMessage,
      //   new NewMessage({ chats: chatIds }), // ✅ Фільтрація на рівні Telegram API
      // );

      this.isListening = true;
      print(`${this.platform} listener started successfully`, "success");
      print(
        `Cached ${this.sourcesCache.size} sources with filters and replacements`,
      );
    } catch (error) {
      throw new Error(
        `Failed to start ${this.platform} listener: ${error.message}`,
      );
    }
  }

  /**
   * Зупинка прослуховування
   */
  async stopListening() {
    if (this.isListening && this.client && this.boundHandleMessage) {
      this.client.removeEventHandler(this.boundHandleMessage);
      this.boundHandleMessage = null;
      this.isListening = false;

      // Очищаємо всі таймери груп
      for (const [groupId, group] of this.messageGroups) {
        if (group.timer) {
          clearTimeout(group.timer);
        }
      }
      this.messageGroups.clear();

      // Очищаємо кеш
      this.sourcesCache.clear();
      this.filtersCache.clear();
      this.replacementsCache.clear();
      print(`${this.platform} listener stopped`);
    }
  }

  /**
   * Від'єднання від платформи
   */
  async disconnect() {
    await this.stopListening();
    // telegramClient.disconnect() викликається глобально в inemuri.js
  }

  /**
   * Парсинг повідомлення з платформи в уніфікований формат
   */
  parseMessage(event) {
    const message = event.message;

    return {
      platform: this.platform,
      channelId: message.chatId?.toString(),
      messageId: message.id,
      text: message.text || "",
      media: this.parseMedia(message),
      timestamp: message.date,
      sender: message.senderId?.toString(),
      isForwarded: message.fwdFrom !== undefined,
      replyToMessageId: message.replyTo?.replyToMsgId,
      groupedId: message.groupedId?.toString(), // ✅ ID групи для альбомів
      raw: message, // На випадок якщо потрібні додаткові дані
    };
  }

  /**
   * Витягує найбільший розмір фото з sizes масиву
   */
  extractPhotoSize(photo) {
    if (!photo || !photo.sizes || !Array.isArray(photo.sizes)) {
      return { width: null, height: null, fileSize: null };
    }

    // Фільтруємо тільки PhotoSize та PhotoSizeProgressive (ігноруємо PhotoStrippedSize)
    const validSizes = photo.sizes.filter(
      (size) =>
        size.className === "PhotoSize" ||
        size.className === "PhotoSizeProgressive",
    );

    if (validSizes.length === 0) {
      return { width: null, height: null, fileSize: null };
    }

    // Знаходимо найбільший за розміром
    // PhotoSizeProgressive має масив sizes, беремо останнє значення (найбільше)
    let largestSize = null;
    let maxDimension = 0;

    for (const size of validSizes) {
      const dimension = (size.w || 0) * (size.h || 0);
      if (dimension > maxDimension) {
        maxDimension = dimension;
        largestSize = size;
      }
    }

    if (!largestSize) {
      return { width: null, height: null, fileSize: null };
    }

    // Для PhotoSizeProgressive fileSize - це останній елемент масиву sizes
    const fileSize =
      largestSize.className === "PhotoSizeProgressive"
        ? largestSize.sizes[largestSize.sizes.length - 1]
        : largestSize.size;

    return {
      width: largestSize.w || null,
      height: largestSize.h || null,
      fileSize: fileSize || null,
    };
  }

  /**
   * Парсинг медіа контенту з метаданими
   */
  parseMedia(message) {
    if (!message.media) return null;

    const media = message.media;
    const mediaType = this.getMediaType(
      media.className || media.constructor.name,
    );

    // Базова інформація про медіа
    const mediaInfo = {
      type: mediaType,
      raw: media,
    };

    // Додаємо метадані залежно від типу
    if (media.photo) {
      // Фото - витягуємо розміри з sizes масиву
      const photoSize = this.extractPhotoSize(media.photo);

      mediaInfo.mimeType = "image/jpeg"; // За замовчуванням для фото
      mediaInfo.width = photoSize.width;
      mediaInfo.height = photoSize.height;
      mediaInfo.fileSize = photoSize.fileSize;
    } else if (media.document) {
      // Документ (може бути відео, аудіо, файл, анімація)
      const doc = media.document;
      mediaInfo.mimeType = doc.mimeType;
      mediaInfo.fileSize = doc.size;
      mediaInfo.filename = doc.attributes?.find(
        (attr) => attr.className === "DocumentAttributeFilename",
      )?.fileName;

      // Визначаємо більш точний тип медіа
      if (doc.attributes) {
        for (const attr of doc.attributes) {
          if (attr.className === "DocumentAttributeVideo") {
            mediaInfo.type = attr.roundMessage ? "video_note" : "video";
            mediaInfo.duration = attr.duration;
            mediaInfo.width = attr.w;
            mediaInfo.height = attr.h;
          } else if (attr.className === "DocumentAttributeAnimated") {
            mediaInfo.type = "animation";
          } else if (attr.className === "DocumentAttributeAudio") {
            mediaInfo.type = "audio";
            mediaInfo.duration = attr.duration;
            mediaInfo.title = attr.title;
            mediaInfo.performer = attr.performer;
          }
        }
      }
    }

    return mediaInfo;
  }

  /**
   * Визначення типу медіа
   */
  getMediaType(className) {
    const typeMap = {
      MessageMediaPhoto: "photo",
      MessageMediaDocument: "document",
      MessageMediaWebPage: "webpage",
      MessageMediaGeo: "location",
      MessageMediaContact: "contact",
      MessageMediaPoll: "poll",
    };

    return typeMap[className] || "unknown";
  }

  /**
   * Завантаження медіа файлів з метаданими
   */
  async downloadMedia(messageData) {
    if (!messageData.media) {
      return null;
    }

    try {
      // Якщо це група повідомлень з медіа
      if (Array.isArray(messageData.media)) {
        const downloadedFiles = [];

        for (const media of messageData.media) {
          if (this.downloadableMediaTypes.includes(media.type)) {
            const buffer = await this.client.downloadMedia(media.raw, {});
            if (buffer) {
              downloadedFiles.push({
                type: media.type,
                data: buffer,
                filename: media.filename,
                mimeType: media.mimeType,
                fileSize: media.fileSize,
                duration: media.duration,
                width: media.width,
                height: media.height,
              });
            }
          }
        }

        return downloadedFiles.length > 0 ? downloadedFiles : null;
      }

      // Одиночне медіа
      if (this.downloadableMediaTypes.includes(messageData.media.type)) {
        const buffer = await this.client.downloadMedia(
          messageData.media.raw,
          {},
        );

        if (buffer) {
          return [
            {
              type: messageData.media.type,
              data: buffer,
              filename: messageData.media.filename,
              mimeType: messageData.media.mimeType,
              fileSize: messageData.media.fileSize,
              duration: messageData.media.duration,
              width: messageData.media.width,
              height: messageData.media.height,
            },
          ];
        }
      }

      return null;
    } catch (error) {
      print(
        `Error downloading media for message ${messageData.messageId}: ${error.message}`,
        "error",
      );
      console.error(error);
      return null;
    }
  }

  /**
   * Обробка групи повідомлень (альбом)
   */
  async processMessageGroup(groupedId) {
    const group = this.messageGroups.get(groupedId);

    if (!group || !group.messages || group.messages.length === 0) {
      print(`Empty message group ${groupedId}, skipping`, "warning");
      this.messageGroups.delete(groupedId);
      return;
    }

    try {
      // Сортуємо за messageId щоб зберегти порядок
      group.messages.sort((a, b) => a.messageId - b.messageId);

      // Беремо перше повідомлення як основне
      const firstMessage = group.messages[0];

      // Збираємо всі медіа файли
      const allMedia = group.messages
        .map((msg) => msg.media)
        .filter((media) => media !== null);

      // Об'єднуємо текст (якщо є)
      const combinedText = group.messages
        .map((msg) => msg.text)
        .filter((text) => text && text.trim().length > 0)
        .join("\n");

      // Створюємо об'єднане повідомлення
      const groupedMessage = {
        ...firstMessage,
        text: combinedText,
        media: allMedia.length > 0 ? allMedia : null,
        isGrouped: true,
        groupSize: group.messages.length,
        groupedId: groupedId,
      };

      print(
        `[${this.platform.toUpperCase()}] Processing grouped message: ${group.messages.length} items`,
      );

      // Обробляємо як звичайне повідомлення
      await this.processFilteredMessage(groupedMessage);
    } catch (error) {
      print(
        `Error processing message group ${groupedId}: ${error.message}`,
        "error",
      );
      console.error(error);

      this.eventBus.emit("error.occurred", {
        source: this.platform,
        error: error.message,
        context: `message_group:${groupedId}`,
        stack: error.stack,
      });
    } finally {
      // Видаляємо групу з кешу
      this.messageGroups.delete(groupedId);
    }
  }

  /**
   * Обробка відфільтрованого повідомлення
   */
  async processFilteredMessage(messageData) {
    // Отримуємо source для додаткової інформації
    const source = this.sourcesCache.get(messageData.channelId);
    if (source) {
      messageData.source = {
        id: source.id,
        name: source.channel_name,
        destinations: source.getAllDestinations(),
      };
    }

    // ✅ Завантажуємо медіа після фільтрації
    if (messageData.media) {
      print(
        `[${this.platform.toUpperCase()}] Downloading media for message ${messageData.messageId}...`,
        "debug",
      );

      const downloadedMedia = await this.downloadMedia(messageData);

      if (downloadedMedia) {
        messageData.downloadedMedia = downloadedMedia;
        print(
          `[${this.platform.toUpperCase()}] ✓ Downloaded ${downloadedMedia.length} media file(s)`,
          "success",
        );
      }
    }

    print(
      `[${this.platform.toUpperCase()}] ✓ Message ${messageData.messageId} from channel ${messageData.channelId} passed filters`,
      "success",
    );

    // Емітимо подію про нове повідомлення
    this.eventBus.emit("message.received", messageData);
  }

  /**
   * Обробка вхідного повідомлення з препроцесингом, фільтрацією та групуванням
   */
  async handleMessage(rawMessage) {
    try {
      // Парсимо повідомлення в уніфікований формат
      const messageData = this.parseMessage(rawMessage);

      console.log("messageData", messageData);

      if (!messageData || !messageData.channelId) {
        print(`Invalid message from ${this.platform}, skipping`, "warning");
        return;
      }

      // ✅ ГРУПУВАННЯ: Перевіряємо чи повідомлення частина групи (альбому)
      if (messageData.groupedId) {
        const groupId = messageData.groupedId;

        // Отримуємо або створюємо групу
        let group = this.messageGroups.get(groupId);

        if (!group) {
          group = {
            messages: [],
            timer: null,
          };
          this.messageGroups.set(groupId, group);
        }

        // Додаємо повідомлення до групи
        group.messages.push(messageData);

        // Скидаємо таймер (якщо був)
        if (group.timer) {
          clearTimeout(group.timer);
        }

        // Встановлюємо новий таймер для обробки групи
        group.timer = setTimeout(() => {
          this.processMessageGroup(groupId);
        }, this.groupTimeout);

        print(
          `[${this.platform.toUpperCase()}] Grouped message added (${group.messages.length} items, waiting ${this.groupTimeout}ms)`,
          "debug",
        );

        return; // Не обробляємо зараз, чекаємо всю групу
      }

      // ✅ ПРЕПРОЦЕСИНГ + ФІЛЬТРАЦІЯ: Отримуємо скомпільовані об'єкти з кешу (O(1))
      const compiledReplacements = this.replacementsCache.get(
        messageData.channelId,
      );
      const compiledFilter = this.filtersCache.get(messageData.channelId);

      // ✅ ШВИДКА ПЕРЕВІРКА: Препроцесинг → Фільтрація
      const passed = messageFilter.checkMessageFast(
        compiledReplacements,
        compiledFilter,
        messageData.text,
      );

      if (!passed) {
        // Повідомлення не пройшло фільтр - ігноруємо
        print(
          `[${this.platform.toUpperCase()}] Message filtered out from channel ${messageData.channelId}`,
          "debug",
        );
        return;
      }

      // Повідомлення пройшло фільтр - обробляємо
      await this.processFilteredMessage(messageData);
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
   * Перезавантаження whitelist (після оновлення бази)
   */
  async reloadWhitelist() {
    print(`Reloading ${this.platform} whitelist...`);
    await this.stopListening();
    // Очистити кеш фільтрів та replacements у MessageFilter
    messageFilter.clearCache();
    await this.startListening();
  }

  /**
   * Налаштування типів медіа для завантаження
   */
  setDownloadableMediaTypes(types) {
    if (!Array.isArray(types)) {
      throw new Error("Media types must be an array");
    }
    this.downloadableMediaTypes = types;
    print(`Downloadable media types set to: ${types.join(", ")}`);
  }

  /**
   * Налаштування таймауту для групування повідомлень
   */
  setGroupTimeout(timeout) {
    if (typeof timeout !== "number" || timeout < 0) {
      throw new Error("Timeout must be a positive number");
    }
    this.groupTimeout = timeout;
    print(`Message group timeout set to ${timeout}ms`);
  }

  /**
   * Отримання статистики listener
   */
  getStats() {
    return {
      platform: this.platform,
      isListening: this.isListening,
      whitelistedChannels: this.whitelistedIds.length,
      cachedSources: this.sourcesCache.size,
      cachedFilters: this.filtersCache.size,
      cachedReplacements: this.replacementsCache.size,
      activeGroups: this.messageGroups.size,
      filterCacheStats: messageFilter.getCacheStats(),
    };
  }
}

export default TelegramSourceListener;

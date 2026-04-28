import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import BaseDestinationAdapter from "../base/BaseDestinationAdapter.js";
import telegramClient from "../../module/telegram/TelegramClient.js";
import { print } from "../../shared/utils.js";

class TelegramDestinationAdapter extends BaseDestinationAdapter {
  constructor(eventBus) {
    super("telegram", eventBus);
    this.client = null;

    // Telegram ліміти для user accounts (MTProto, не Bot API)
    this.limits = {
      fileSize: 2000 * 1024 * 1024, // 2GB для user accounts
      caption: 4096, // MTProto user account: caption = message ліміт (Bot API має 1024, ми не бот)
      message: 4096, // максимальна довжина текстового повідомлення
    };

    // Типи медіа які підтримуються
    this.supportedMediaTypes = {
      photo: {
        extensions: ["jpg", "jpeg", "png", "webp"],
        sendMethod: "sendPhoto",
      },
      video: {
        extensions: ["mp4", "mov", "avi", "mkv"],
        sendMethod: "sendVideo",
      },
      document: {
        extensions: ["pdf", "doc", "docx", "txt", "zip", "rar"],
        sendMethod: "sendDocument",
      },
      audio: {
        extensions: ["mp3", "wav", "ogg", "m4a", "flac"],
        sendMethod: "sendAudio",
      },
      animation: {
        extensions: ["gif"],
        sendMethod: "sendAnimation",
      },
      voice: {
        extensions: ["ogg"],
        sendMethod: "sendVoice",
      },
    };

    // Режими парсингу для форматування
    this.parseMode = {
      MARKDOWN: "Markdown",
      HTML: "HTML",
      NONE: null,
    };
  }

  async connect() {
    try {
      this.client = await telegramClient.getClient();
      this.isConnected = true;
      print("Telegram destination adapter connected", "success");
    } catch (error) {
      print(
        `Failed to connect Telegram destination adapter: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  async disconnect() {
    this.isConnected = false;
    print("Telegram destination adapter disconnected");
  }

  /**
   * Відправка одного повідомлення
   * @param {string} destinationId - Telegram chat ID, username або phone
   * @param {Object} messageData - Дані повідомлення з завантаженими медіа
   */
  async sendMessage(destinationId, messageData) {
    try {
      const entity = await this.resolveEntity(destinationId);

      // Формуємо plain text: "Source Name\nрядок повідомлення"
      // rawText — оригінальний текст без Markdown (entities зберігають offset відносно нього)
      const sourceName  = messageData.source.name ?? "";
      const rawBody     = messageData.rawText ?? messageData.text ?? "";
      const plainText   = sourceName + "\n" + rawBody;

      // Зсув entities: source.name + "\n" додає (sourceName.length + 1) символів
      const entityOffset = sourceName.length + 1;

      // Збираємо Api.*Entity об'єкти з оригінальних entities повідомлення
      const formattingEntities = this.buildFormattingEntities(
        messageData.entities ?? [],
        entityOffset,
      );

      const sendOptions = { formattingEntities };

      const hasMedia = messageData.downloadedMedia?.length > 0;

      if (!plainText.trim() && !hasMedia) {
        print(`Skipping empty message to Telegram chat ${destinationId}`, "warning");
        return null;
      }

      let sentMessage;

      if (hasMedia) {
        sentMessage = await this.sendWithMedia(
          entity,
          plainText,
          messageData.downloadedMedia,
          sendOptions,
        );
      } else {
        sentMessage = await this.sendTextMessage(entity, plainText, sendOptions);
      }

      print(`✓ Message sent to Telegram chat ${destinationId}`);
      return sentMessage;
    } catch (error) {
      print(
        `✗ Failed to send message to Telegram chat ${destinationId}: ${error.message}`,
        "error",
      );

      this.eventBus.emit("error.occurred", {
        source: "telegram-destination",
        error: error.message,
        chatId: destinationId,
        stack: error.stack,
      });

      throw error;
    }
  }

  /**
   * Batch відправка повідомлень
   * @param {string} destinationId - Telegram chat ID
   * @param {Array} messageList - Масив повідомлень для відправки
   */
  async sendBatch(destinationId, messageList) {
    try {
      const entity = await this.resolveEntity(destinationId);
      const results = [];

      for (const message of messageList) {
        try {
          const sentMessage = await this.sendMessage(destinationId, message);
          results.push({ success: true, messageId: sentMessage.id });
          print(`  ✓ Batch message ${results.length} sent`);

          // Невелика затримка між повідомленнями для уникнення flood wait
          await this.sleep(100);
        } catch (error) {
          print(`  ✗ Failed to send batch message: ${error.message}`, "error");
          results.push({ success: false, error: error.message });
        }
      }

      print(
        `Batch send completed: ${results.filter((r) => r.success).length}/${messageList.length} successful`,
      );
      return results;
    } catch (error) {
      print(
        `✗ Failed batch send to Telegram chat ${destinationId}: ${error.message}`,
        "error",
      );

      this.eventBus.emit("error.occurred", {
        source: "telegram-destination",
        error: error.message,
        chatId: destinationId,
        operation: "batch_send",
        stack: error.stack,
      });

      throw error;
    }
  }

  /**
   * Відправка текстового повідомлення.
   *
   * Використовує formattingEntities (MTProto Api.*Entity об'єкти) замість parseMode,
   * оскільки parseMode: "markdown" ненадійний у GramJS для user accounts —
   * він не підтримує [text](url) синтаксис і ламає спецсимволи.
   * formattingEntities передаються напряму в протокол і рендеряться гарантовано.
   *
   * @param {Object}   entity   - Telegram entity (destination)
   * @param {string}   text     - Plain text повідомлення (без Markdown)
   * @param {Object}   options
   *   options.formattingEntities {Api.*Entity[]} — entities для цього тексту
   */
  async sendTextMessage(entity, text, options = {}) {
    if (!text || text.trim().length === 0) {
      throw new Error("Message text cannot be empty");
    }

    const messageText = this.truncateText(text, this.limits.message);

    const sendOptions = {
      message:     messageText,
      parseMode:   null,  // вимикаємо parseMode — використовуємо formattingEntities
      linkPreview: options.linkPreview !== false,
      replyTo:     options.replyTo || null,
      silent:      options.silent  || false,
    };

    if (options.formattingEntities?.length) {
      sendOptions.formattingEntities = options.formattingEntities;
    }

    return await this.client.sendMessage(entity, sendOptions);
  }

  /**
   * Відправка повідомлення з медіа
   * @param {Object} entity - Telegram entity
   * @param {string} text - Caption для медіа
   * @param {Array} downloadedMedia - Масив завантажених медіа
   * @param {Object} options - Додаткові опції
   */
  async sendWithMedia(entity, text, downloadedMedia, options = {}) {
    const validMedia = await this.prepareMediaForSend(downloadedMedia);

    if (validMedia.length === 0) {
      print("No valid media to send, sending text only", "warning");
      // Якщо і текст пустий — нічого не відправляємо, не кидаємо помилку
      if (!text || text.trim().length === 0) {
        print("No text and no valid media — skipping message", "warning");
        return null;
      }
      return await this.sendTextMessage(entity, text, options);
    }

    const caption = this.truncateText(text || "", this.limits.caption);

    // Якщо одне медіа - відправляємо як одиночне
    if (validMedia.length === 1) {
      return await this.sendSingleMedia(entity, validMedia[0], caption, {
        ...options,
        index: 0,
      });
    }

    // Якщо декілька медіа - відправляємо як album (media group)
    return await this.sendMediaGroup(entity, validMedia, caption, options);
  }

  /**
   * Конвертація медіа об'єкта в CustomFile для gramjs
   * @param {Object} media - Медіа об'єкт з полем data (Buffer)
   * @param {number} index - Індекс для генерації імені
   * @returns {CustomFile}
   */
  mediaToCustomFile(media, index = 0) {
    const filename = this.getMediaFilename(media, index);
    return new CustomFile(filename, media.data.length, "", media.data);
  }

  /**
   * Відправка одного медіа файлу
   * @param {Object} entity - Telegram entity
   * @param {Object} media - Медіа об'єкт
   * @param {string} caption - Caption
   * @param {Object} options - Опції
   */
  async sendSingleMedia(entity, media, caption, options = {}) {
    const mediaType = media.type || "document";
    const customFile = this.mediaToCustomFile(media, options.index || 0);

    const baseOptions = {
      caption,
      parseMode:   null,  // вимикаємо parseMode — використовуємо formattingEntities
      replyTo:     options.replyTo || null,
      silent:      options.silent  || false,
      ...(options.formattingEntities?.length
        ? { formattingEntities: options.formattingEntities }
        : {}),
    };

    if (mediaType === "photo") {
      return await this.client.sendFile(entity, {
        ...baseOptions,
        file: customFile,
        forceDocument: false,
      });
    } else if (mediaType === "video") {
      return await this.client.sendFile(entity, {
        ...baseOptions,
        file: customFile,
        forceDocument: false,
        supportsStreaming: true,
        attributes: [
          new Api.DocumentAttributeVideo({
            duration: media.duration || 0,
            w: media.width || 0,
            h: media.height || 0,
            supportsStreaming: true,
            roundMessage: media.isRound || false,
          }),
        ],
      });
    } else if (mediaType === "animation") {
      return await this.client.sendFile(entity, {
        ...baseOptions,
        file: customFile,
        forceDocument: false,
        attributes: [
          new Api.DocumentAttributeAnimated({}),
          new Api.DocumentAttributeVideo({
            duration: media.duration || 0,
            w: media.width || 0,
            h: media.height || 0,
          }),
        ],
      });
    } else {
      // audio, voice, document
      return await this.client.sendFile(entity, {
        ...baseOptions,
        file: customFile,
        forceDocument: true,
        attributes: this.buildFileAttributes(media, options.index || 0),
      });
    }
  }

  /**
   * Відправка медіа групи (album)
   *
   * gramjs підтримує album через client.sendFile(entity, { file: [array] }).
   * Він сам збирає SendMultiMedia з правильними CustomFile — це надійніше
   * ніж вручну будувати InputMediaUploadedPhoto/Document.
   *
   * Обмеження: всі файли в альбомі мають бути одного "класу":
   * або всі photo/video, або всі document. Змішані альбоми не підтримуються Telegram.
   *
   * @param {Object} entity - Telegram entity
   * @param {Array} mediaList - Масив медіа об'єктів
   * @param {string} caption - Caption (буде на першому медіа)
   * @param {Object} options - Опції
   */
  async sendMediaGroup(entity, mediaList, caption, options = {}) {
    const files = mediaList.map((media, index) =>
      this.mediaToCustomFile(media, index),
    );

    return await this.client.sendFile(entity, {
      file:         files,
      caption,
      parseMode:    null,  // вимикаємо parseMode — використовуємо formattingEntities
      replyTo:      options.replyTo || null,
      silent:       options.silent  || false,
      forceDocument: false,
      ...(options.formattingEntities?.length
        ? { formattingEntities: options.formattingEntities }
        : {}),
    });
  }

  /**
   * Підготовка медіа для відправки з перевіркою розміру
   * @param {Array} downloadedMedia - Масив завантажених медіа
   * @returns {Array} - Валідні медіа файли
   */
  async prepareMediaForSend(downloadedMedia) {
    const validMedia = [];

    for (let i = 0; i < downloadedMedia.length; i++) {
      const media = downloadedMedia[i];

      // gram.js іноді повертає Uint8Array замість Buffer — нормалізуємо
      if (media.data && !Buffer.isBuffer(media.data)) {
        if (media.data instanceof Uint8Array) {
          media.data = Buffer.from(media.data);
        } else {
          print(`Skipping media ${i}: unsupported data type ${typeof media.data}`, "warning");
          continue;
        }
      }

      if (!media.data || !Buffer.isBuffer(media.data) || media.data.length === 0) {
        print(`Skipping media ${i}: no valid data buffer`, "warning");
        continue;
      }

      const fileSize = Buffer.byteLength(media.data);

      // Перевіряємо розмір файлу
      if (fileSize > this.limits.fileSize) {
        print(
          `Skipping media ${i} (${media.type}): file size ${(fileSize / (1024 * 1024)).toFixed(2)}MB exceeds limit`,
          "warning",
        );
        continue;
      }

      // Генеруємо filename для логування
      const filename = this.getMediaFilename(media, i);

      validMedia.push(media);

      print(
        `Prepared media ${i} (${media.type}): ${filename} - ${(fileSize / 1024).toFixed(2)}KB`,
        "debug",
      );
    }

    return validMedia;
  }

  /**
   * Генерація імені файлу на основі типу медіа та метаданих
   * @param {Object} media - Медіа об'єкт
   * @param {number} index - Індекс файлу
   * @returns {string} - Ім'я файлу
   */
  getMediaFilename(media, index = 0) {
    const mediaConfig = this.supportedMediaTypes[media.type];

    if (!mediaConfig) {
      print(`Unknown media type: ${media.type}, using default`, "warning");
      return `file${index}.bin`;
    }

    // Якщо є оригінальне ім'я файлу в метаданих
    if (media.filename) {
      return media.filename;
    }

    // Якщо є mime type, визначаємо розширення
    if (media.mimeType) {
      const extension = this.getExtensionFromMimeType(
        media.mimeType,
        mediaConfig.extensions,
      );
      if (extension) {
        return `file${index}.${extension}`;
      }
    }

    // Використовуємо перше розширення для типу як стандартне
    const defaultExtension = mediaConfig.extensions[0] || "bin";
    return `file${index}.${defaultExtension}`;
  }

  /**
   * Визначення розширення файлу з MIME type
   * @param {string} mimeType - MIME type файлу
   * @param {Array} allowedExtensions - Дозволені розширення
   * @returns {string|null} - Розширення файлу
   */
  getExtensionFromMimeType(mimeType, allowedExtensions) {
    const mimeMap = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/x-msvideo": "avi",
      "video/x-matroska": "mkv",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "audio/flac": "flac",
      "application/pdf": "pdf",
      "application/zip": "zip",
      "application/x-rar-compressed": "rar",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
      "text/plain": "txt",
      "image/gif": "gif",
      "audio/ogg; codecs=opus": "ogg",
    };

    const extension = mimeMap[mimeType];
    return extension && allowedExtensions.includes(extension)
      ? extension
      : null;
  }

  /**
   * Побудова атрибутів файлу для Telegram
   * @param {Object} media - Медіа об'єкт
   * @param {number} index - Індекс файлу (для генерації імені)
   * @returns {Array} - Масив атрибутів
   */
  buildFileAttributes(media, index = 0) {
    const attributes = [];

    // Генеруємо або використовуємо існуюче ім'я файлу
    const filename = this.getMediaFilename(media, index);
    attributes.push(
      new Api.DocumentAttributeFilename({
        fileName: filename,
      }),
    );

    // Додаємо атрибути в залежності від типу медіа
    switch (media.type) {
      case "video":
        if (media.duration || media.width || media.height) {
          attributes.push(
            new Api.DocumentAttributeVideo({
              duration: media.duration || 0,
              w: media.width || 0,
              h: media.height || 0,
              roundMessage: media.isRound || false,
              supportsStreaming: true,
            }),
          );
        }
        break;

      case "audio":
        if (media.duration || media.title || media.performer) {
          attributes.push(
            new Api.DocumentAttributeAudio({
              duration: media.duration || 0,
              title: media.title || "",
              performer: media.performer || "",
              voice: false,
            }),
          );
        }
        break;

      case "voice":
        if (media.duration) {
          attributes.push(
            new Api.DocumentAttributeAudio({
              duration: media.duration,
              voice: true,
            }),
          );
        }
        break;

      case "animation":
        if (media.width || media.height) {
          attributes.push(new Api.DocumentAttributeAnimated({}));
          attributes.push(
            new Api.DocumentAttributeVideo({
              duration: media.duration || 0,
              w: media.width || 0,
              h: media.height || 0,
            }),
          );
        }
        break;
    }

    return attributes;
  }

  /**
   * Конвертує масив оригінальних Telegram entities (GramJS raw objects)
   * у масив Api.*Entity об'єктів для передачі в formattingEntities.
   *
   * Чому не parseMode:
   *   parseMode: "markdown" у GramJS для user accounts НЕ підтримує [text](url),
   *   може ламати спецсимволи ($, %, дужки тощо) і є нестабільним.
   *   formattingEntities — нативний MTProto механізм, завжди рендериться вірно.
   *
   * @param {object[]} entities     - Масив GramJS entity об'єктів з messageData.entities
   * @param {number}   offsetDelta  - Зсув всіх offset (для source name + "\n" префіксу)
   * @returns {Api.*Entity[]}
   */
  buildFormattingEntities(entities, offsetDelta = 0) {
    if (!entities?.length) return [];

    const result = [];

    for (const e of entities) {
      const offset = (e.offset ?? 0) + offsetDelta;
      const length = e.length ?? 0;

      if (length <= 0) continue;

      const className = e.className ?? e.constructor?.name ?? "";

      try {
        switch (className) {
          case "MessageEntityBold":
            result.push(new Api.MessageEntityBold({ offset, length }));
            break;
          case "MessageEntityItalic":
            result.push(new Api.MessageEntityItalic({ offset, length }));
            break;
          case "MessageEntityUnderline":
            result.push(new Api.MessageEntityUnderline({ offset, length }));
            break;
          case "MessageEntityStrikethrough":
            result.push(new Api.MessageEntityStrikethrough({ offset, length }));
            break;
          case "MessageEntityCode":
            result.push(new Api.MessageEntityCode({ offset, length }));
            break;
          case "MessageEntityPre":
            result.push(new Api.MessageEntityPre({
              offset,
              length,
              language: e.language ?? "",
            }));
            break;
          case "MessageEntitySpoiler":
            result.push(new Api.MessageEntitySpoiler({ offset, length }));
            break;
          case "MessageEntityTextUrl":
            if (e.url) {
              result.push(new Api.MessageEntityTextUrl({ offset, length, url: e.url }));
            }
            break;
          case "MessageEntityUrl":
            result.push(new Api.MessageEntityUrl({ offset, length }));
            break;
          case "MessageEntityMention":
            result.push(new Api.MessageEntityMention({ offset, length }));
            break;
          case "MessageEntityHashtag":
            result.push(new Api.MessageEntityHashtag({ offset, length }));
            break;
          case "MessageEntityCashtag":
            result.push(new Api.MessageEntityCashtag({ offset, length }));
            break;
          case "MessageEntityEmail":
            result.push(new Api.MessageEntityEmail({ offset, length }));
            break;
          case "MessageEntityPhone":
            result.push(new Api.MessageEntityPhone({ offset, length }));
            break;
          case "MessageEntityBotCommand":
            result.push(new Api.MessageEntityBotCommand({ offset, length }));
            break;
          default:
            // Невідомий тип — пропускаємо, щоб не зламати відправку
            print(`buildFormattingEntities: unknown entity type "${className}", skipping`, "debug");
            break;
        }
      } catch (err) {
        // Якщо Api.* конструктор не знайдений (стара версія GramJS) — пропускаємо
        print(`buildFormattingEntities: failed to build ${className}: ${err.message}`, "debug");
      }
    }

    return result;
  }

  /**
   * Резолв entity (username, phone, chat_id)
   * @param {string|number} identifier - Username, phone або chat_id
   * @returns {Object} - Telegram entity
   */
  async resolveEntity(identifier) {
    try {
      // Якщо це число - це chat_id
      if (typeof identifier === "number" || /^-?\d+$/.test(identifier)) {
        return await this.client.getEntity(parseInt(identifier));
      }

      // Якщо починається з @ - це username
      if (typeof identifier === "string" && identifier.startsWith("@")) {
        return await this.client.getEntity(identifier);
      }

      // Інакше пробуємо як є
      return await this.client.getEntity(identifier);
    } catch (error) {
      print(
        `Failed to resolve Telegram entity: ${identifier} - ${error.message}`,
        "error",
      );
      throw new Error(`Cannot resolve Telegram entity: ${identifier}`);
    }
  }

  /**
   * Обрізка тексту до максимальної довжини
   * @param {string} text - Текст
   * @param {number} maxLength - Максимальна довжина
   * @returns {string} - Обрізаний текст
   */
  truncateText(text, maxLength) {
    if (!text) return "";

    if (text.length <= maxLength) {
      return text;
    }

    // Обрізаємо і додаємо маркер
    return text.substring(0, maxLength - 3) + "...";
  }

  /**
   * Форматування повідомлення під Telegram
   * @param {Object} messageData - Уніфіковані дані повідомлення
   * @returns {Object} - Telegram-formatted message
   */
  async formatMessage(messageData) {
    return {
      text:               messageData.rawText ?? messageData.text ?? "",
      formattingEntities: messageData.entities ?? [],
      parseMode:          null,
      downloadedMedia:    messageData.downloadedMedia || [],
      linkPreview:        messageData.linkPreview !== false,
      silent:             messageData.silent || false,
      replyTo:            messageData.replyTo || null,
    };
  }

  /**
   * Видалення повідомлень з чату
   * @param {string} destinationId - Chat ID
   * @param {Array} messageIds - Масив ID повідомлень для видалення
   */
  async deleteMessages(destinationId, messageIds) {
    try {
      const entity = await this.resolveEntity(destinationId);

      await this.client.deleteMessages(entity, messageIds, { revoke: true });

      print(
        `Deleted ${messageIds.length} message(s) from chat ${destinationId}`,
        "success",
      );

      return true;
    } catch (error) {
      print(
        `Failed to delete messages from chat ${destinationId}: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Редагування повідомлення
   * @param {string} destinationId - Chat ID
   * @param {number} messageId - ID повідомлення
   * @param {string} newText - Новий текст
   */
  async editMessage(destinationId, messageId, newText) {
    try {
      const entity = await this.resolveEntity(destinationId);

      await this.client.editMessage(entity, {
        message: messageId,
        text: newText,
      });

      print(`Edited message ${messageId} in chat ${destinationId}`, "success");

      return true;
    } catch (error) {
      print(
        `Failed to edit message ${messageId} in chat ${destinationId}: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Пересилання повідомлень
   * @param {string} fromChatId - З якого чату
   * @param {string} toChatId - В який чат
   * @param {Array} messageIds - ID повідомлень для пересилки
   */
  async forwardMessages(fromChatId, toChatId, messageIds) {
    try {
      const fromEntity = await this.resolveEntity(fromChatId);
      const toEntity = await this.resolveEntity(toChatId);

      await this.client.forwardMessages(toEntity, {
        messages: messageIds,
        fromPeer: fromEntity,
      });

      print(
        `Forwarded ${messageIds.length} message(s) from ${fromChatId} to ${toChatId}`,
        "success",
      );

      return true;
    } catch (error) {
      print(`Failed to forward messages: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * Затримка (для уникнення flood wait)
   * @param {number} ms - Мілісекунди
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default TelegramDestinationAdapter;
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import BaseDestinationAdapter from "../base/BaseDestinationAdapter.js";
import discordClient from "../../module/discord/DiscordClient.js";
import { print } from "../../shared/utils.js";

class DiscordDestinationAdapter extends BaseDestinationAdapter {
  constructor(eventBus) {
    super("discord", eventBus);
    this.client = null;

    // Discord ліміти
    this.limits = {
      freeServer: 25 * 1024 * 1024, // 25 MB для звичайних серверів
      nitroServer: 100 * 1024 * 1024, // 100 MB для серверів з Nitro boost
      messageLength: 2000, // максимальна довжина повідомлення
      embedDescriptionLength: 4096, // максимальна довжина опису в embed
    };

    // Поточний ліміт (можна налаштувати)
    this.fileSizeLimit = this.limits.freeServer;

    // Типи медіа які підтримуються
    this.supportedMediaTypes = {
      photo: {
        extensions: ["jpg", "jpeg", "png", "gif", "webp"],
        defaultExtension: "png", // PNG краще для якості
        canEmbed: true,
      },
      video: {
        extensions: ["mp4", "mov", "webm", "mkv"],
        defaultExtension: "mp4",
        canEmbed: false,
      },
      document: {
        extensions: ["pdf", "doc", "docx", "txt", "zip"],
        defaultExtension: "file",
        canEmbed: false,
      },
      audio: {
        extensions: ["mp3", "wav", "ogg", "m4a"],
        defaultExtension: "mp3",
        canEmbed: false,
      },
      animation: {
        extensions: ["gif"],
        defaultExtension: "gif",
        canEmbed: true,
      },
    };
  }

  async connect() {
    try {
      this.client = await discordClient.getClient();
      this.isConnected = true;
      print("Discord destination adapter connected", "success");
    } catch (error) {
      print(
        `Failed to connect Discord destination adapter: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  async disconnect() {
    this.isConnected = false;
    print("Discord destination adapter disconnected");
  }

  /**
   * Налаштування ліміту розміру файлів
   * @param {boolean} hasNitroBoost - Чи має сервер Nitro boost
   */
  setFileSizeLimit(hasNitroBoost = false) {
    this.fileSizeLimit = hasNitroBoost
      ? this.limits.nitroServer
      : this.limits.freeServer;
    print(
      `Discord file size limit set to ${this.fileSizeLimit / (1024 * 1024)}MB`,
    );
  }

  /**
   * CRITICAL FIX: Обрізання довгого тексту під ліміт Discord
   * @param {string} text - Текст для обрізання
   * @param {number} maxLength - Максимальна довжина (за замовчуванням 2000)
   * @returns {string} - Обрізаний текст
   */
  truncateText(text, maxLength = this.limits.messageLength) {
    if (!text || text.length <= maxLength) {
      return text;
    }

    const suffix = "\n\n... (message truncated)";
    const truncateAt = maxLength - suffix.length;
    
    print(
      `Truncating message from ${text.length} to ${maxLength} characters`,
      "warning",
    );

    return text.substring(0, truncateAt) + suffix;
  }

  /**
   * Відправка одного повідомлення
   * @param {string} channelId - Discord channel ID
   * @param {Object} messageData - Дані повідомлення з завантаженими медіа
   */
  async sendMessage(channelId, messageData) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel) {
        throw new Error(`Could not find channel with ID ${channelId}`);
      }

      // messageData.text = messageData.source.name + ":\n" + messageData.text;
      let text = messageData.source.name + "\n" + messageData.text;

      // CRITICAL FIX: Обрізаємо текст якщо він задовгий
      text = this.truncateText(text);

      const discordMessage = await this.formatMessage({ ...messageData, text , useEmbed: true});
      const sentMessage = await channel.send(discordMessage);

      print(`✓ Message sent to Discord channel ${channelId}`);
      return sentMessage;
    } catch (error) {
      print(
        `✗ Failed to send message to Discord channel ${channelId}: ${error.message}`,
        "error",
      );

      this.eventBus.emit("error.occurred", {
        source: "discord-destination",
        error: error.message,
        channelId,
        stack: error.stack,
      });

      throw error;
    }
  }

  /**
   * Батч відправка повідомлень
   * @param {string} channelId - Discord channel ID
   * @param {Array} messageList - Масив повідомлень для відправки
   */
  async sendBatch(channelId, messageList) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel) {
        throw new Error(`Could not find channel with ID ${channelId}`);
      }

      const results = [];

      for (const message of messageList) {
        try {
          const discordMessage = await this.formatMessage(message);
          const sentMessage = await channel.send(discordMessage);

          results.push({ success: true, messageId: sentMessage.id });
          print(`  ✓ Batch message ${results.length} sent`);
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
        `✗ Failed batch send to Discord channel ${channelId}: ${error.message}`,
        "error",
      );

      this.eventBus.emit("error.occurred", {
        source: "discord-destination",
        error: error.message,
        channelId,
        operation: "batch_send",
        stack: error.stack,
      });

      throw error;
    }
  }

  /**
   * Форматування повідомлення під Discord
   * @param {Object} messageData - Уніфіковані дані повідомлення з завантаженими медіа
   * @returns {Object} - Discord-formatted message
   */
  async formatMessage(messageData) {
    const discordMessage = {};

    // Текст повідомлення (вже обрізаний в sendMessage)
    if (messageData.text && !messageData.useEmbed) {
      discordMessage.content = messageData.text;
    }

    // Обробка завантажених медіа з Telegram
    if (messageData.downloadedMedia && messageData.downloadedMedia.length > 0) {
      const mediaResult = await this.prepareMediaAttachments(
        messageData.downloadedMedia,
      );

      // Якщо є файли які пройшли перевірку розміру
      if (mediaResult.attachments.length > 0) {
        discordMessage.files = mediaResult.attachments;

        // Налаштування embed для фото
        if (messageData.useEmbed || messageData.embed) {
          const firstImage = mediaResult.validMedia.find((item) => {
            const mediaType = item.media.type;
            return (
              this.supportedMediaTypes[mediaType]?.canEmbed &&
              (mediaType === "photo" || mediaType === "animation")
            );
          });

          if (firstImage) {
            const embedData = messageData.embed || {};
            embedData.image = `attachment://${this.getMediaFilename(firstImage.media, firstImage.index)}`;
            
            // CRITICAL FIX: Обрізаємо опис embed якщо він задовгий
            if (messageData.text) {
              embedData.description = this.truncateText(
                messageData.text,
                this.limits.embedDescriptionLength
              );
            }
            
            messageData.embed = embedData;
          }
        }
      }

      // Якщо були файли що не пройшли перевірку - додаємо повідомлення
      if (mediaResult.oversizedFiles.length > 0) {
        const warningText = `\n⚠️ ${mediaResult.oversizedFiles.length} файл(ів) пропущено через обмеження розміру (>${this.fileSizeLimit / (1024 * 1024)}MB)`;

        if (discordMessage.content) {
          // CRITICAL FIX: Перевіряємо чи не перевищимо ліміт після додавання warning
          const newContent = discordMessage.content + warningText;
          discordMessage.content = this.truncateText(newContent);
        } else {
          discordMessage.content = warningText.trim();
        }
      }

      // Якщо жоден файл не пройшов перевірку і немає тексту
      if (mediaResult.attachments.length === 0 && !discordMessage.content) {
        discordMessage.content =
          "⚠️ Не вдалося надіслати медіа файли через обмеження розміру";
      }
    }

    // Embed якщо потрібен
    if (messageData.embed) {
      discordMessage.embeds = [this.buildEmbed(messageData.embed)];
    }

    return discordMessage;
  }

  /**
   * Підготовка медіа файлів для Discord з перевіркою розміру
   * @param {Array} downloadedMedia - Масив завантажених медіа з Telegram
   * @returns {Object} - { attachments: Array, validMedia: Array, oversizedFiles: Array }
   */
  async prepareMediaAttachments(downloadedMedia) {
    const attachments = [];
    const validMedia = [];
    const oversizedFiles = [];

    for (let i = 0; i < downloadedMedia.length; i++) {
      const media = downloadedMedia[i];

      if (!media.data) {
        print(`Skipping media ${i}: no data buffer`, "warning");
        continue;
      }

      const fileSize = Buffer.byteLength(media.data);

      // Перевіряємо розмір файлу
      if (fileSize > this.fileSizeLimit) {
        print(
          `Skipping media ${i} (${media.type}): file size ${(fileSize / (1024 * 1024)).toFixed(2)}MB exceeds limit`,
          "warning",
        );
        oversizedFiles.push({
          index: i,
          type: media.type,
          size: fileSize,
        });
        continue;
      }

      const filename = this.getMediaFilename(media, i);
      const attachment = new AttachmentBuilder(media.data, { name: filename });

      attachments.push(attachment);
      validMedia.push({ media, index: i });

      print(
        `Added media ${i} (${media.type}): ${filename} (${(fileSize / 1024).toFixed(2)}KB)`,
        "debug",
      );
    }

    return {
      attachments,
      validMedia,
      oversizedFiles,
    };
  }

  /**
   * Генерація імені файлу на основі типу медіа та метаданих
   * @param {Object} media - Медіа об'єкт
   * @param {number} index - Індекс файлу
   * @returns {string} - Ім'я файлу
   */
  getMediaFilename(media, index) {
    const mediaConfig = this.supportedMediaTypes[media.type];

    if (!mediaConfig) {
      print(`Unknown media type: ${media.type}, using default`, "warning");
      return `attachment${index}.bin`;
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
        return `attachment${index}.${extension}`;
      }
    }

    // Використовуємо стандартне розширення для типу
    return `attachment${index}.${mediaConfig.defaultExtension}`;
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
      "image/gif": "gif",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
      "video/x-matroska": "mkv",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "application/pdf": "pdf",
      "application/zip": "zip",
    };

    const extension = mimeMap[mimeType];
    return extension && allowedExtensions.includes(extension)
      ? extension
      : null;
  }

  /**
   * Побудова Discord embed
   * @param {Object} embedData - Дані для embed
   * @returns {EmbedBuilder}
   */
  buildEmbed(embedData) {
    const embed = new EmbedBuilder().setColor(embedData.color || 0x5865f2);

    if (embedData.author) embed.setAuthor({ name: embedData.author });
    if (embedData.title) embed.setTitle(embedData.title);
    
    // CRITICAL FIX: Обрізаємо description якщо задовгий
    if (embedData.description) {
      const truncatedDescription = this.truncateText(
        embedData.description,
        this.limits.embedDescriptionLength
      );
      embed.setDescription(truncatedDescription);
    }
    
    if (embedData.footer) embed.setFooter({ text: embedData.footer });
    if (embedData.timestamp) embed.setTimestamp(embedData.timestamp);
    if (embedData.image) embed.setImage(embedData.image);
    if (embedData.thumbnail) embed.setThumbnail(embedData.thumbnail);
    if (embedData.url) embed.setURL(embedData.url);

    // Додаткові поля
    if (embedData.fields && Array.isArray(embedData.fields)) {
      for (const field of embedData.fields) {
        embed.addFields({
          name: field.name,
          value: field.value,
          inline: field.inline || false,
        });
      }
    }

    return embed;
  }

  /**
   * Очистка каналу
   * @param {string} channelId - Discord channel ID
   * @param {number} limit - Кількість повідомлень для видалення (max 100)
   */
  async clearChannel(channelId, limit = 100) {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel) {
        throw new Error(`Could not find channel with ID ${channelId}`);
      }

      const messages = await channel.messages.fetch({ limit });
      await Promise.all(messages.map((message) => message.delete()));

      print(
        `Channel ${channelId} cleared: ${messages.size} messages deleted`,
        "success",
      );

      return messages.size;
    } catch (error) {
      print(`Failed to clear channel ${channelId}: ${error.message}`, "error");
      throw error;
    }
  }
}

export default DiscordDestinationAdapter;
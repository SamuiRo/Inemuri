import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import BaseDestinationAdapter from "../base/BaseDestinationAdapter.js";
import discordRest from "../../module/discord/DiscordRest.js";
import { DISCORD_UPLOAD_LIMIT_MB } from "../../config/app.config.js";
import { print } from "../../shared/utils.js";

/**
 * DiscordDestinationAdapter
 *
 * Відправляє повідомлення у Discord виключно через Embed:
 *  - source name → embed.author
 *  - text (Markdown з посиланнями) → embed.description
 *  - фото/анімація → embed.image (перший файл, який підтримує embed)
 *  - решта медіа → files (вкладення поряд з embed)
 *
 * content (поле поза embed) НЕ використовується, щоб виключити дублювання.
 *
 * Ходить лише через REST (DiscordRest), без gateway-сесії: доставка не
 * залежить від того, чи піднявся discordapp (docs/DISCORDAPP.md D2).
 * Надіслане повідомлення — сирий об'єкт API (`{ id, channel_id, ... }`).
 */
class DiscordDestinationAdapter extends BaseDestinationAdapter {
  constructor(eventBus) {
    super("discord", eventBus);
    this.rest = discordRest;

    // Discord ліміти
    this.limits = {
      messageLength:         2000,
      embedDescriptionLength: 4096,
      embedAuthorLength:     256,
      embedFooterLength:     2048,
    };

    this.fileSizeLimit = DISCORD_UPLOAD_LIMIT_MB * 1024 * 1024;

    // Медіатипи, які підтримуються Discord
    this.supportedMediaTypes = {
      photo: {
        extensions:       ["jpg", "jpeg", "png", "gif", "webp"],
        // jpg, а не png: TelegramMessageParser.parseMedia() беззастережно
        // ставить фото mimeType "image/jpeg" (у Telegram-фото немає документа,
        // тож MIME читати нізвідки), а _getFilename() дивиться на MIME ПЕРЕД
        // дефолтом. Тобто "png" тут був недосяжною гілкою, яка ще й вводила в
        // оману — див. docs/media.md.
        defaultExtension: "jpg",
        canEmbed:         true,   // можна вставити в embed.image
      },
      video: {
        extensions:       ["mp4", "mov", "webm", "mkv"],
        defaultExtension: "mp4",
        canEmbed:         false,
      },
      document: {
        extensions:       ["pdf", "doc", "docx", "txt", "zip"],
        defaultExtension: "file",
        canEmbed:         false,
      },
      audio: {
        extensions:       ["mp3", "wav", "ogg", "m4a"],
        defaultExtension: "mp3",
        canEmbed:         false,
      },
      animation: {
        extensions:       ["gif"],
        defaultExtension: "gif",
        canEmbed:         true,
      },
    };
  }

  // ── Підключення ──────────────────────────────────────────────────────────

  /**
   * Мережі тут немає: REST-клієнт не тримає з'єднання. Перевіряємо лише, що є
   * токен, — без нього кожна відправка впала б на 401.
   */
  async connect() {
    if (!this.rest.isConfigured) {
      throw new Error("DISCORD_BOT_TOKEN is not set");
    }
    this.isConnected = true;
    print("Discord destination adapter connected (REST)", "success");
  }

  async disconnect() {
    this.isConnected = false;
    print("Discord destination adapter disconnected");
  }

  get capabilities() {
    return { edit: true };
  }

  /**
   * Ідентичність надісланого повідомлення для clusters.delivered / linked.
   * @param {{ id: string, channel_id: string }} sentMessage  Сирий об'єкт API.
   * @param {string} destinationId
   */
  describeSent(sentMessage, destinationId) {
    return {
      platform: "discord",
      channel_id: sentMessage?.channel_id ?? String(destinationId),
      message_id: sentMessage?.id ?? null,
      sent_at: new Date(),
    };
  }

  /**
   * Редагування вже надісланого повідомлення.
   * @param {string} channelId
   * @param {string} messageId
   * @param {(string|object)} payload  Рядок → { content }; об'єкт → payload
   *   у стилі discord.js (напр. { embeds: [...] }), див. toRestPayload().
   */
  async editMessage(channelId, messageId, payload) {
    try {
      await this.rest.editMessage(channelId, messageId, payload);

      print(`Edited message ${messageId} in Discord channel ${channelId}`, "success");
      return true;
    } catch (error) {
      print(
        `Failed to edit message ${messageId} in Discord channel ${channelId}: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  // ── Відправка ────────────────────────────────────────────────────────────

  /**
   * Відправка одного повідомлення у вигляді Discord Embed.
   *
   * Структура embed:
   *  author  → source name
   *  description → Markdown text (з посиланнями, bold, italic тощо)
   *  image   → перший embeddable медіафайл (photo / animation)
   *  files   → всі медіафайли як вкладення (image теж іде файлом для attachment://)
   *
   * @param {string} channelId   - Discord channel ID
   * @param {object} messageData - Нормалізовані дані повідомлення
   */
  async sendMessage(channelId, messageData) {
    try {
      const discordPayload = await this._buildPayload(messageData);
      const sentMessage    = await this.rest.sendMessage(channelId, discordPayload);

      print(`✓ Message sent to Discord channel ${channelId}`);
      return sentMessage;
    } catch (error) {
      print(`✗ Failed to send message to Discord channel ${channelId}: ${error.message}`, "error");

      this.eventBus.emit("error.occurred", {
        source:    "discord-destination",
        error:     error.message,
        channelId,
        stack:     error.stack,
      });

      throw error;
    }
  }

  /**
   * Batch відправка повідомлень.
   * @param {string}   channelId   - Discord channel ID
   * @param {object[]} messageList - Масив messageData
   */
  async sendBatch(channelId, messageList) {
    try {
      const results = [];

      for (const messageData of messageList) {
        try {
          const payload     = await this._buildPayload(messageData);
          const sentMessage = await this.rest.sendMessage(channelId, payload);

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
      print(`✗ Failed batch send to Discord channel ${channelId}: ${error.message}`, "error");

      this.eventBus.emit("error.occurred", {
        source:    "discord-destination",
        error:     error.message,
        channelId,
        operation: "batch_send",
        stack:     error.stack,
      });

      throw error;
    }
  }

  // ── Побудова payload ─────────────────────────────────────────────────────

  /**
   * Будує повний Discord message payload.
   *
   * Принцип: лише embed, без content.
   * Якщо є embeddable медіа (photo/animation) — вставляємо через attachment://.
   * Всі медіафайли передаються у files щоб Discord міг до них дістатись.
   *
   * @param {object} messageData
   * @returns {{ embeds: EmbedBuilder[], files?: AttachmentBuilder[] }}
   */
  async _buildPayload(messageData) {
    const sourceName  = messageData.source?.name ?? "";
    const text        = messageData.text ?? "";

    // Обрізаємо текст під ліміт embed.description
    const description = this._truncate(text, this.limits.embedDescriptionLength);

    // Збираємо дані embed
    const embedSpec = {
      author:      sourceName,
      description: description || null,  // null якщо текст порожній
      color:       0x5865f2,             // Discord Blurple за замовчуванням
    };

    let files = [];

    // Обробка медіа
    if (messageData.downloadedMedia?.length > 0) {
      const mediaResult = await this._prepareAttachments(messageData.downloadedMedia);

      files = mediaResult.attachments;

      // Шукаємо перший embeddable файл для embed.image
      const firstEmbeddable = mediaResult.validMedia.find(({ media }) =>
        this.supportedMediaTypes[media.type]?.canEmbed,
      );

      if (firstEmbeddable) {
        const filename    = this._getFilename(firstEmbeddable.media, firstEmbeddable.index);
        embedSpec.image   = `attachment://${filename}`;
      }

      // Попередження про oversized файли (додаємо до footer embed)
      if (mediaResult.oversizedFiles.length > 0) {
        const limitMb = (this.fileSizeLimit / (1024 * 1024)).toFixed(0);
        embedSpec.footer = `⚠️ ${mediaResult.oversizedFiles.length} file(s) skipped — exceeds ${limitMb}MB limit`;
      }
    }

    const embed  = this._buildEmbed(embedSpec);
    const payload = { embeds: [embed] };

    if (files.length > 0) {
      payload.files = files;
    }

    return payload;
  }

  // ── Embed builder ────────────────────────────────────────────────────────

  /**
   * Будує EmbedBuilder з розширеного spec-об'єкта.
   *
   * Spec fields:
   *  author      {string}  — ім'я джерела (показується вгорі)
   *  description {string}  — основний текст (Markdown)
   *  color       {number}  — колір бічної смуги embed
   *  image       {string}  — URL або attachment://filename
   *  thumbnail   {string}  — URL мініатюри
   *  footer      {string}  — текст footer
   *  timestamp   {Date}    — timestamp повідомлення
   *  url         {string}  — URL для title (якщо є title)
   *  title       {string}  — заголовок embed
   *  fields      {Array}   — [{name, value, inline}]
   *
   * @param {object} spec
   * @returns {EmbedBuilder}
   */
  _buildEmbed(spec) {
    const embed = new EmbedBuilder().setColor(spec.color ?? 0x5865f2);

    if (spec.author) {
      embed.setAuthor({
        name: this._truncate(spec.author, this.limits.embedAuthorLength),
      });
    }

    if (spec.title) {
      embed.setTitle(spec.title);
    }

    if (spec.url && spec.title) {
      // URL без title не відображається у Discord
      embed.setURL(spec.url);
    }

    if (spec.description) {
      embed.setDescription(
        this._truncate(spec.description, this.limits.embedDescriptionLength),
      );
    }

    if (spec.image) {
      embed.setImage(spec.image);
    }

    if (spec.thumbnail) {
      embed.setThumbnail(spec.thumbnail);
    }

    if (spec.footer) {
      embed.setFooter({
        text: this._truncate(spec.footer, this.limits.embedFooterLength),
      });
    }

    if (spec.timestamp) {
      embed.setTimestamp(spec.timestamp instanceof Date ? spec.timestamp : new Date(spec.timestamp * 1000));
    }

    if (Array.isArray(spec.fields)) {
      for (const field of spec.fields) {
        embed.addFields({
          name:   field.name,
          value:  field.value,
          inline: field.inline ?? false,
        });
      }
    }

    return embed;
  }

  // ── Медіа ────────────────────────────────────────────────────────────────

  /**
   * Готує AttachmentBuilder масив з downloaded media.
   * Перевіряє розмір кожного файлу проти fileSizeLimit.
   *
   * @param {object[]} downloadedMedia
   * @returns {{ attachments: AttachmentBuilder[], validMedia: {media, index}[], oversizedFiles: object[] }}
   */
  async _prepareAttachments(downloadedMedia) {
    const attachments    = [];
    const validMedia     = [];
    const oversizedFiles = [];

    for (let i = 0; i < downloadedMedia.length; i++) {
      const media = downloadedMedia[i];

      if (!media?.data) {
        print(`Skipping media ${i}: no data buffer`, "warning");
        continue;
      }

      const fileSize = Buffer.byteLength(media.data);

      if (fileSize > this.fileSizeLimit) {
        print(
          `Skipping media ${i} (${media.type}): ${(fileSize / (1024 * 1024)).toFixed(2)}MB exceeds limit`,
          "warning",
        );
        oversizedFiles.push({ index: i, type: media.type, size: fileSize });
        continue;
      }

      const filename   = this._getFilename(media, i);
      const attachment = new AttachmentBuilder(media.data, { name: filename });

      attachments.push(attachment);
      validMedia.push({ media, index: i });

      print(`Added media ${i} (${media.type}): ${filename} (${(fileSize / 1024).toFixed(2)}KB)`, "debug");
    }

    return { attachments, validMedia, oversizedFiles };
  }

  // ── Допоміжні методи ─────────────────────────────────────────────────────

  /**
   * Обрізає рядок до maxLength зі збереженням читабельності.
   * Якщо рядок довший — додає маркер "(…)".
   *
   * @param {string} text
   * @param {number} maxLength
   * @returns {string}
   */
  _truncate(text, maxLength) {
    if (!text || text.length <= maxLength) return text ?? "";

    const suffix    = "\n\n*(…)*";
    const truncateAt = maxLength - suffix.length;

    print(`Truncating message from ${text.length} to ${maxLength} chars`, "warning");

    return text.substring(0, truncateAt) + suffix;
  }

  /**
   * Генерує ім'я файлу для вкладення.
   * Пріоритет: оригінальне ім'я → mime-type → дефолт для типу.
   *
   * @param {object} media
   * @param {number} index
   * @returns {string}
   */
  _getFilename(media, index) {
    const config = this.supportedMediaTypes[media.type];

    if (!config) {
      print(`Unknown media type: ${media.type}, using default`, "warning");
      return `attachment${index}.bin`;
    }

    if (media.filename) {
      return media.filename;
    }

    if (media.mimeType) {
      const ext = this._extFromMime(media.mimeType, config.extensions);
      if (ext) return `attachment${index}.${ext}`;
    }

    return `attachment${index}.${config.defaultExtension}`;
  }

  /**
   * Визначає розширення файлу з MIME type.
   *
   * @param {string}   mimeType
   * @param {string[]} allowedExtensions
   * @returns {string|null}
   */
  _extFromMime(mimeType, allowedExtensions) {
    const mimeMap = {
      "image/jpeg":       "jpg",
      "image/jpg":        "jpg",
      "image/png":        "png",
      "image/gif":        "gif",
      "image/webp":       "webp",
      "video/mp4":        "mp4",
      "video/quicktime":  "mov",
      "video/webm":       "webm",
      "video/x-matroska": "mkv",
      "audio/mpeg":       "mp3",
      "audio/wav":        "wav",
      "audio/ogg":        "ogg",
      "audio/mp4":        "m4a",
      "application/pdf":  "pdf",
      "application/zip":  "zip",
    };

    const ext = mimeMap[mimeType];
    return ext && allowedExtensions.includes(ext) ? ext : null;
  }

  /**
   * Очищення каналу (утиліта для адміністраторів).
   * @param {string} channelId
   * @param {number} limit      - Max 100 (Discord API обмеження)
   */
  async clearChannel(channelId, limit = 100) {
    try {
      const messages = await this.rest.fetchMessages(channelId, { limit });
      await Promise.all(messages.map((msg) => this.rest.deleteMessage(channelId, msg.id)));

      print(`Channel ${channelId} cleared: ${messages.length} messages deleted`, "success");

      return messages.length;
    } catch (error) {
      print(`Failed to clear channel ${channelId}: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * Форматування повідомлення — публічний метод для сумісності з BaseDestinationAdapter.
   * Основна логіка тепер у _buildPayload.
   * @param {object} messageData
   * @returns {object}
   */
  async formatMessage(messageData) {
    return this._buildPayload(messageData);
  }
}

export default DiscordDestinationAdapter;

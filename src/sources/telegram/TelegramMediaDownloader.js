import { print, printStack } from "../../shared/utils.js";
import { DOWNLOADABLE_MEDIA_TYPES } from "../../config/app.config.js";

/**
 * TelegramMediaDownloader
 *
 * Інкапсулює логіку завантаження медіафайлів через GramJS клієнт.
 * Підтримує одиночні медіа і масиви (альбоми).
 */
class TelegramMediaDownloader {
  constructor(client) {
    this.client = client;
    // Можна перевизначити ззовні за потреби
    this.downloadableTypes = DOWNLOADABLE_MEDIA_TYPES;
  }

  /**
   * Завантажує медіа з messageData.
   * @param {object} messageData - нормалізований об'єкт повідомлення
   * @param {string[]} [allowedTypes] - перевизначення списку типів для цього
   *   виклику (джерело може качати більше — Source.getDownloadableMediaTypes).
   * @returns {Promise<object[]|null>} масив завантажених файлів або null
   */
  async download(messageData, allowedTypes = null) {
    if (!messageData.media) return null;

    const types = Array.isArray(allowedTypes) && allowedTypes.length > 0
      ? allowedTypes
      : this.downloadableTypes;

    try {
      if (Array.isArray(messageData.media)) {
        return await this._downloadMany(messageData.media, messageData.messageId, types);
      }
      return await this._downloadOne(messageData.media, messageData.messageId, types);
    } catch (error) {
      print(
        `Error downloading media for message ${messageData.messageId}: ${error.message}`,
        "error",
      );
      printStack(error);
      return null;
    }
  }

  // ── internal ─────────────────────────────────────────────────────────────

  async _downloadMany(mediaList, messageId, types) {
    const results = [];

    for (const media of mediaList) {
      if (!types.includes(media.type)) {
        this._logSkip(media, messageId, types);
        continue;
      }

      const buffer = await this.client.downloadMedia(media.raw, {});
      if (buffer) {
        results.push(this._buildFileRecord(media, buffer));
      }
    }

    return results.length > 0 ? results : null;
  }

  async _downloadOne(media, messageId, types) {
    if (!types.includes(media.type)) {
      this._logSkip(media, messageId, types);
      return null;
    }

    const buffer = await this.client.downloadMedia(media.raw, {});
    if (!buffer) return null;

    return [this._buildFileRecord(media, buffer)];
  }

  /**
   * Пропуск через незавантажуваний тип.
   *
   * Раніше це був голий `continue` без жодного рядка в лог — єдине місце в
   * конвеєрі, де медіа зникало безшумно, і причину не було видно ні в логах,
   * ні в помилках. Тепер видно, і видно чим це лікується.
   */
  _logSkip(media, messageId, types) {
    print(
      `Skipping ${media.type} in message ${messageId}: not in downloadable types ` +
        `[${types.join(", ")}] — add it to the source's extra_media_types to keep it`,
      "debug",
    );
  }

  _buildFileRecord(media, buffer) {
    return {
      type:     media.type,
      data:     buffer,
      filename: media.filename,
      mimeType: media.mimeType,
      fileSize: media.fileSize,
      duration: media.duration,
      width:    media.width,
      height:   media.height,
    };
  }

  setDownloadableTypes(types) {
    if (!Array.isArray(types)) throw new Error("types must be an array");
    this.downloadableTypes = types;
  }
}

export default TelegramMediaDownloader;

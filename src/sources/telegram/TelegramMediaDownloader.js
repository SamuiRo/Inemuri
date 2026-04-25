import { print } from "../../shared/utils.js";
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
   * @returns {Promise<object[]|null>} масив завантажених файлів або null
   */
  async download(messageData) {
    if (!messageData.media) return null;

    try {
      if (Array.isArray(messageData.media)) {
        return await this._downloadMany(messageData.media, messageData.messageId);
      }
      return await this._downloadOne(messageData.media, messageData.messageId);
    } catch (error) {
      print(
        `Error downloading media for message ${messageData.messageId}: ${error.message}`,
        "error",
      );
      console.error(error);
      return null;
    }
  }

  // ── internal ─────────────────────────────────────────────────────────────

  async _downloadMany(mediaList, messageId) {
    const results = [];

    for (const media of mediaList) {
      if (!this.downloadableTypes.includes(media.type)) continue;

      const buffer = await this.client.downloadMedia(media.raw, {});
      if (buffer) {
        results.push(this._buildFileRecord(media, buffer));
      }
    }

    return results.length > 0 ? results : null;
  }

  async _downloadOne(media, messageId) {
    if (!this.downloadableTypes.includes(media.type)) return null;

    const buffer = await this.client.downloadMedia(media.raw, {});
    if (!buffer) return null;

    return [this._buildFileRecord(media, buffer)];
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
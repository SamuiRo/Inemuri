/**
 * TelegramMessageParser
 *
 * Відповідає виключно за перетворення сирих об'єктів GramJS
 * у нормалізований формат messageData.
 * Не має стану, не залежить від EventBus чи клієнта.
 */

const MEDIA_TYPE_MAP = {
  MessageMediaPhoto:    "photo",
  MessageMediaDocument: "document",
  MessageMediaWebPage:  "webpage",
  MessageMediaGeo:      "location",
  MessageMediaContact:  "contact",
  MessageMediaPoll:     "poll",
};

class TelegramMessageParser {
  /**
   * Перетворює MTProto-подію (NewMessage event) у messageData.
   * @param {object} event  - GramJS NewMessage event
   * @param {string} platform
   * @returns {object} messageData
   */
  parseEvent(event, platform) {
    const message = event.message;
    return this._buildMessageData(message, platform, message.chatId?.toString());
  }

  /**
   * Перетворює сирий об'єкт повідомлення (polling) у messageData.
   * @param {object} msg       - GramJS Message object
   * @param {string} channelId - явно переданий ID каналу
   * @param {string} platform
   * @returns {object} messageData
   */
  parseRaw(msg, channelId, platform) {
    return this._buildMessageData(msg, platform, String(channelId));
  }

  // ── internal ─────────────────────────────────────────────────────────────

  _buildMessageData(message, platform, channelId) {
    return {
      platform,
      channelId,
      messageId:       message.id,
      text:            message.message ?? message.text ?? "",
      media:           this.parseMedia(message),
      timestamp:       message.date,
      sender:          message.senderId?.toString(),
      isForwarded:     message.fwdFrom !== undefined,
      replyToMessageId: message.replyTo?.replyToMsgId,
      groupedId:       message.groupedId?.toString() ?? null,
      raw:             message,
    };
  }

  /**
   * Витягує мета-дані медіа з повідомлення.
   * @param {object} message
   * @returns {object|null} mediaInfo або null
   */
  parseMedia(message) {
    if (!message.media) return null;

    const media     = message.media;
    const className = media.className ?? media.constructor?.name ?? "";
    const mediaType = MEDIA_TYPE_MAP[className] ?? "unknown";
    const mediaInfo = { type: mediaType, raw: media };

    if (media.photo) {
      mediaInfo.mimeType = "image/jpeg";
      return mediaInfo;
    }

    if (media.document) {
      const doc = media.document;
      mediaInfo.mimeType  = doc.mimeType;
      mediaInfo.fileSize  = doc.size;
      mediaInfo.filename  = doc.attributes?.find(
        (a) => a.className === "DocumentAttributeFilename",
      )?.fileName;

      for (const attr of doc.attributes ?? []) {
        switch (attr.className) {
          case "DocumentAttributeVideo":
            mediaInfo.type     = attr.roundMessage ? "video_note" : "video";
            mediaInfo.duration = attr.duration;
            mediaInfo.width    = attr.w;
            mediaInfo.height   = attr.h;
            break;
          case "DocumentAttributeAnimated":
            mediaInfo.type = "animation";
            break;
          case "DocumentAttributeAudio":
            mediaInfo.type      = "audio";
            mediaInfo.duration  = attr.duration;
            mediaInfo.title     = attr.title;
            mediaInfo.performer = attr.performer;
            break;
        }
      }
    }

    return mediaInfo;
  }
}

export default new TelegramMessageParser();
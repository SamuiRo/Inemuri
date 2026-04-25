import { print } from "../../shared/utils.js";
import { ALBUM_GROUP_TIMEOUT_MS } from "../../config/app.config.js";

/**
 * TelegramGroupBuffer
 *
 * Накопичує повідомлення одного альбому (groupedId) протягом
 * ALBUM_GROUP_TIMEOUT_MS і потім передає зібраний альбом у callback.
 *
 * Callback отримує один об'єкт groupedMessage із:
 *   - text — об'єднаний текст усіх повідомлень
 *   - media — масив усіх медіа
 *   - isGrouped: true
 *   - groupSize: <кількість>
 */
class TelegramGroupBuffer {
  /**
   * @param {function(messageData): Promise<void>} onGroupReady
   *   Викликається коли альбом зібрано.
   * @param {number} [timeout] Перевизначає дефолтний таймаут.
   */
  constructor(onGroupReady, timeout = ALBUM_GROUP_TIMEOUT_MS) {
    this._onGroupReady = onGroupReady;
    this._timeout      = timeout;
    // groupedId -> { messages: object[], timer: TimeoutID }
    this._groups       = new Map();
  }

  /**
   * Додає повідомлення до відповідної групи.
   * Якщо група ще не існує — створює її і запускає таймер.
   * @param {object} messageData
   */
  add(messageData) {
    const groupId = messageData.groupedId;
    let group = this._groups.get(groupId);

    if (!group) {
      group = { messages: [], timer: null };
      this._groups.set(groupId, group);
    }

    group.messages.push(messageData);

    // Перезапускаємо таймер після кожного нового повідомлення
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(() => this._flush(groupId), this._timeout);

    print(
      `[GROUP_BUFFER] groupedId=${groupId}: ${group.messages.length} message(s) buffered`,
      "debug",
    );
  }

  /**
   * Очищає всі таймери (при зупинці сервісу).
   */
  clear() {
    for (const [, group] of this._groups) {
      if (group.timer) clearTimeout(group.timer);
    }
    this._groups.clear();
  }

  get activeGroups() {
    return this._groups.size;
  }

  // ── internal ─────────────────────────────────────────────────────────────

  async _flush(groupId) {
    const group = this._groups.get(groupId);
    this._groups.delete(groupId);

    if (!group || group.messages.length === 0) return;

    try {
      group.messages.sort((a, b) => a.messageId - b.messageId);

      const first       = group.messages[0];
      const allMedia    = group.messages.map((m) => m.media).filter(Boolean);
      const combinedText = group.messages
        .map((m) => m.text)
        .filter((t) => t?.trim().length > 0)
        .join("\n");

      const groupedMessage = {
        ...first,
        text:      combinedText,
        media:     allMedia.length > 0 ? allMedia : null,
        isGrouped: true,
        groupSize: group.messages.length,
        groupedId: groupId,
      };

      print(
        `[GROUP_BUFFER] groupedId=${groupId}: flushing ${group.messages.length} message(s)`,
      );

      await this._onGroupReady(groupedMessage);
    } catch (error) {
      print(`[GROUP_BUFFER] Error flushing group ${groupId}: ${error.message}`, "error");
      console.error(error);
    }
  }
}

export default TelegramGroupBuffer;
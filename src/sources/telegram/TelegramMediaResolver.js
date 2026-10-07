import { print } from "../../shared/utils.js";
import telegramClient from "../../module/telegram/TelegramClient.js";
import TelegramMediaDownloader from "./TelegramMediaDownloader.js";
import TelegramMessageParser from "./TelegramMessageParser.js";

/**
 * Resolves `media_ref.kind === "telegram"`.
 *
 * Re-fetches the message(s) by id through GramJS `getMessages`, parses their
 * media the same way ingestion does (`TelegramMessageParser.parseMedia`), then
 * hands them to the existing `TelegramMediaDownloader` — no new download logic.
 *
 * Albums: `media_ref` stores the album's first (lowest) message id plus
 * `grouped_id`. Telegram caps an album at 10 items with consecutive ids, so a
 * forward window of 10 from that id covers the whole album; entries whose
 * `groupedId` does not match are dropped (gaps and neighbours are tolerated).
 */
const ALBUM_MAX = 10;

export class TelegramMediaResolver {
  /**
   * @param {object} [deps]
   * @param {object} [deps.client]      GramJS client (defaults to the shared singleton).
   * @param {object} [deps.downloader]  TelegramMediaDownloader (defaults to one bound to `client`).
   * @param {object} [deps.parser]      Media parser (defaults to the shared TelegramMessageParser).
   */
  constructor({ client, downloader, parser } = {}) {
    this._client = client ?? null;
    this._downloader = downloader ?? null;
    this._parser = parser ?? TelegramMessageParser;
  }

  _getClient() {
    return this._client ?? telegramClient.getClient();
  }

  _getDownloader() {
    if (!this._downloader) {
      this._downloader = new TelegramMediaDownloader(this._getClient());
    }
    return this._downloader;
  }

  /**
   * @param {import("../../teapot/models/Post.js").default} post
   * @param {{types?: string[], limit?: number}} [opts]  Див. MediaResolver.resolve.
   * @returns {Promise<object[]>} [{ type, buffer, filename, mimeType, fileSize, duration, width, height }]
   */
  async resolve(post, { types = null, limit = null, accept = null } = {}) {
    const ref = post?.media_ref;
    if (!ref || ref.kind !== "telegram" || ref.channel_id == null || ref.message_id == null) {
      print(`[MEDIA] telegram: post#${post?.id} has no usable media_ref`, "debug");
      return [];
    }

    const firstId = Number(ref.message_id);
    const ids = ref.grouped_id
      ? Array.from({ length: ALBUM_MAX }, (_, i) => firstId + i)
      : [firstId];

    let messages;
    try {
      messages = await this._getClient().getMessages(String(ref.channel_id), { ids });
    } catch (error) {
      print(`[MEDIA] telegram: getMessages failed for post#${post.id}: ${error.message}`, "error");
      throw error;
    }

    let list = (messages ?? []).filter((m) => m && m.media);
    if (ref.grouped_id) {
      list = list.filter((m) => m.groupedId?.toString() === String(ref.grouped_id));
    }
    if (list.length === 0) {
      print(`[MEDIA] telegram: nothing to download for post#${post.id}`, "debug");
      return [];
    }

    let parsedMedia = list
      .map((m) => this._parser.parseMedia(m))
      .filter(Boolean);

    // Відсіюємо ДО завантаження, а не після: байти тут — головна вартість.
    // Пост із відео, від якого vision потрібні лише зображення, інакше тягнув
    // би весь ролик заради того, щоб його викинути.
    if (Array.isArray(types) && types.length > 0) {
      parsedMedia = parsedMedia.filter((m) => types.includes(m.type));
    }
    // Тонший фільтр за метаданими, які відомі до завантаження (mimeType,
    // fileSize документа). Напр. vision: документ лише якщо це зображення
    // розумного розміру.
    if (typeof accept === "function") {
      parsedMedia = parsedMedia.filter((m) => accept(m));
    }
    if (Number.isInteger(limit) && limit > 0) {
      parsedMedia = parsedMedia.slice(0, limit);
    }
    if (parsedMedia.length === 0) {
      print(`[MEDIA] telegram: nothing of the requested kind for post#${post.id}`, "debug");
      return [];
    }

    // The downloader takes a messageData-shaped object: a single media object,
    // or an array for albums. It returns file records or null.
    const files = await this._getDownloader().download(
      { media: parsedMedia.length === 1 ? parsedMedia[0] : parsedMedia, messageId: firstId },
      // Типи для завантажувача — з того, що пережило фільтри: інакше його
      // глобальний список тихо відкидав би запитаний тип.
      Array.isArray(types) || typeof accept === "function"
        ? [...new Set(parsedMedia.map((m) => m.type))]
        : null,
    );

    return (files ?? []).map((f) => ({
      type: f.type,
      buffer: f.data,
      filename: f.filename,
      mimeType: f.mimeType,
      fileSize: f.fileSize,
      duration: f.duration,
      width: f.width,
      height: f.height,
    }));
  }
}

export default TelegramMediaResolver;

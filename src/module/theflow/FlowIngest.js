import { Op } from "sequelize";

import { Post } from "../teapot/models/index.js";
import RegexStage from "./RegexStage.js";
import {
  THEFLOW_MIN_TEXT_LENGTH,
  THEFLOW_REPOST_WINDOW_HOURS,
} from "../../config/app.config.js";

/**
 * TheFlow — стадія 1 (Ingest).
 *
 * Синхронна, швидка, БЕЗ вихідних мережевих викликів — це частина, якій
 * ніколи не дозволено зупинятись (docs/theflow/ARCHITECTURE.md).
 *
 * Приймає нормалізований messageData з TelegramSourceListener (після
 * text_replacements), проганяє regex-стадію, перевіряє repost по вікну і
 * робить ідемпотентний INSERT у `posts`. Далі рядок читає воркер enrich —
 * у фазі 0 воркера ще немає, тож рядки просто накопичуються.
 *
 * Кожен вхідний пост отримує рядок. status фіксує, чому пост не піде далі
 * (skipped_*), — це не «викинуто», а «збережено з причиною».
 *
 * Медіа НЕ завантажується тут (інваріант: ingest без мережі). image_hash
 * лишається null — його рахує окремий бекфіл-прохід (див. VISION.md: у фазі 0
 * важливо мати has_media та хеш, але не ціною мережі в update-loop).
 */

const REAL_MEDIA_TYPES = new Set([
  "photo", "video", "video_note", "document", "animation", "audio",
]);

export class FlowIngest {
  constructor({
    minTextLength = THEFLOW_MIN_TEXT_LENGTH,
    repostWindowHours = THEFLOW_REPOST_WINDOW_HOURS,
  } = {}) {
    this._regex = new RegexStage({ minTextLength });
    this._repostWindowMs = repostWindowHours * 60 * 60 * 1000;
  }

  /**
   * @param {object} args
   * @param {import("../teapot/models/Source.js").default} args.source
   * @param {object} args.messageData         Нормалізований messageData.
   * @param {string} args.text                Plain text ПІСЛЯ text_replacements.
   * @param {Set<string>|null} args.blacklist Скомпільований blacklist джерела.
   * @param {boolean} [args.caseSensitive=false] Регістрозалежність blacklist —
   *   те саме значення, з яким MessageFilter зібрав Set.
   * @param {object|null} [args.rejectShouty] Скомпільований reject_shouty
   *   джерела, або null — вимкнено.
   * @returns {Promise<{ created: boolean, post: object, status: string }>}
   */
  async ingest({ source, messageData, text, blacklist, caseSensitive = false, rejectShouty = null }) {
    const channelId = String(messageData.channelId);
    const platform = messageData.platform ?? "telegram";
    const title = messageData.title ?? null;

    // 1. Regex-стадія (чиста, без I/O). Заголовок (Reddit, новини) — частина
    //    того, що перевіряється: пост-посилання з Reddit має лише заголовок,
    //    і без нього став би skipped_empty. raw_text нижче — лише тіло.
    const stageText = [title, text].filter((s) => s && String(s).trim() !== "").join("\n\n");
    const stage = this._regex.evaluate({ text: stageText, blacklist, caseSensitive, rejectShouty });

    // 2. skipped_repost — точний хеш-збіг у вікні останніх N годин, лише в
    //    межах ЦЬОГО джерела (ROADMAP §6.1, варіант 1). Канал, що повторює
    //    сам себе, — шум. Той самий текст з ІНШОГО каналу — не шум, а
    //    tier 1 дедуплікації: він має пройти enrich і приєднатися до
    //    кластера, інакше «також повідомили N каналів» недораховує саме
    //    найдешевші дублікати. Повторний enrich однакового тексту поглинає
    //    кеш gateway. Той самий (source_id, external_id) ловиться нижче
    //    ідемпотентністю findOrCreate, сюди не доходить.
    let status = stage.status;
    if (status === "ok" && stage.textHash) {
      const since = new Date(Date.now() - this._repostWindowMs);
      const earlier = await Post.findOne({
        where: {
          source_id: source.id,
          text_hash: stage.textHash,
          createdAt: { [Op.gte]: since },
        },
        attributes: ["id"],
      });
      if (earlier) status = "skipped_repost";
    }

    const finalStatus = status === "ok" ? "pending" : status;

    // 3. Ідемпотентний INSERT по (source_id, external_id).
    //    created === false → режим "both" або повторний polling; рядок уже є.
    // Медіа: Telegram — за типами з парсера (лінивий re-fetch через GramJS);
    // стрічки — список URL зображень (UrlMediaResolver, ROADMAP §7.3).
    const mediaUrls = Array.isArray(messageData.mediaUrls) ? messageData.mediaUrls.filter(Boolean) : [];
    const hasMedia = platform === "telegram"
      ? FlowIngest._hasRealMedia(messageData.media)
      : mediaUrls.length > 0;
    const mediaRef = !hasMedia
      ? null
      : platform === "telegram"
        ? FlowIngest._buildMediaRef(channelId, messageData)
        : { kind: "url", urls: mediaUrls };

    const [post, created] = await Post.ingest({
      source_id: source.id,
      platform,
      // external_id — універсальна ідентичність елемента: Telegram message id
      // як текст, Reddit fullname (t3_…), guid або URL статті в RSS.
      external_id: String(messageData.externalId ?? messageData.messageId),
      // Telegram: канонічного публічного лінка немає; Reddit — permalink,
      // RSS — посилання статті (ще й tier-1 ключ дедуплікації).
      external_url: messageData.externalUrl ?? null,
      channel_id: channelId,
      grouped_id: messageData.groupedId ?? null,
      posted_at: FlowIngest._toDate(messageData.timestamp),
      title,
      author: messageData.author ?? null,
      // raw_text = plain text ПІСЛЯ replacements: це саме той вхід, що бачить
      // enrich() ("text after text_replacements"), і проти нього працює
      // verbatim-валідація. Не перезаписується стадіями нижче.
      raw_text: text ?? null,
      text_md: messageData.text ?? null,
      // entities — оригінальні MTProto entities як plain-масив. Offset-и
      // індексують ОРИГІНАЛЬНИЙ текст (до replacements); _syncMarkdown уже
      // толерує дрейф, і доставка теж (DELIVERY.md).
      entities: FlowIngest._serializeEntities(messageData.entities),
      text_hash: stage.textHash,
      has_media: hasMedia,
      media_ref: mediaRef,
      image_hash: null, // рахує окремий прохід, не ingest
      candidates: stage.candidates,
      status: finalStatus,
      attempts: 0,
    });

    return { created, post, status: post.status };
  }

  // ── helpers ───────────────────────────────────────────────────────

  static _hasRealMedia(media) {
    if (!media) return false;
    const list = Array.isArray(media) ? media : [media];
    return list.some((m) => m && REAL_MEDIA_TYPES.has(m.type));
  }

  /**
   * Що стадії 3 треба, щоб дістати медіа пізніше (лінива доставка).
   * GramJS getMessages по channel_id + message_id повертає повідомлення,
   * далі TelegramMediaDownloader робить решту.
   */
  static _buildMediaRef(channelId, messageData) {
    return {
      kind: "telegram",
      channel_id: channelId,
      message_id: messageData.messageId,
      grouped_id: messageData.groupedId ?? null,
    };
  }

  /**
   * Сирі GramJS entity-об'єкти → plain-масив, придатний для JSON-колонки.
   * Зберігаємо рівно те, що потрібно TelegramDestination.buildFormattingEntities:
   * className + offset + length, плюс url (TextUrl) і language (Pre).
   */
  static _serializeEntities(entities) {
    if (!Array.isArray(entities) || entities.length === 0) return null;
    const out = [];
    for (const e of entities) {
      // Справжні GramJS entity завжди мають className "MessageEntity*".
      // Fallback на constructor.name НЕ беремо — на plain-об'єкті це "Object".
      const className = e?.className;
      if (
        typeof className !== "string" ||
        !className.startsWith("MessageEntity") ||
        typeof e.offset !== "number" ||
        typeof e.length !== "number"
      ) {
        continue;
      }
      const item = { className, offset: e.offset, length: e.length };
      if (e.url) item.url = e.url;
      if (e.language) item.language = e.language;
      out.push(item);
    }
    return out.length ? out : null;
  }

  /**
   * GramJS message.date — Unix-секунди (number). Буває вже Date.
   */
  static _toDate(ts) {
    if (ts === null || ts === undefined) return null;
    if (ts instanceof Date) return ts;
    if (typeof ts === "number") return new Date(ts * 1000);
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

export default FlowIngest;

/**
 * TelegramMessageParser
 *
 * Відповідає виключно за перетворення сирих об'єктів GramJS
 * у нормалізований формат messageData.
 * Не має стану, не залежить від EventBus чи клієнта.
 *
 * Підтримує парсинг Telegram message.entities у Markdown-рядок
 * з вбудованими гіперпосиланнями та форматуванням (bold, italic, code, pre).
 */

const MEDIA_TYPE_MAP = {
  MessageMediaPhoto:    "photo",
  MessageMediaDocument: "document",
  MessageMediaWebPage:  "webpage",
  MessageMediaGeo:      "location",
  MessageMediaContact:  "contact",
  MessageMediaPoll:     "poll",
};

/**
 * Типи entities, які потребують спеціальної обробки.
 * Порядок у масиві відповідає пріоритету при конфлікті вкладених entities.
 */
const ENTITY_TYPE_MAP = {
  // Посилання
  MessageEntityTextUrl: "text_url",   // [text](url) — кастомний текст посилання
  MessageEntityUrl:     "url",        // bare URL у тексті
  // Форматування
  MessageEntityBold:          "bold",
  MessageEntityItalic:        "italic",
  MessageEntityCode:          "code",
  MessageEntityPre:           "pre",
  MessageEntityStrikethrough: "strikethrough",
  MessageEntityUnderline:     "underline",
  MessageEntitySpoiler:       "spoiler",
  // Спеціальні
  MessageEntityMention:       "mention",   // @username
  MessageEntityHashtag:       "hashtag",   // #tag
  MessageEntityEmail:         "email",
  MessageEntityPhone:         "phone",
  MessageEntityCashtag:       "cashtag",   // $BTC
  MessageEntityBotCommand:    "bot_command",
};

class TelegramMessageParser {
  /**
   * Перетворює MTProto-подію (NewMessage event) у messageData.
   * @param {object} event   - GramJS NewMessage event
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
    const rawText   = message.message ?? message.text ?? "";
    const entities  = message.entities ?? [];

    // Конвертуємо raw text + entities у Markdown-рядок.
    // formattedText використовується в усіх destinations як єдине джерело тексту.
    const formattedText = this.entitiesToMarkdown(rawText, entities);

    return {
      platform,
      channelId,
      messageId:        message.id,
      text:             formattedText,   // Markdown з посиланнями та форматуванням
      rawText,                           // Оригінальний plain text (для фільтрів)
      entities,                          // Оригінальні entities (для можливого реuse)
      media:            this.parseMedia(message),
      timestamp:        message.date,
      sender:           message.senderId?.toString(),
      isForwarded:      message.fwdFrom !== undefined,
      replyToMessageId: message.replyTo?.replyToMsgId,
      groupedId:        message.groupedId?.toString() ?? null,
      raw:              message,
    };
  }

  // ── Entity → Markdown ─────────────────────────────────────────────────────

  /**
   * Конвертує plain text + Telegram entities у Markdown-рядок.
   *
   * Алгоритм:
   *  1. Сортуємо entities за offset (зростання), потім за length (спадання)
   *     щоб зовнішня entity оброблялась раніше вкладеної.
   *  2. Будуємо масив "сегментів" — ділянок тексту між entities.
   *  3. Для кожної entity вставляємо Markdown-синтаксис навколо відповідної
   *     підрядки тексту.
   *
   * Важливо: Telegram зберігає offset/length у байтах UTF-16 (codeUnits),
   * тому для коректного зрізу рядка використовуємо Array.from() і
   * відновлення через join — це безпечно для emoji і Unicode.
   *
   * @param {string}   text     - Оригінальний plain text
   * @param {object[]} entities - Масив GramJS entity об'єктів
   * @returns {string} Markdown-рядок
   */
  entitiesToMarkdown(text, entities) {
    if (!text || !entities || entities.length === 0) {
      return text ?? "";
    }

    // Telegram entities використовують UTF-16 codeUnit offsets.
    // Array.from розбиває по Unicode code points (emoji safe),
    // але для точного розрахунку offset ми конвертуємо через codePointAt.
    // Для більшості текстів (латиниця, кирилиця) — різниці немає.
    // Для emoji — Telegram теж рахує їх як 2 codeUnits (surrogate pair),
    // тому використовуємо той самий підхід: String.prototype.slice по індексах.

    // Сортуємо: спочатку за offset, при рівному offset — довші entity першими
    const sorted = [...entities].sort((a, b) => {
      if (a.offset !== b.offset) return a.offset - b.offset;
      return b.length - a.length;
    });

    // Будуємо відповідність className -> тип
    const getEntityType = (entity) => {
      const className = entity.className ?? entity.constructor?.name ?? "";
      return ENTITY_TYPE_MAP[className] ?? null;
    };

    // Рекурсивна функція обробки сегменту тексту з відповідними entities
    const renderSegment = (segText, segEntities, segOffset) => {
      if (!segEntities || segEntities.length === 0) {
        return this._escapeMarkdown(segText);
      }

      // Беремо першу (зовнішню) entity
      const entity     = segEntities[0];
      const remaining  = segEntities.slice(1);
      const entityType = getEntityType(entity);

      if (!entityType) {
        // Невідомий тип — пропускаємо entity, обробляємо далі
        return renderSegment(segText, remaining, segOffset);
      }

      const relStart = entity.offset - segOffset;
      const relEnd   = relStart + entity.length;

      // Текст до entity
      const before  = segText.slice(0, relStart);
      // Текст всередині entity
      const inner   = segText.slice(relStart, relEnd);
      // Текст після entity
      const after   = segText.slice(relEnd);

      // Entities, які вкладені в поточну entity
      const innerEntities = remaining.filter(
        (e) => e.offset >= entity.offset && (e.offset + e.length) <= (entity.offset + entity.length),
      );
      // Entities, які йдуть після поточної entity
      const afterEntities = remaining.filter(
        (e) => e.offset >= entity.offset + entity.length,
      );

      const renderedInner = this._applyEntityMarkdown(
        entityType,
        entity,
        inner,
        innerEntities,
        entity.offset,
        renderSegment,
      );

      return (
        this._escapeMarkdown(before) +
        renderedInner +
        renderSegment(after, afterEntities, entity.offset + entity.length)
      );
    };

    return renderSegment(text, sorted, 0);
  }

  /**
   * Застосовує Markdown-обгортку для конкретного типу entity.
   *
   * Ключові правила:
   *  - text_url: trim пробілів у тексті посилання, бо Telegram Markdown не рендерить
   *              [AERO    ](url) — trailing spaces ламають синтаксис в обох платформах.
   *  - hashtag / mention / cashtag: повертаємо innerText БЕЗ escape, бо
   *    _escapeMarkdown екранує їх символи і Discord показує \#testnet замість #testnet.
   *  - bold / italic / strikethrough / spoiler: rendered вже пройшов через escapeMarkdown
   *    для plain сегментів — це правильно, залишаємо як є.
   *
   * @param {string}   type           - Тип entity зі словника ENTITY_TYPE_MAP
   * @param {object}   entity         - Оригінальна entity (для url, pre.language тощо)
   * @param {string}   innerText      - Текст всередині entity (plain, без escape)
   * @param {object[]} innerEntities  - Вкладені entities
   * @param {number}   innerOffset    - Абсолютний offset початку inner
   * @param {Function} renderFn       - Рекурсивна функція render
   * @returns {string}
   */
  _applyEntityMarkdown(type, entity, innerText, innerEntities, innerOffset, renderFn) {
    // Рендеримо внутрішній текст рекурсивно (обробка вкладених entities)
    const rendered = renderFn(innerText, innerEntities, innerOffset);

    switch (type) {
      // ── Посилання ──────────────────────────────────────────────────────
      case "text_url": {
        const url = entity.url ?? "";
        if (!url) return rendered;
        // FIX: trim пробілів у тексті посилання.
        // Telegram часто додає trailing spaces для вирівнювання таблиць:
        // "[AERO    ](url)" — такий синтаксис не рендериться ні в Telegram ні в Discord.
        // Після trim: "[AERO](url)" — рендериться коректно.
        const linkText = rendered.trim();
        if (!linkText) return rendered; // якщо весь текст — пробіли, повертаємо як є
        return `[${linkText}](${url})`;
      }

      case "url": {
        // Bare URL — текст і є посиланням, повертаємо як є (Discord авто-embed)
        // Не обертаємо в [url](url) щоб уникнути дублювання в Telegram
        return innerText;
      }

      // ── Форматування ───────────────────────────────────────────────────

      // Для bold / italic / strikethrough / spoiler виносимо leading і trailing
      // пробіли назовні маркерів.
      //
      // Причина: Telegram entity може охоплювати trailing пробіл між словами,
      // наприклад Bold("always ") + Bold("#dyor") → "**always ****#dyor**".
      // Discord не рендерить bold якщо маркер впирається в пробіл зсередини.
      // Після trim: "**always** **#dyor**" — рендериться коректно.

      case "bold": {
        const trimmedEnd   = rendered.trimEnd();
        const trailing     = rendered.slice(trimmedEnd.length);
        const trimmedStart = trimmedEnd.trimStart();
        const leading      = trimmedEnd.slice(0, trimmedEnd.length - trimmedStart.length);
        if (!trimmedStart) return rendered; // суцільні пробіли — без форматування
        return `${leading}**${trimmedStart}**${trailing}`;
      }

      case "italic": {
        const trimmedEnd   = rendered.trimEnd();
        const trailing     = rendered.slice(trimmedEnd.length);
        const trimmedStart = trimmedEnd.trimStart();
        const leading      = trimmedEnd.slice(0, trimmedEnd.length - trimmedStart.length);
        if (!trimmedStart) return rendered;
        return `${leading}*${trimmedStart}*${trailing}`;
      }

      case "code":
        return `\`${innerText}\``; // code — не escapeємо всередині

      case "pre": {
        const lang = entity.language ?? "";
        return `\`\`\`${lang}\n${innerText}\n\`\`\``;
      }

      case "strikethrough": {
        const trimmedEnd   = rendered.trimEnd();
        const trailing     = rendered.slice(trimmedEnd.length);
        const trimmedStart = trimmedEnd.trimStart();
        const leading      = trimmedEnd.slice(0, trimmedEnd.length - trimmedStart.length);
        if (!trimmedStart) return rendered;
        return `${leading}~~${trimmedStart}~~${trailing}`;
      }

      case "underline":
        // Discord не підтримує underline в Markdown — залишаємо plain
        return rendered;

      case "spoiler": {
        const trimmedEnd   = rendered.trimEnd();
        const trailing     = rendered.slice(trimmedEnd.length);
        const trimmedStart = trimmedEnd.trimStart();
        const leading      = trimmedEnd.slice(0, trimmedEnd.length - trimmedStart.length);
        if (!trimmedStart) return rendered;
        return `${leading}||${trimmedStart}||${trailing}`;
      }

      // ── Спеціальні ─────────────────────────────────────────────────────
      case "mention":
      case "hashtag":
      case "cashtag":
      case "bot_command":
        // FIX: повертаємо innerText БЕЗ escape.
        // _escapeMarkdown екранує # → \# і @ → (не в regex, але _ може бути).
        // Хештеги і mentions — plain символи, їх не треба escape в Discord/Telegram.
        // Якщо є вкладені entities всередині (рідко) — беремо rendered, інакше innerText.
        return innerEntities.length > 0 ? rendered : innerText;

      case "email":
      case "phone":
        return innerText;

      default:
        return rendered;
    }
  }

  /**
   * Екранує символи Markdown у plain-text сегментах
   * щоб уникнути випадкового форматування.
   *
   * Екрануємо лише символи що реально тригерять Markdown rendering
   * в Discord і Telegram при появі парами:
   *   *  — italic/bold
   *   _  — italic/bold
   *   ~  — strikethrough
   *   `  — code
   *   [  — початок посилання (] без [ не шкодить)
   *   |  — spoiler (||)
   *
   * НЕ екрануємо:
   *   #  — заголовки лише на початку рядка в Discord, в Telegram не форматує взагалі
   *   >  — blockquote лише на початку рядка; у середині тексту не шкодить
   *   \  — зайвий escape призводить до відображення зайвих backslash
   *   @  — mention, не є Markdown
   *
   * @param {string} text
   * @returns {string}
   */
  _escapeMarkdown(text) {
    if (!text) return "";
    return text.replace(/([*_~`\[|])/g, "\\$1");
  }

  // ── Media ─────────────────────────────────────────────────────────────────

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
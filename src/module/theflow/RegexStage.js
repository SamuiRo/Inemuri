import crypto from "crypto";

import { PROMO_RE, isPromoLike, isShouty, isTooShort } from "../../shared/text.js";

/**
 * TheFlow — regex-стадія (перед AI).
 *
 * Детермінована й безкоштовна. Три ролі (docs/theflow/ARCHITECTURE.md):
 *   1. Rejection — пост не доходить до AI (skipped_blacklist / skipped_empty /
 *      skipped_noise / skipped_shouty). skipped_repost вирішується не тут, а
 *      у FlowIngest — бо потребує запиту до вікна в БД.
 *   2. Candidate extraction — regex не вирішує, ЩО це; лише знаходить, що
 *      *схоже* на сутність, і віддає моделі список на підтвердження.
 *   3. Дешева дедуплікація — хеш нормалізованого тексту (порівняння з вікном
 *      робить FlowIngest).
 *
 * Клас без стану й без I/O: evaluate() — чиста функція.
 */

const ZERO_WIDTH = /[​-‍﻿]/g;
const VARIATION_SELECTOR = "️";
const EMOJI = new RegExp(
  "(?:\\p{Extended_Pictographic}|[\\u{1F1E6}-\\u{1F1FF}])" + VARIATION_SELECTOR + "?",
  "gu",
);
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»]+$/;

// Кандидати. PROMO_RE та isPromoLike живуть у shared/text.js: те саме
// визначення використовує isShouty(), щоб класичний фільтр і flow не
// розійшлися в оцінці того самого тексту.
const TICKER_RE = /\$[A-Z]{2,10}\b/g;
const DATE_ISO_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DATE_DMY_RE = /\b\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\b/g;
const DEADLINE_RE = /\b(?:until|till|by|before|до)\s+([\p{L}\p{N}][\p{L}\p{N} ,.:/-]{2,24})/giu;
const AMOUNT_RE = /(?:[$€£₴₽]\s?\d[\d\s.,]*|\d[\d\s.,]*\s?%)/g;

const CANDIDATE_CAP = 20; // максимум елементів у кожному списку — тримає JSON малим

export class RegexStage {
  /**
   * @param {object} opts
   * @param {number} opts.minTextLength Поріг skipped_empty (символів після replacements).
   */
  constructor({ minTextLength = 10 } = {}) {
    this.minTextLength = minTextLength;
  }

  /**
   * @param {object} input
   * @param {string} input.text       Plain text ПІСЛЯ text_replacements.
   * @param {Set<string>|null} input.blacklist  Скомпільований blacklist джерела.
   *   MessageFilter кладе сюди слова у нижньому регістрі, якщо
   *   case_sensitive=false, і як є — якщо true.
   * @param {boolean} [input.caseSensitive=false]  Має збігатися з тим, як
   *   зібрано blacklist: інакше haystack і слова в різному регістрі й
   *   blacklist тихо перестає ловити.
   * @param {{max_length: number, min_caps_ratio: number}|null} [input.rejectShouty]
   *   Скомпільований `filters.reject_shouty` джерела, або null — вимкнено.
   * @param {number|null} [input.minLength] Скомпільований `filters.min_length`
   *   джерела, або null — вимкнено.
   * @returns {{
   *   status: 'ok'|'skipped_blacklist'|'skipped_empty'|'skipped_noise'|'skipped_shouty'|'skipped_short',
   *   normalizedText: string,
   *   textHash: string|null,
   *   candidates: object
   * }}
   */
  evaluate({ text, blacklist, caseSensitive = false, rejectShouty = null, minLength = null }) {
    const raw = typeof text === "string" ? text : "";
    const normalizedText = RegexStage.normalize(raw);
    const textHash = normalizedText ? RegexStage.hash(normalizedText) : null;
    const candidates = RegexStage.extractCandidates(raw);

    const result = { normalizedText, textHash, candidates };

    // 1. Порожній / надто короткий (найдешевша перевірка, ранній вихід)
    if (normalizedText.length < this.minTextLength) {
      return { ...result, status: "skipped_empty" };
    }

    // 2. Blacklist джерела (whitelist для flow-джерел вимкнено — див. ARCHITECTURE.md)
    if (blacklist && blacklist.size > 0) {
      const haystack = caseSensitive ? raw : raw.toLowerCase();
      for (const word of blacklist) {
        if (haystack.includes(word)) {
          return { ...result, status: "skipped_blacklist" };
        }
      }
    }

    // 3. Шум: тільки емодзі / тільки посилання / службовий текст.
    //    Знімаємо URL, емодзі, пунктуацію, пробіли — якщо лишилось менше
    //    двох word-символів, це не контент.
    const stripped = raw
      .replace(URL_RE, " ")
      .replace(EMOJI, " ")
      .replace(ZERO_WIDTH, "")
      .replace(/[^\p{L}\p{N}]+/gu, "");
    if (stripped.length < 2) {
      return { ...result, status: "skipped_noise" };
    }

    // 4. Короткий крик — службовий пост капсом. Опційно, на джерело: на
    //    каналі промокодів це правило зарізало б самі коди, тож глобально
    //    його вмикати не можна (isShouty() ще й виключає промо-подібні
    //    токени окремо — конфігурації тут довіряти мало).
    if (rejectShouty && isShouty(raw, rejectShouty)) {
      return { ...result, status: "skipped_shouty" };
    }

    // 5. Надто короткий — однорядковий анонс без змісту. Опційно, на джерело,
    //    з тим самим захистом промокодів, що й у shouty.
    if (minLength && isTooShort(raw, minLength)) {
      return { ...result, status: "skipped_short" };
    }

    return { ...result, status: "ok" };
  }

  // ── Нормалізація та хеш ────────────────────────────────────────────

  static normalize(text) {
    return String(text)
      .replace(ZERO_WIDTH, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  static hash(normalizedText) {
    return crypto.createHash("sha1").update(normalizedText).digest("hex");
  }

  // ── Candidate extraction ──────────────────────────────────────────

  static extractCandidates(text) {
    const raw = String(text);

    const promo_codes = uniqCap((raw.match(PROMO_RE) ?? []).filter(isPromoLike));

    const tickers = uniqCap(raw.match(TICKER_RE) ?? []);

    const urls = uniqCap(
      (raw.match(URL_RE) ?? []).map((u) => u.replace(TRAILING_PUNCT, "")),
    );

    const dates = uniqCap([
      ...(raw.match(DATE_ISO_RE) ?? []),
      ...(raw.match(DATE_DMY_RE) ?? []),
      ...[...raw.matchAll(DEADLINE_RE)].map((m) => m[0].trim()),
    ]);

    const amounts = uniqCap(
      (raw.match(AMOUNT_RE) ?? []).map((a) => a.replace(/\s+/g, " ").trim()),
    );

    return { promo_codes, tickers, urls, dates, amounts };
  }
}

function uniqCap(arr) {
  return [...new Set(arr)].slice(0, CANDIDATE_CAP);
}

export default RegexStage;

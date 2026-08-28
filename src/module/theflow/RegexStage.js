import crypto from "crypto";

/**
 * TheFlow — regex-стадія (перед AI).
 *
 * Детермінована й безкоштовна. Три ролі (docs/theflow/ARCHITECTURE.md):
 *   1. Rejection — пост не доходить до AI (skipped_blacklist / skipped_empty /
 *      skipped_noise). skipped_repost вирішується не тут, а у FlowIngest —
 *      бо потребує запиту до вікна в БД.
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

// Кандидати
const PROMO_RE = /\b[A-Z0-9]{5,20}\b/g;                       // потім фільтр: є цифра І літера
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
   * @param {Set<string>|null} input.blacklist  Скомпільований blacklist джерела
   *                                            (вже в нижньому регістрі).
   * @returns {{
   *   status: 'ok'|'skipped_blacklist'|'skipped_empty'|'skipped_noise',
   *   normalizedText: string,
   *   textHash: string|null,
   *   candidates: object
   * }}
   */
  evaluate({ text, blacklist }) {
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
      const haystack = raw.toLowerCase();
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

    const promo_codes = uniqCap(
      (raw.match(PROMO_RE) ?? []).filter(
        (c) => /[0-9]/.test(c) && /[A-Z]/.test(c),
      ),
    );

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

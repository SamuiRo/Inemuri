/**
 * Чисті текстові евристики, спільні для класичного фільтра і TheFlow.
 *
 * Живуть окремо від shared/utils.js навмисно: той тягне chalk, sharp і
 * gradient-string, а цей модуль має лишатись без залежностей, щоб його могли
 * імпортувати і MessageFilter, і RegexStage (яка за дизайном не має I/O).
 *
 * Одне визначення на обидва шляхи — щоб класичний форвардинг і flow-ingest не
 * розійшлися в оцінці того самого тексту.
 */

// Кандидат на промокод: 5–20 великих літер/цифр як окреме слово.
export const PROMO_RE = /\b[A-Z0-9]{5,20}\b/g;

/**
 * Чи схожий токен на промокод. Дві форми, бо емітенти різні:
 *
 *   1. Є і цифра, і літера — `BONUS50`. Найнадійніша ознака.
 *   2. Суцільні літери довжиною >= 10 — частина ігрових емітентів видає коди
 *      без жодної цифри, і правило (1) їх мовчки пропускало.
 *
 * Поріг 10 — компроміс: короткі капсові слова (`STEAM`, `GIVEAWAY`)
 * відсікаються, довгі англійські (`CONGRATULATIONS`) — ні. Це прийнятно:
 * кандидати — підказка моделі, а не рішення. Хибний кандидат коштує токенів,
 * пропущений код коштує самого коду. Кирилиця під `[A-Z]` не потрапляє.
 */
export function isPromoLike(token) {
  if (/[0-9]/.test(token) && /[A-Z]/.test(token)) return true;
  return /^[A-Z]{10,20}$/.test(token);
}

/** Чи є в тексті хоч один токен, схожий на промокод. */
export function hasPromoLike(text) {
  return (String(text ?? "").match(PROMO_RE) ?? []).some(isPromoLike);
}

/**
 * Частка великих літер серед літер тексту, 0..1.
 *
 * Рахуємо лише по літерах: цифри, емодзі й пунктуація не мають регістру і
 * розмили б показник. Працює і для кирилиці.
 */
export function capsRatio(text) {
  const letters = String(text ?? "").match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  let upper = 0;
  for (const ch of letters) {
    // Символ має регістр і вже у верхньому — інакше (напр. 'ї' без пари) не рахуємо.
    if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upper += 1;
  }
  return upper / letters.length;
}

/**
 * Чи це короткий крик — службовий пост капсом.
 *
 * Ловить ритуальні пости на кшталт «ВСЕМ СПАСИБО. СПОКОЙНОЙ НОЧИ.» або
 * щоденних зворотних відліків, у яких немає сталого підрядка для blacklist,
 * бо текст змінюється щодня.
 *
 * **Промокоди виключені явно.** Голий пост із кодом — `PS3QWS3ACGDK` — це
 * капс 1.0 і 12 символів, тобто рівно та форма, яку правило зарізало б. Це
 * найдорожча можлива хибна спрацьовування: канал промокодів втратив би сам
 * код. Правило вмикається на джерело, але покладатись лише на конфігурацію
 * тут не варто.
 *
 * @param {string} text
 * @param {{max_length?: number, min_caps_ratio?: number}} opts
 * @returns {boolean}
 */
export function isShouty(text, opts = {}) {
  const maxLength = Number(opts.max_length);
  const minRatio = Number(opts.min_caps_ratio);
  if (!Number.isFinite(maxLength) || maxLength <= 0) return false;
  if (!Number.isFinite(minRatio) || minRatio <= 0 || minRatio > 1) return false;

  const s = String(text ?? "");
  if (s.length > maxLength) return false;
  if (capsRatio(s) < minRatio) return false;
  return !hasPromoLike(s);
}

/**
 * Нормалізує конфіг `filters.reject_shouty` у робочі опції або null (вимкнено).
 * Приймає і `true` — тоді дефолти, зняті з реальних постів:
 * пороги 120 символів і 0.8 капсу розділяють ритуальні пости від корисних
 * із великим запасом (1.00 проти максимум 0.21 на зміряній вибірці).
 */
export const SHOUTY_DEFAULTS = { max_length: 120, min_caps_ratio: 0.8 };

export function compileShouty(raw) {
  if (raw === true) return { ...SHOUTY_DEFAULTS };
  if (!raw || typeof raw !== "object") return null;
  const opts = {
    max_length: Number(raw.max_length ?? SHOUTY_DEFAULTS.max_length),
    min_caps_ratio: Number(raw.min_caps_ratio ?? SHOUTY_DEFAULTS.min_caps_ratio),
  };
  if (!Number.isFinite(opts.max_length) || opts.max_length <= 0) return null;
  if (!Number.isFinite(opts.min_caps_ratio) || opts.min_caps_ratio <= 0 || opts.min_caps_ratio > 1) {
    return null;
  }
  return opts;
}

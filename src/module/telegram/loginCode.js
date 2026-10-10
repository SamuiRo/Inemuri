/**
 * Куди Telegram відправив код входу (auth.sentCode) — для `cli telegram login`.
 *
 * Чиста функція: на вході відповідь auth.SendCode / auth.ResendCode (або
 * будь-який об'єкт з тими ж className), на виході — що сказати оператору.
 * Без неї gramjs знає лише «у застосунок чи ні» і питає код, навіть коли
 * Telegram його не надсилав (SetUpEmailRequired, FirebaseSms) — звідси
 * «код не приходить».
 */

/** Куди може прийти код: className → опис для оператора. */
const SENT = {
  "auth.SentCodeTypeApp": (t) => ({ where: "app", expectCode: true,
    hint: `in the Telegram app on another device where you are logged in — a message from "Telegram", not an SMS (${t.length ?? "?"} digits)` }),
  "auth.SentCodeTypeSms": (t) => ({ where: "sms", expectCode: true,
    hint: `by SMS (${t.length ?? "?"} digits)` }),
  "auth.SentCodeTypeSmsWord": (t) => ({ where: "sms-word", expectCode: true,
    hint: `by SMS as a word${t.beginning ? ` starting with "${t.beginning}"` : ""} — type the word` }),
  "auth.SentCodeTypeSmsPhrase": (t) => ({ where: "sms-phrase", expectCode: true,
    hint: `by SMS as a phrase${t.beginning ? ` starting with "${t.beginning}"` : ""} — type the phrase` }),
  "auth.SentCodeTypeCall": (t) => ({ where: "call", expectCode: true,
    hint: `by a phone call that dictates it (${t.length ?? "?"} digits)` }),
  "auth.SentCodeTypeFlashCall": () => ({ where: "flash-call", expectCode: true,
    hint: "by a call you should not answer — type the full calling number" }),
  "auth.SentCodeTypeMissedCall": (t) => ({ where: "missed-call", expectCode: true,
    hint: `by a missed call from a number starting with ${t.prefix ?? "?"} — type its last ${t.length ?? "?"} digits` }),
  "auth.SentCodeTypeEmailCode": (t) => ({ where: "email", expectCode: true,
    hint: `to the login email ${t.emailPattern ?? ""} (${t.length ?? "?"} digits)` }),
  "auth.SentCodeTypeFragmentSms": (t) => ({ where: "fragment", expectCode: true,
    hint: `on fragment.com, for an anonymous number${t.url ? ` (${t.url})` : ""}` }),
  // Нижче — коду не буде. Firebase — лише для офіційних застосунків з
  // Google Play / App Store; третій клієнт його не отримає.
  "auth.SentCodeTypeFirebaseSms": () => ({ where: "firebase", expectCode: false,
    hint: "through Firebase, which only official Telegram apps can receive — no code will arrive here" }),
  "auth.SentCodeTypeSetUpEmailRequired": () => ({ where: "email-setup", expectCode: false,
    hint: "nowhere: Telegram wants a login email set up for this account first — no code was sent" }),
};

/** Чим можна повторити (auth.CodeType*). */
const NEXT = {
  "auth.CodeTypeSms": "SMS",
  "auth.CodeTypeCall": "a phone call",
  "auth.CodeTypeFlashCall": "a flash call",
  "auth.CodeTypeMissedCall": "a missed call",
  "auth.CodeTypeFragmentSms": "fragment.com",
};

/**
 * @param {{ className?: string, type?: object, nextType?: object, timeout?: number }} sentCode
 * @returns {{ where: string, expectCode: boolean, hint: string, next: string|null, timeout: number|null, success: boolean }}
 */
export function describeSentCode(sentCode) {
  if (sentCode?.className === "auth.SentCodeSuccess") {
    return { where: "none", expectCode: false, hint: "Telegram logged in without a code", next: null, timeout: null, success: true };
  }
  const type = sentCode?.type ?? {};
  const known = SENT[type.className];
  const base = known
    ? known(type)
    : { where: "unknown", expectCode: true, hint: `an unknown way (${type.className ?? "no type"}) — the library may be older than Telegram's protocol` };
  return {
    ...base,
    next: NEXT[sentCode?.nextType?.className] ?? null,
    timeout: Number.isFinite(sentCode?.timeout) ? sentCode.timeout : null,
    success: false,
  };
}

/** Що оператор ввів замість коду: повтор, QR чи сам код. */
export function readCodeAnswer(answer) {
  const a = String(answer ?? "").trim();
  if (/^(resend|r)$/i.test(a)) return { action: "resend" };
  if (/^(qr|q)$/i.test(a)) return { action: "qr" };
  if (a === "") return { action: "empty" };
  // "12 345" / "12-345" → цифри разом; слово чи фраза з SMS — як є.
  return { action: "code", code: /^[\d\s-]+$/.test(a) ? a.replace(/[\s-]/g, "") : a };
}

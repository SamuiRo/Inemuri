import test from "node:test";
import assert from "node:assert/strict";

import { capsRatio, isShouty, compileShouty, SHOUTY_DEFAULTS } from "../src/shared/text.js";
import messageFilter from "../src/module/filters/MessageFilter.js";
import RegexStage from "../src/module/theflow/RegexStage.js";
import { POST_STATUSES } from "../src/module/teapot/models/Post.js";

const D = SHOUTY_DEFAULTS;

// Реальні форми з каналу: щоденний ритуал, для якого немає сталого підрядка.
const RITUAL_CALENDAR = "ВСЕМ ПРИГОТОВИТЬСЯ К ПЕРЕВОРАЧИВАНИЮ КАЛЕНДАРЯ!\nНАЧИНАЕМ ЧЕРЕЗ 5 МИНУТ!";
const RITUAL_NIGHT = "ВСЕМ СПАСИБО.\nСПОКОЙНОЙ НОЧИ.";
const RITUAL_DATE = "2 - С Е Н Т Я Б Р Я\n2 3 : 5 5";

// Корисне з того самого каналу: починається капсом, але пост довгий.
const USEFUL_LONG = "524 ДНЯ БЕЗ НОВОГО КЕЙСА В CS2. 🪦\n\n" +
  "Последний классический кейс — Fever Case — вышел еще 31 марта 2025 года. " +
  "С тех пор Valve не перестала добавлять косметику: были Terminal, Armory и " +
  "новые коллекции, но привычного нового weapon case так и не появилось.";

// ── capsRatio ─────────────────────────────────────────────────────────

test("capsRatio — counts letters only, works for Cyrillic", () => {
  assert.equal(capsRatio("ВСЕМ СПАСИБО"), 1);
  assert.equal(capsRatio("всем спасибо"), 0);
  assert.equal(capsRatio(""), 0);
  assert.equal(capsRatio("2 3 : 5 5"), 0, "без літер — 0, не NaN");
  assert.equal(capsRatio("🔥🔥🔥"), 0, "емодзі не мають регістру");
});

test("capsRatio — the measured margin between ritual and useful posts", () => {
  // Саме цей запас робить поріг 0.8 безпечним: 1.00 проти 0.21 максимум.
  assert.equal(capsRatio(RITUAL_CALENDAR), 1);
  assert.equal(capsRatio(RITUAL_NIGHT), 1);
  assert.ok(capsRatio(USEFUL_LONG) < 0.3, `корисний пост: ${capsRatio(USEFUL_LONG)}`);
});

// ── isShouty ──────────────────────────────────────────────────────────

test("isShouty — catches the ritual posts", () => {
  for (const [name, text] of [["календар", RITUAL_CALENDAR], ["добраніч", RITUAL_NIGHT],
                              ["дата", RITUAL_DATE]]) {
    assert.equal(isShouty(text, D), true, name);
  }
});

test("isShouty — a long post is never shouty, however it starts", () => {
  assert.equal(isShouty(USEFUL_LONG, D), false);
});

test("isShouty — ordinary short posts pass", () => {
  for (const text of [
    "Признавайтесь, знакомая ситуация? 🙂",
    "🎮 Время никого не щадит (особенно ксеров)",
    "Дніпро, Київ ви як ?",
  ]) {
    assert.equal(isShouty(text, D), false, text);
  }
});

test("isShouty — NEVER eats a bare promo code", () => {
  // Найдорожча можлива хибна спрацьовування: капс 1.0, 12 символів — рівно
  // та форма, яку правило зарізало б. Канал промокодів втратив би сам код.
  for (const code of ["PS3QWS3ACGDK", "MTKQEAJAUZWB", "8SMSVJWJM7ZT"]) {
    assert.equal(capsRatio(code), 1, "форма справді підпадає під правило");
    assert.equal(isShouty(code, D), false, `код ${code} має вижити`);
  }
  assert.equal(isShouty("ВСІ КОДИ: PS3QWS3ACGDK", D), false, "код у капсовому пості теж");
});

test("isShouty — disabled unless both thresholds are sane", () => {
  for (const opts of [{}, { max_length: 0 }, { min_caps_ratio: 0 },
                      { max_length: 120, min_caps_ratio: 1.5 },
                      { max_length: -1, min_caps_ratio: 0.8 }]) {
    assert.equal(isShouty(RITUAL_NIGHT, opts), false, JSON.stringify(opts));
  }
});

// ── compileShouty ─────────────────────────────────────────────────────

test("compileShouty — off by default, `true` means defaults", () => {
  assert.equal(compileShouty(undefined), null);
  assert.equal(compileShouty(null), null);
  assert.equal(compileShouty(false), null);
  assert.deepEqual(compileShouty(true), D);
});

test("compileShouty — partial config fills in the defaults", () => {
  assert.deepEqual(compileShouty({ max_length: 60 }),
    { max_length: 60, min_caps_ratio: D.min_caps_ratio });
  assert.deepEqual(compileShouty({ min_caps_ratio: 0.9 }),
    { max_length: D.max_length, min_caps_ratio: 0.9 });
});

test("compileShouty — nonsense disables the rule rather than guessing", () => {
  for (const raw of [{ max_length: "abc" }, { min_caps_ratio: 2 }, { max_length: 0 }]) {
    assert.equal(compileShouty(raw), null, JSON.stringify(raw));
  }
});

// ── класичний шлях ────────────────────────────────────────────────────

function classicFilter(rejectShouty) {
  return messageFilter.compileFilter(`shouty-${Math.random()}`, {
    enabled: true, keywords: [], blacklist: [], case_sensitive: false,
    reject_shouty: rejectShouty,
  });
}

test("MessageFilter — off by default, so existing sources are untouched", () => {
  const f = classicFilter(undefined);
  assert.equal(f.rejectShouty, null);
  assert.equal(messageFilter.checkMessageFast(null, f, RITUAL_NIGHT), true);
});

test("MessageFilter — enabled, the ritual is filtered and the useful post is not", () => {
  const f = classicFilter(true);
  assert.equal(messageFilter.checkMessageFast(null, f, RITUAL_NIGHT), false);
  assert.equal(messageFilter.checkMessageFast(null, f, RITUAL_CALENDAR), false);
  assert.equal(messageFilter.checkMessageFast(null, f, USEFUL_LONG), true);
  assert.equal(messageFilter.checkMessageFast(null, f, "PS3QWS3ACGDK"), true);
});

test("MessageFilter — blacklist still wins first", () => {
  const f = messageFilter.compileFilter("shouty-bl", {
    enabled: true, keywords: [], blacklist: ["спасибо"], case_sensitive: false,
    reject_shouty: true,
  });
  assert.equal(messageFilter.checkMessageFast(null, f, RITUAL_NIGHT), false);
});

// ── шлях TheFlow ──────────────────────────────────────────────────────

const stage = new RegexStage({ minTextLength: 10 });

test("RegexStage — skipped_shouty is a known post status", () => {
  assert.ok(POST_STATUSES.includes("skipped_shouty"));
});

test("RegexStage — off by default", () => {
  assert.equal(stage.evaluate({ text: RITUAL_NIGHT, blacklist: null }).status, "ok");
});

test("RegexStage — enabled, the ritual gets skipped_shouty", () => {
  for (const text of [RITUAL_NIGHT, RITUAL_CALENDAR, RITUAL_DATE]) {
    const r = stage.evaluate({ text, blacklist: null, rejectShouty: { ...D } });
    assert.equal(r.status, "skipped_shouty", text.slice(0, 30));
  }
});

test("RegexStage — a promo-code post survives even with the rule on", () => {
  const r = stage.evaluate({
    text: "ВСІ КОДИ СТРІМУ: PS3QWS3ACGDK",
    blacklist: null,
    rejectShouty: { ...D },
  });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.candidates.promo_codes, ["PS3QWS3ACGDK"]);
});

test("RegexStage — the earlier rejections still take precedence", () => {
  // Порядок важливий: shouty — найдорожча перевірка і стоїть останньою.
  assert.equal(
    stage.evaluate({ text: "КОРОТКО", blacklist: null, rejectShouty: { ...D } }).status,
    "skipped_empty",
    "надто короткий — вирішується першим",
  );
  assert.equal(
    stage.evaluate({
      text: RITUAL_NIGHT, blacklist: new Set(["спасибо"]), rejectShouty: { ...D },
    }).status,
    "skipped_blacklist",
  );
});

test("RegexStage — candidates and hash are produced even when skipped", () => {
  // Пост зберігається з причиною, а не викидається — статистика й розбір
  // мають бути можливі.
  const r = stage.evaluate({ text: RITUAL_CALENDAR, blacklist: null, rejectShouty: { ...D } });
  assert.equal(r.status, "skipped_shouty");
  assert.ok(r.textHash, "хеш лишається");
  assert.ok(r.candidates, "кандидати лишаються");
});

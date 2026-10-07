import test from "node:test";
import assert from "node:assert/strict";

import { isTooShort, compileMinLength } from "../src/shared/text.js";
import messageFilter from "../src/module/filters/MessageFilter.js";
import RegexStage from "../src/module/theflow/RegexStage.js";
import { POST_STATUSES } from "../src/module/teapot/vocabulary.js";

// Реальні форми з ігрового каналу: однорядковий анонс без змісту і
// звичайна новина з того самого каналу.
const ONE_LINER = "Sifu вийде на iOS та Android 12 жовтня";
const NEWS = "Пізніше цього місяця METRO 2033 Redux та METRO: Last Light Redux отримають " +
  "оновлення для нового покоління на консолях та ПК. Оновлення вийде 22 жовтня.";

test("compileMinLength — positive integer or null", () => {
  assert.equal(compileMinLength(60), 60);
  assert.equal(compileMinLength("60"), 60);
  assert.equal(compileMinLength(59.6), 60);
  for (const off of [null, undefined, "", 0, -5, "abc", Number.NaN]) {
    assert.equal(compileMinLength(off), null, String(off));
  }
});

test("isTooShort — a one-liner is short, a news post is not, off means never", () => {
  assert.equal(isTooShort(ONE_LINER, 60), true);
  assert.equal(isTooShort(NEWS, 60), false);
  assert.equal(isTooShort(ONE_LINER, null), false);
  assert.equal(isTooShort(ONE_LINER, 0), false);
});

test("isTooShort — links do not count toward the length", () => {
  const linkOnly = "Огляд: https://www.youtube.com/watch?v=grltClIM220&feature=shared";
  assert.equal(isTooShort(linkOnly, 30), true);
});

test("isTooShort — a short post with a promo code always survives", () => {
  // «Перший промокод MECHANISMCITY» — 29 символів і саме те, заради чого канал читають.
  assert.equal(isTooShort("Перший промокод\nMECHANISMCITY", 60), false);
  assert.equal(isTooShort("Новий промокод! RT4BPNA8FBS3", 60), false);
});

test("RegexStage — skipped_short is a known status and runs after the cheaper checks", () => {
  assert.ok(POST_STATUSES.includes("skipped_short"));
  const stage = new RegexStage({ minTextLength: 10 });
  assert.equal(stage.evaluate({ text: ONE_LINER, blacklist: null, minLength: 60 }).status, "skipped_short");
  assert.equal(stage.evaluate({ text: NEWS, blacklist: null, minLength: 60 }).status, "ok");
  assert.equal(stage.evaluate({ text: ONE_LINER, blacklist: null }).status, "ok", "без порогу — як раніше");
  // blacklist вирішує раніше, ніж довжина
  assert.equal(
    stage.evaluate({ text: ONE_LINER, blacklist: new Set(["sifu"]), minLength: 60 }).status,
    "skipped_blacklist",
  );
  // хеш і кандидати є і у відсіяного — як у решти skipped_*
  const r = stage.evaluate({ text: ONE_LINER, blacklist: null, minLength: 60 });
  assert.ok(r.textHash);
});

test("MessageFilter — classic path applies filters.min_length too", () => {
  const id = "min-length-test";
  messageFilter.clearCache(id);
  const filter = messageFilter.compileFilter(id, { enabled: true, keywords: [], blacklist: [], min_length: 60 });
  assert.equal(filter.minLength, 60);
  assert.equal(messageFilter.checkMessageFast(null, filter, ONE_LINER), false);
  assert.equal(messageFilter.checkMessageFast(null, filter, NEWS), true);
  const off = messageFilter.compileFilter(id, { enabled: true, keywords: [], blacklist: [] });
  assert.equal(off.minLength, null);
  assert.equal(messageFilter.checkMessageFast(null, off, ONE_LINER), true);
  messageFilter.clearCache(id);
});

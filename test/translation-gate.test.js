import test from "node:test";
import assert from "node:assert/strict";

import { needsTranslation, translationVerdict, waitingState } from "../src/module/theflow/delivery/translationGate.js";

const HOUR = 3_600_000;
const now = Date.parse("2026-10-10T12:00:00Z");

test("needsTranslation: only a non-Ukrainian post with text", () => {
  assert.equal(needsTranslation({ lang: "en", raw_text: "News" }), true);
  assert.equal(needsTranslation({ lang: "uk", raw_text: "Новина" }), false);
  assert.equal(needsTranslation({ lang: null, raw_text: "?" }), false);
  assert.equal(needsTranslation({ lang: "en", raw_text: "  " }), false, "лише картинка — нема що перекладати");
});

test("translationVerdict: go when translated or not needed, wait, then give up after waitMs", () => {
  const en = { lang: "en", raw_text: "News", analysis: {} };
  assert.equal(translationVerdict({ post: { ...en, analysis: { text_uk: "Новина" } }, now, waitMs: 6 * HOUR }), "go");
  assert.equal(translationVerdict({ post: { lang: "uk", raw_text: "x" }, now, waitMs: 6 * HOUR }), "go");
  assert.equal(translationVerdict({ post: en, now, waitMs: 6 * HOUR }), "wait", "перша невдача — чекати");
  assert.equal(translationVerdict({ post: en, waitingSince: new Date(now - 5 * HOUR).toISOString(), now, waitMs: 6 * HOUR }), "wait");
  assert.equal(translationVerdict({ post: en, waitingSince: new Date(now - 6 * HOUR).toISOString(), now, waitMs: 6 * HOUR }), "give_up");
});

test("waitingState: keeps the first wait, moves retry_at, counts tries; a send failure is not a wait", () => {
  const first = waitingState(null, { now, retryMs: 10 * 60_000 });
  assert.deepEqual(first, { waiting: "translation", since: "2026-10-10T12:00:00.000Z", retry_at: "2026-10-10T12:10:00.000Z", tries: 1 });
  const second = waitingState(first, { now: now + 15 * 60_000, retryMs: 10 * 60_000 });
  assert.equal(second.since, first.since);
  assert.equal(second.tries, 2);
  assert.equal(second.retry_at, "2026-10-10T12:25:00.000Z");
  assert.equal(waitingState({ failed: true, attempts: 1 }, { now, retryMs: 1 }).tries, 1);
});

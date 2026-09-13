import test from "node:test";
import assert from "node:assert/strict";

import { LLM_PROVIDERS, quotaTimeZone } from "../src/config/app.config.js";

// Моделі, які Google уже вимкнув (ai.google.dev/gemini-api/docs/deprecations).
// Дефолт, що вказує на вимкнену модель, не падає — він тихо не працює.
const SHUT_DOWN = ["text-embedding-004", "embedding-001", "gemini-2.0-flash", "gemini-2.0-flash-lite"];

test("Gemini defaults do not point at a shut-down model", () => {
  const g = LLM_PROVIDERS.gemini;
  for (const [field, model] of [["completeModel", g.completeModel], ["embedModel", g.embedModel],
                                ["visionModel", g.visionModel]]) {
    if (process.env[`GEMINI_${field.replace("Model", "").toUpperCase()}_MODEL`]) continue; // оператор задав свою
    assert.equal(SHUT_DOWN.includes(model), false, `${field} = ${model} is shut down`);
  }
});

test("Gemini embedding dimension is pinned, not inherited", () => {
  // ROADMAP 13.2: дефолт моделі (3072) може змінитись під ногами.
  assert.ok(Number.isInteger(LLM_PROVIDERS.gemini.embedDim) && LLM_PROVIDERS.gemini.embedDim > 0);
});

test("Gemini quota resets on Pacific time by default", () => {
  if (process.env.GEMINI_QUOTA_TZ) return;
  assert.equal(LLM_PROVIDERS.gemini.quotaTimeZone, "America/Los_Angeles");
});

test("OpenRouter has no embedding model by default", () => {
  // Свідомо: вектор від fallback-моделі лягає в простір, у якому дедуплікація
  // не шукає. Ембеддинги — лише від одного провайдера.
  if (process.env.OPENROUTER_EMBED_MODEL) return;
  assert.equal(LLM_PROVIDERS.openrouter.embedModel, null);
});

// ── quotaTimeZone ─────────────────────────────────────────────────────

test("quotaTimeZone — a valid IANA zone passes through", () => {
  const sink = [];
  assert.equal(quotaTimeZone("X", "Europe/Kyiv", "UTC", sink), "Europe/Kyiv");
  assert.deepEqual(sink, []);
});

test("quotaTimeZone — unset uses the fallback silently", () => {
  const sink = [];
  assert.equal(quotaTimeZone("X", undefined, "America/Los_Angeles", sink), "America/Los_Angeles");
  assert.equal(quotaTimeZone("X", "  ", "America/Los_Angeles", sink), "America/Los_Angeles");
  assert.deepEqual(sink, []);
});

test("quotaTimeZone — an invalid zone warns and falls back to UTC", () => {
  const sink = [];
  assert.equal(quotaTimeZone("GEMINI_QUOTA_TZ", "Pacific Time", "America/Los_Angeles", sink), "UTC");
  assert.equal(sink.length, 1);
  assert.match(sink[0], /GEMINI_QUOTA_TZ/);
});

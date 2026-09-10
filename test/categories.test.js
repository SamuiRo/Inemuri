import test from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES } from "../src/config/app.config.js";
import { validateStructural } from "../src/services/ai/schemas.js";

// The shipped categories.json must stay a well-formed closed taxonomy — the
// enrich schema and the resolve stage both read it at runtime.

test("categories.json — version, closed axes, dedup windows on signals", () => {
  assert.equal(CATEGORIES.version, 1);

  const topics = Object.keys(CATEGORIES.topics);
  assert.deepEqual(topics.sort(), ["airdrop", "crypto", "other", "steam", "tools"].sort());
  for (const [name, t] of Object.entries(CATEGORIES.topics)) {
    assert.equal(typeof t.description, "string", `${name}.description`);
  }

  const signals = Object.keys(CATEGORIES.signals);
  assert.equal(signals.length, 11);
  assert.ok(signals.includes("security"));
  assert.ok(signals.includes("giveaway_result"));
  assert.ok(signals.includes("stream"));
  for (const [name, s] of Object.entries(CATEGORIES.signals)) {
    assert.equal(typeof s.description, "string", `${name}.description`);
    assert.equal(typeof s.dedup_window_hours, "number", `${name}.dedup_window_hours`);
    assert.ok(s.dedup_window_hours > 0);
  }

  // security shares the short window with outage, not the analysis window
  assert.equal(CATEGORIES.signals.security.dedup_window_hours, 6);
  assert.equal(CATEGORIES.signals.outage.dedup_window_hours, 6);
  assert.equal(CATEGORIES.signals.promo_code.dedup_window_hours, 24);
});

test("categories.json — shadow-mode routing: empty rules, unsorted only", () => {
  assert.deepEqual(CATEGORIES.routing, []);
  assert.ok(CATEGORIES.unsorted_destinations.telegram?.length >= 1);
});

test("categories.json — usable as the validator's closed enum source", () => {
  const good = {
    text_en: "x", lang: "en", topic: "crypto", signal_type: "security", confidence: 0.5,
  };
  assert.equal(validateStructural(good, CATEGORIES).ok, true);
  assert.equal(validateStructural({ ...good, topic: "market" }, CATEGORIES).ok, false);
});

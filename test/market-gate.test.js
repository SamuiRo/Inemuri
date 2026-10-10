import test from "node:test";
import assert from "node:assert/strict";

import { corroboration, marketVerdict } from "../src/module/theflow/delivery/marketGate.js";

const HOUR = 3_600_000;
// Вектори в базі одиничні (DedupCore.cosine — скалярний добуток), тож і тут.
const v = (...xs) => { const n = Math.hypot(...xs); return Float32Array.from(xs.map((x) => x / n)); };
const me = { id: 1, source_id: 10, vector: v(1, 0, 0), t: 0 };
const opts = { minSimilarity: 0.8, windowMs: 24 * HOUR };

test("corroboration: another outlet, close enough, in the window; same outlet and other models do not count", () => {
  const others = [
    { id: 2, source_id: 20, vector: v(0.9, 0.3, 0), t: HOUR, delivered: false },        // ~0.95
    { id: 3, source_id: 10, vector: v(1, 0, 0), t: HOUR, delivered: true },             // те саме видання
    { id: 4, source_id: 30, vector: v(0, 1, 0), t: HOUR, delivered: false },            // інша новина
    { id: 5, source_id: 40, vector: v(1, 0, 0), t: 30 * HOUR, delivered: false },       // поза вікном
    { id: 6, source_id: 50, vector: v(1, 0, 0, 0), t: HOUR, delivered: false },         // інша модель
  ];
  const c = corroboration(me, others, opts);
  assert.equal(c.sources, 1);
  assert.equal(c.deliveredTwin, null);
  assert.ok(c.best > 0.9);
  assert.deepEqual(corroboration({ ...me, vector: null }, others, opts), { sources: 0, deliveredTwin: null, best: 0 });
});

test("corroboration: a delivered twin from another outlet is reported", () => {
  const c = corroboration(me, [{ id: 7, source_id: 20, vector: v(0.95, 0.2, 0), t: HOUR, delivered: true }], opts);
  assert.equal(c.deliveredTwin, 7);
});

test("marketVerdict: non-market goes; twin stops; corroborated goes until the cap; a single waits, then fits the single cap", () => {
  const base = { holdMs: 3 * HOUR, cap: 4, singleCap: 2, sentInWindow: 0, singlesInWindow: 0, ageMs: 0 };
  const none = { sources: 0, deliveredTwin: null };
  const two = { sources: 1, deliveredTwin: null };
  assert.deepEqual(marketVerdict({ ...base, isMarket: false, corroborated: none }), { verdict: "go", kind: null });
  assert.equal(marketVerdict({ ...base, isMarket: true, corroborated: { sources: 1, deliveredTwin: 9 } }).verdict, "twin");
  assert.deepEqual(marketVerdict({ ...base, isMarket: true, corroborated: two }), { verdict: "go", kind: "corroborated" });
  assert.equal(marketVerdict({ ...base, isMarket: true, corroborated: two, sentInWindow: 4 }).verdict, "cap");
  assert.equal(marketVerdict({ ...base, isMarket: true, corroborated: none, ageMs: HOUR }).verdict, "hold");
  assert.deepEqual(marketVerdict({ ...base, isMarket: true, corroborated: none, ageMs: 3 * HOUR }), { verdict: "go", kind: "single" });
  assert.equal(marketVerdict({ ...base, isMarket: true, corroborated: none, ageMs: 4 * HOUR, singlesInWindow: 2 }).verdict, "cap");
  assert.equal(marketVerdict({ ...base, isMarket: true, corroborated: none, ageMs: 4 * HOUR, sentInWindow: 4 }).verdict, "cap");
});

test("corroboration: the same outlet's delivered repeat is a twin, not a corroboration; a looser same-outlet match is neither", () => {
  const repeat = { id: 8, source_id: 10, vector: v(0.98, 0.15, 0), t: HOUR, delivered: true };   // ~0.99
  const series = { id: 9, source_id: 10, vector: v(0.8, 0.6, 0), t: HOUR, delivered: true };     // 0.80
  assert.deepEqual(corroboration(me, [repeat], { ...opts, sameSourceMin: 0.85 }).deliveredTwin, 8);
  assert.equal(corroboration(me, [repeat], { ...opts, sameSourceMin: 0.85 }).sources, 0);
  assert.equal(corroboration(me, [series], { ...opts, sameSourceMin: 0.85 }).deliveredTwin, null);
  assert.equal(corroboration(me, [repeat], opts).deliveredTwin, null, "без sameSourceMin те саме видання не рахується");
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichResponseSchema,
  validateStructural,
  validateVerbatim,
  validateEnrichResponse,
} from "../src/services/ai/schemas.js";

const taxonomy = {
  topics: { steam: {}, airdrop: {}, crypto: {}, tools: {}, other: {} },
  signals: { promo_code: {}, freebie: {}, security: {}, launch: {} },
};

function goodResponse(over = {}) {
  return {
    text_en: "Free promo code SAVE20 for the new pass, expires Friday",
    lang: "en",
    summary_uk: null,
    topic: "steam",
    signal_type: "promo_code",
    confidence: 0.9,
    entities: { project: "SomeGame", tickers: [] },
    extracted: { promo_codes: [{ code: "SAVE20", reward: "a pass", expires_at: null }], event: null },
    why_interesting: "limited code",
    is_ad: false,
    ...over,
  };
}

test("enrichResponseSchema — enums come from the taxonomy", () => {
  const s = enrichResponseSchema(taxonomy);
  assert.deepEqual(s.properties.topic.enum, ["steam", "airdrop", "crypto", "tools", "other"]);
  assert.deepEqual(s.properties.signal_type.enum, ["promo_code", "freebie", "security", "launch"]);
  assert.equal(s.properties.text_en.type, "string");
  assert.ok(s.required.includes("text_en"));
});

test("validateStructural — a good response passes", () => {
  assert.deepEqual(validateStructural(goodResponse(), taxonomy), { ok: true, errors: [] });
});

test("validateStructural — non-object", () => {
  assert.equal(validateStructural(null, taxonomy).ok, false);
  assert.equal(validateStructural("x", taxonomy).ok, false);
  assert.equal(validateStructural([], taxonomy).ok, false);
});

test("validateStructural — topic/signal outside the closed enum fail", () => {
  const r1 = validateStructural(goodResponse({ topic: "gaming" }), taxonomy);
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join(" "), /topic/);

  const r2 = validateStructural(goodResponse({ signal_type: "giveaway" }), taxonomy);
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join(" "), /signal_type/);
});

test("validateStructural — confidence must be a number in [0,1]", () => {
  assert.equal(validateStructural(goodResponse({ confidence: 1.5 }), taxonomy).ok, false);
  assert.equal(validateStructural(goodResponse({ confidence: "high" }), taxonomy).ok, false);
  assert.equal(validateStructural(goodResponse({ confidence: -0.1 }), taxonomy).ok, false);
  assert.equal(validateStructural(goodResponse({ confidence: 0 }), taxonomy).ok, true);
});

test("validateStructural — missing/empty text_en, bad lang", () => {
  assert.equal(validateStructural(goodResponse({ text_en: "" }), taxonomy).ok, false);
  assert.equal(validateStructural(goodResponse({ text_en: undefined }), taxonomy).ok, false);
  assert.equal(validateStructural(goodResponse({ lang: "english" }), taxonomy).ok, false);
  assert.equal(validateStructural(goodResponse({ lang: "zh-CN" }), taxonomy).ok, true);
});

test("validateStructural — malformed nested shapes", () => {
  assert.equal(validateStructural(goodResponse({ entities: { tickers: [1, 2] } }), taxonomy).ok, false);
  assert.equal(
    validateStructural(goodResponse({ extracted: { promo_codes: [{ reward: "x" }] } }), taxonomy).ok,
    false,
  );
  assert.equal(validateStructural(goodResponse({ is_ad: "yes" }), taxonomy).ok, false);
});

test("validateVerbatim — drops codes and tickers not present in raw_text", () => {
  const resp = goodResponse({
    entities: { project: "SomeGame", tickers: ["$SOL", "$FAKE"] },
    extracted: {
      promo_codes: [{ code: "SAVE20" }, { code: "HALLUCINATED99" }],
      event: null,
    },
  });
  const raw = "Use code save20 and check $sol today"; // lowercased in source
  const { value, discarded } = validateVerbatim(resp, raw);

  assert.deepEqual(value.entities.tickers, ["$SOL"]);
  assert.deepEqual(value.extracted.promo_codes.map((c) => c.code), ["SAVE20"]);
  assert.equal(discarded.length, 2);
  assert.ok(discarded.some((d) => d.value === "$FAKE"));
  assert.ok(discarded.some((d) => d.value === "HALLUCINATED99"));
});

test("validateVerbatim — does not touch entities.project", () => {
  const resp = goodResponse({ entities: { project: "Transliterated Name", tickers: [] } });
  const { value } = validateVerbatim(resp, "완전히 다른 언어의 원문");
  assert.equal(value.entities.project, "Transliterated Name");
});

test("validateVerbatim — leaves the caller's object untouched", () => {
  const resp = goodResponse({ extracted: { promo_codes: [{ code: "NOPE" }], event: null } });
  validateVerbatim(resp, "no code here");
  assert.equal(resp.extracted.promo_codes.length, 1); // original unchanged
});

test("validateEnrichResponse — structural failure short-circuits", () => {
  const r = validateEnrichResponse(goodResponse({ topic: "bogus" }), {
    taxonomy,
    rawText: "whatever",
  });
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

test("validateEnrichResponse — passes structural, returns cleaned value", () => {
  const resp = goodResponse({
    extracted: { promo_codes: [{ code: "SAVE20" }, { code: "GHOST" }], event: null },
  });
  const r = validateEnrichResponse(resp, { taxonomy, rawText: "code SAVE20 only" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.extracted.promo_codes.map((c) => c.code), ["SAVE20"]);
  assert.equal(r.discarded.length, 1);
});

// ── провенанс OCR (VISION.md «Entities from images cannot be verified») ──


const verdictWith = (codes, tickers = []) => ({
  entities: { project: null, tickers },
  extracted: { promo_codes: codes.map((code) => ({ code })), event: null },
});

test("provenance — a code found in the post text is verified", () => {
  const { value, unverified } = validateVerbatim(verdictWith(["SAVE20"]), "Use SAVE20 today", "");
  assert.deepEqual(value.extracted.promo_codes, [{ code: "SAVE20", source: "text", verified: true }]);
  assert.deepEqual(unverified, []);
});

test("provenance — a code found ONLY in the transcription is kept, but unverified", () => {
  // Без провенансу цей код або викидався б (звірка лише з raw_text), або
  // вважався б перевіреним (якби text_ocr просто додали до перевірки).
  const { value, discarded, unverified } = validateVerbatim(
    verdictWith(["HY45OLK8QRE2"]), "see the screenshot", "Promo: HY45OLK8QRE2",
  );
  assert.deepEqual(value.extracted.promo_codes, [{ code: "HY45OLK8QRE2", source: "ocr", verified: false }]);
  assert.deepEqual(discarded, []);
  assert.deepEqual(unverified, [{ path: "extracted.promo_codes[].code", value: "HY45OLK8QRE2" }]);
});

test("provenance — the regression: without text_ocr the screenshot code was silently dropped", () => {
  const { value, discarded } = validateVerbatim(verdictWith(["HY45OLK8QRE2"]), "see the screenshot");
  assert.deepEqual(value.extracted.promo_codes, []);
  assert.equal(discarded.length, 1, "звірка лише з raw_text — код із картинки загубився");
});

test("provenance — a code in neither text nor transcription is still discarded", () => {
  // OCR не стає лазівкою для галюцинацій: рядок має бути хоч десь.
  const { value, discarded } = validateVerbatim(verdictWith(["INVENTED99"]), "text", "ocr text");
  assert.deepEqual(value.extracted.promo_codes, []);
  assert.deepEqual(discarded, [{ path: "extracted.promo_codes[].code", value: "INVENTED99" }]);
});

test("provenance — text wins when a code appears in both", () => {
  const { value, unverified } = validateVerbatim(verdictWith(["SAVE20"]), "SAVE20", "SAVE20");
  assert.equal(value.extracted.promo_codes[0].verified, true);
  assert.deepEqual(unverified, []);
});

test("provenance — OCR-only tickers stay strings and are listed as unverified", () => {
  // Тікери — рядки; провенанс не вміщається в елемент без зміни схеми.
  const { value, unverified } = validateVerbatim(verdictWith([], ["$BTC", "$SOL"]), "$BTC up", "$SOL chart");
  assert.deepEqual(value.entities.tickers, ["$BTC", "$SOL"]);
  assert.deepEqual(unverified, [{ path: "entities.tickers", value: "$SOL" }]);
});

test("provenance — reward and expiry survive the annotation", () => {
  const verdict = {
    extracted: { promo_codes: [{ code: "SAVE20", reward: "60 jade", expires_at: "2026-10-01" }] },
  };
  const { value } = validateVerbatim(verdict, "SAVE20");
  assert.deepEqual(value.extracted.promo_codes[0],
    { code: "SAVE20", reward: "60 jade", expires_at: "2026-10-01", source: "text", verified: true });
});

test("provenance — the caller's object is not mutated", () => {
  const verdict = verdictWith(["SAVE20"]);
  validateVerbatim(verdict, "SAVE20");
  assert.deepEqual(verdict.extracted.promo_codes, [{ code: "SAVE20" }]);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichResponseSchema,
  validateStructural,
  validateVerbatim,
  validateEnrichResponse,
  isoOrNull,
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
  assert.deepEqual(value.extracted.promo_codes, [{ code: "SAVE20", source: "text", verified: true, expires_at: null, expires_text: null }]);
  assert.deepEqual(unverified, []);
});

test("provenance — a code found ONLY in the transcription is kept, but unverified", () => {
  // Без провенансу цей код або викидався б (звірка лише з raw_text), або
  // вважався б перевіреним (якби text_ocr просто додали до перевірки).
  const { value, discarded, unverified } = validateVerbatim(
    verdictWith(["HY45OLK8QRE2"]), "see the screenshot", "Promo: HY45OLK8QRE2",
  );
  assert.deepEqual(value.extracted.promo_codes, [{ code: "HY45OLK8QRE2", source: "ocr", verified: false, expires_at: null, expires_text: null }]);
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

test("provenance — reward and an anchored expiry survive the annotation", () => {
  const verdict = {
    extracted: { promo_codes: [{ code: "SAVE20", reward: "60 jade", expires_at: "2026-10-01", expires_text: "до 1 октября" }] },
  };
  const { value } = validateVerbatim(verdict, "SAVE20 действует до 1 октября");
  assert.deepEqual(value.extracted.promo_codes[0], {
    code: "SAVE20", reward: "60 jade", expires_at: "2026-10-01", expires_text: "до 1 октября",
    source: "text", verified: true,
  });
});

test("phase 4 — an expiry without its words in the text is dropped, the code stays", () => {
  const { value, discarded } = validateVerbatim(
    { extracted: { promo_codes: [{ code: "SAVE20", expires_at: "2026-10-01", expires_text: "until October 1" }] } },
    "SAVE20 works",
  );
  assert.equal(value.extracted.promo_codes[0].code, "SAVE20");
  assert.equal(value.extracted.promo_codes[0].expires_at, null);
  assert.deepEqual(discarded, [{ path: "extracted.promo_codes[].expires_at", value: "2026-10-01" }]);
});

test("phase 4 — links and amounts must be quoted; roles are closed; malformed items are dropped, not fatal", () => {
  const text = "Claim at https://claim.example.com/drop — pool $50,000, 20% bonus";
  const { value, discarded } = validateVerbatim({ extracted: {
    links: [
      { url: "https://claim.example.com/drop", role: "claim" },
      { url: "https://invented.example.com", role: "source" },
      { url: "https://claim.example.com/drop", role: "weird" },
      "not an object",
    ],
    amounts: [
      { text: "$50,000", value: 50000, unit: "USD", what: "prize pool" },
      { text: "$1,000,000", value: 1e6 },
      { text: "20%", value: "twenty", unit: " % ", what: "" },
    ],
  } }, text);
  assert.deepEqual(value.extracted.links, [
    { url: "https://claim.example.com/drop", role: "claim", source: "text", verified: true },
    { url: "https://claim.example.com/drop", role: "other", source: "text", verified: true },
  ]);
  assert.deepEqual(value.extracted.amounts.map((a) => [a.text, a.value, a.unit, a.what]), [
    ["$50,000", 50000, "USD", "prize pool"], ["20%", null, "%", null],
  ]);
  assert.deepEqual(discarded.map((d) => d.path), [
    "extracted.links[].url", "extracted.links[].url", "extracted.amounts[].text",
  ]);
});

test("phase 4 — event dates need their exact words; a name alone is kept without dates", () => {
  const text = "Мейджор начнётся 2 июня в Кёльне";
  const ok = validateVerbatim({ extracted: { event: {
    name: "Major", starts_at: "2026-06-02", ends_at: null, date_text: "начнётся 2 июня",
  } } }, text).value.extracted.event;
  assert.deepEqual(ok, { name: "Major", starts_at: "2026-06-02", ends_at: null, date_text: "начнётся 2 июня", source: "text", verified: true });

  const invented = validateVerbatim({ extracted: { event: {
    name: "Major", starts_at: "2026-06-02", date_text: "June 2nd",
  } } }, text);
  assert.deepEqual(invented.value.extracted.event, { name: "Major", starts_at: null, ends_at: null, date_text: null });
  assert.equal(invented.discarded[0].path, "extracted.event.dates");

  const badIso = validateVerbatim({ extracted: { event: { name: "X", starts_at: "2 June", date_text: "2 июня" } } }, text);
  assert.equal(badIso.value.extracted.event.starts_at, null);

  const ocr = validateVerbatim({ extracted: { event: { name: "Drop", starts_at: "2026-10-05T18:00Z", date_text: "Oct 5 18:00" } } },
    "see image", "Drop starts Oct 5 18:00 UTC");
  assert.equal(ocr.value.extracted.event.verified, false);
  assert.deepEqual(ocr.unverified, [{ path: "extracted.event.date_text", value: "Oct 5 18:00" }]);

  assert.equal(validateVerbatim({ extracted: { event: { starts_at: "2026-01-01" } } }, "x").value.extracted.event, null);
});

test("isoOrNull accepts dates and date-times, nothing else", () => {
  assert.equal(isoOrNull("2026-10-05"), "2026-10-05");
  assert.equal(isoOrNull("2026-10-05T18:00+03:00"), "2026-10-05T18:00+03:00");
  assert.equal(isoOrNull("2026-13-45"), null);
  assert.equal(isoOrNull("5 Oct"), null);
  assert.equal(isoOrNull(null), null);
});

test("provenance — the caller's object is not mutated", () => {
  const verdict = verdictWith(["SAVE20"]);
  validateVerbatim(verdict, "SAVE20");
  assert.deepEqual(verdict.extracted.promo_codes, [{ code: "SAVE20" }]);
});


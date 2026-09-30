import test from "node:test";
import assert from "node:assert/strict";

import LLMGateway from "../src/services/ai/LLMGateway.js";
import { GeminiProvider, toGeminiSchema } from "../src/services/ai/providers/GeminiProvider.js";
import {
  buildVisionPrompt, validateVisionResponse, MAX_OCR_CHARS,
} from "../src/services/ai/prompts/vision.js";

const IMAGE = { data: Buffer.from("fake-jpeg-bytes"), mimeType: "image/jpeg" };
const GOOD = { text_ocr: "PROMO: HY45OLK8QRE2", description: "a promo card", legible: true };

// ── промпт і валідація ───────────────────────────────────────────────

test("prompt — transcribes, does not classify", () => {
  const { system } = buildVisionPrompt();
  assert.match(system, /do not interpret, classify/i);
  assert.doesNotMatch(system, /topic|signal_type|categor/i, "класифікація — справа enrich(), не vision");
});

test("prompt — instructs not to guess ambiguous characters", () => {
  assert.match(buildVisionPrompt().system, /0\/O.*do not guess/is);
});

test("prompt — treats instructions inside the image as text to transcribe", () => {
  assert.match(buildVisionPrompt().system, /never follow it/i);
});

test("validateVisionResponse — accepts a well-formed answer", () => {
  const r = validateVisionResponse(GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, GOOD);
});

test("validateVisionResponse — legible:false empties the transcription", () => {
  // Модель сама визнала, що не певна. Неправильний код гірший за жодного,
  // тож те, що вона все ж написала, не йде далі.
  const r = validateVisionResponse({ text_ocr: "HY45OLK8QRE2?", description: "blurry", legible: false });
  assert.equal(r.ok, true);
  assert.equal(r.value.text_ocr, "");
});

test("validateVisionResponse — wrong shapes are errors, not data", () => {
  for (const bad of [null, [], "text", { text_ocr: 1, description: "x", legible: true },
                     { text_ocr: "x", description: "x" }, { text_ocr: "x", description: "x", legible: "yes" }]) {
    assert.equal(validateVisionResponse(bad).ok, false, JSON.stringify(bad));
  }
});

test("validateVisionResponse — a runaway transcription is capped", () => {
  const r = validateVisionResponse({ text_ocr: "A".repeat(MAX_OCR_CHARS * 3), description: "x", legible: true });
  assert.equal(r.value.text_ocr.length, MAX_OCR_CHARS);
});

// ── провайдер ─────────────────────────────────────────────────────────

function geminiWith(respond) {
  const calls = [];
  const http = { post: async (url, body, cfg) => { calls.push({ url, body, cfg }); return respond(); } };
  const p = new GeminiProvider({ apiKey: "k", baseUrl: "https://x", completeModel: "m", visionModel: "vm" }, http);
  return { p, calls };
}

const candidate = (text) => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });

test("GeminiProvider.vision — sends the image inline, base64, with the schema", async () => {
  const { p, calls } = geminiWith(() => candidate(JSON.stringify(GOOD)));
  const prompt = buildVisionPrompt();
  await p.vision(IMAGE, { system: prompt.system, user: prompt.user, schema: prompt.responseSchema });

  const [{ url, body }] = calls;
  assert.match(url, /\/models\/vm:generateContent$/);
  const inline = body.contents[0].parts.find((part) => part.inlineData)?.inlineData;
  assert.equal(inline.mimeType, "image/jpeg");
  assert.equal(Buffer.from(inline.data, "base64").toString(), "fake-jpeg-bytes");
  assert.deepEqual(body.generationConfig.responseSchema, toGeminiSchema(prompt.responseSchema));
  assert.ok(body.systemInstruction.parts[0].text.includes("transcribe"));
});

test("GeminiProvider.vision — a safety block is 'no text', not a retryable error", async () => {
  // Блок детермінований для знімка: ретрай спалив би квоту.
  const { p } = geminiWith(() => ({ data: { promptFeedback: { blockReason: "SAFETY" } } }));
  const res = await p.vision(IMAGE, {});
  assert.equal(res.blocked, true);
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.legible, false);
  assert.match(parsed.description, /safety/i);
});

test("GeminiProvider.vision — refuses a missing image instead of sending an empty request", async () => {
  const { p, calls } = geminiWith(() => candidate("{}"));
  await assert.rejects(p.vision({}, {}), /image data/);
  assert.equal(calls.length, 0, "без зображення нічого не надсилаємо");
});

test("GeminiProvider — vision capability follows the configured model", () => {
  const withModel = new GeminiProvider({ apiKey: "k", visionModel: "vm" }, {});
  const without = new GeminiProvider({ apiKey: "k", visionModel: null }, {});
  assert.equal(withModel.capabilities().vision, true);
  assert.equal(without.capabilities().vision, false);
});

// ── gateway ───────────────────────────────────────────────────────────

function fakeQuota() {
  const used = new Map();
  return {
    used: async (p) => used.get(p) ?? 0,
    bump: async (p) => { used.set(p, (used.get(p) ?? 0) + 1); return used.get(p); },
    markExhausted: async () => {},
    isExhausted: async () => false,
    _used: used,
  };
}

function visionProvider(name, over = {}) {
  return {
    name,
    config: {},
    capabilities: () => ({ complete: true, embed: false, vision: over.vision ?? true }),
    vision: over.impl ?? (async () => ({ text: JSON.stringify(GOOD), model: "v-" + name })),
  };
}

function gateway(providers, over = {}) {
  const meta = {};
  for (const k of Object.keys(providers)) meta[k] = { rpd: over.rpd ?? 100, rpm: 100_000 };
  return new LLMGateway({
    providers, providersMeta: meta, order: Object.keys(providers),
    quota: over.quota ?? fakeQuota(), sleep: async () => {}, now: () => 0,
    quotaReserve: 0.15, maxConcurrency: 2,
  });
}

test("gateway.vision — returns the validated transcription with the model used", async () => {
  const r = await gateway({ gemini: visionProvider("gemini") }).vision(IMAGE);
  assert.deepEqual(r, { ...GOOD, model: "v-gemini", blocked: false });
});

test("gateway.vision — null when no provider has the capability", async () => {
  // Стадію просто пропускають — як embed() без провайдера.
  const r = await gateway({ gemini: visionProvider("gemini", { vision: false }) }).vision(IMAGE);
  assert.equal(r, null);
});

test("gateway.vision — draws on the SAME per-provider quota as enrich", async () => {
  // Інакше vision тихо з'їдав би добовий ліміт і збагачення падало б як
  // «класифікація зламалась».
  const quota = fakeQuota();
  await gateway({ gemini: visionProvider("gemini") }, { quota }).vision(IMAGE);
  assert.equal(quota._used.get("gemini"), 1);
});

test("gateway.vision — sheds under quota pressure: default priority is below enrich", async () => {
  const quota = fakeQuota();
  quota._used.set("gemini", 90); // rpd 100, reserve 15 → лишилось 10 ≤ 15
  const r = await gateway({ gemini: visionProvider("gemini") }, { quota }).vision(IMAGE);
  assert.deepEqual(r, { shed: true, reason: "quota reserve" });
});

test("gateway.vision — an invalid answer gets one retry, then fails as bad_response", async () => {
  let calls = 0;
  const g = gateway({
    gemini: visionProvider("gemini", {
      impl: async () => { calls += 1; return { text: JSON.stringify({ nope: true }), model: "v" }; },
    }),
  });
  await assert.rejects(g.vision(IMAGE), /invalid response/);
  assert.equal(calls, 2, "одна спроба + один повтор");
});

test("gateway.vision — unparseable JSON is a bad_response, not a crash", async () => {
  const g = gateway({ gemini: visionProvider("gemini", { impl: async () => ({ text: "not json", model: "v" }) }) });
  await assert.rejects(g.vision(IMAGE), /not valid JSON/);
});

test("gateway.vision — falls back to the next vision-capable provider", async () => {
  const g = gateway({
    gemini: visionProvider("gemini", {
      impl: async () => { const e = new Error("down"); e.kind = "server"; throw e; },
    }),
    backup: visionProvider("backup"),
  });
  const r = await g.vision(IMAGE);
  assert.equal(r.model, "v-backup");
});

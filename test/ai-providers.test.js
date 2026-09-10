import test from "node:test";
import assert from "node:assert/strict";

import { BaseProvider, ProviderError } from "../src/services/ai/providers/BaseProvider.js";
import { GeminiProvider } from "../src/services/ai/providers/GeminiProvider.js";
import { OpenAICompatProvider } from "../src/services/ai/providers/OpenAICompatProvider.js";

function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    post: async (url, body, config) => {
      calls.push({ url, body, config });
      return handler(url, body, config);
    },
  };
}

test("BaseProvider.toUnitVector normalizes to length 1", () => {
  const v = BaseProvider.toUnitVector([3, 4]);
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6);
  assert.deepEqual(BaseProvider.toUnitVector([]), new Float32Array(0));
  assert.deepEqual(Array.from(BaseProvider.toUnitVector([0, 0])), [0, 0]);
});

test("capabilities reflect config (key + model id present)", () => {
  const g = new GeminiProvider({ apiKey: "k", completeModel: "m", embedModel: "e" });
  assert.deepEqual(g.capabilities(), { complete: true, embed: true, vision: false });

  const noKey = new GeminiProvider({ completeModel: "m", embedModel: "e" });
  assert.deepEqual(noKey.capabilities(), { complete: false, embed: false, vision: false });

  const or = new OpenAICompatProvider("openrouter", { apiKey: "k", completeModel: "m", embedModel: null });
  assert.deepEqual(or.capabilities(), { complete: true, embed: false, vision: false });
});

test("GeminiProvider.complete builds the request and extracts candidate text", async () => {
  const http = fakeHttp(() => ({
    data: { candidates: [{ content: { parts: [{ text: '{"topic":"steam"}' }] } }] },
  }));
  const g = new GeminiProvider({ apiKey: "k", completeModel: "gemini-2.5-flash" }, http);

  const out = await g.complete(
    { system: "SYS", user: "USER" },
    { schema: { type: "object" }, temperature: 0 },
  );

  assert.equal(out.text, '{"topic":"steam"}');
  assert.equal(out.model, "gemini-2.5-flash");
  const { url, body, config } = http.calls[0];
  assert.match(url, /models\/gemini-2\.5-flash:generateContent/);
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.equal(body.contents[0].parts[0].text, "USER");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.temperature, 0);
  assert.deepEqual(body.generationConfig.responseSchema, { type: "object" });
  assert.equal(config.headers["x-goog-api-key"], "k");
});

test("GeminiProvider.embed returns a unit vector", async () => {
  const http = fakeHttp(() => ({ data: { embedding: { values: [3, 4] } } }));
  const g = new GeminiProvider({ apiKey: "k", embedModel: "text-embedding-004", embedDim: 768 }, http);

  const out = await g.embed("hello");
  assert.equal(out.dim, 2);
  assert.ok(Math.abs(Math.hypot(out.vector[0], out.vector[1]) - 1) < 1e-6);
  assert.equal(http.calls[0].body.outputDimensionality, 768);
});

test("OpenAICompatProvider.complete builds messages + json_schema response_format", async () => {
  const http = fakeHttp(() => ({
    data: { choices: [{ message: { content: "{}" } }] },
  }));
  const p = new OpenAICompatProvider("openrouter", { apiKey: "k", completeModel: "x/y" }, http);

  await p.complete({ system: "S", user: "U" }, { schema: { type: "object" } });
  const { url, body, config } = http.calls[0];
  assert.equal(url, "/chat/completions");
  assert.deepEqual(body.messages, [
    { role: "system", content: "S" },
    { role: "user", content: "U" },
  ]);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.model, "x/y");
  assert.equal(config.headers.authorization, "Bearer k");
});

test("OpenAICompatProvider.embed throws without an embedModel, works with one", async () => {
  const noEmbed = new OpenAICompatProvider("openrouter", { apiKey: "k", completeModel: "m" });
  await assert.rejects(() => noEmbed.embed("x"), /no embedModel/);

  const http = fakeHttp(() => ({ data: { data: [{ embedding: [1, 0, 0] }] } }));
  const withEmbed = new OpenAICompatProvider("qwen", { apiKey: "k", embedModel: "emb" }, http);
  const out = await withEmbed.embed("x");
  assert.equal(out.dim, 3);
  assert.equal(out.model, "emb");
});

test("error classification: 429 rate-limit vs daily quota vs 5xx vs network", async () => {
  const mk = (err) => new GeminiProvider({ apiKey: "k", completeModel: "m" }, {
    post: async () => { throw err; },
  });

  await assert.rejects(
    () => mk({ response: { status: 429, data: { error: "too many requests" } } }).complete({ user: "u" }),
    (e) => e instanceof ProviderError && e.kind === "rate_limit" && e.status === 429,
  );
  await assert.rejects(
    () => mk({ response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED" } } } }).complete({ user: "u" }),
    (e) => e.kind === "quota",
  );
  await assert.rejects(
    () => mk({ response: { status: 503, data: {} } }).complete({ user: "u" }),
    (e) => e.kind === "server" && e.status === 503,
  );
  await assert.rejects(
    () => mk({ code: "ECONNRESET", message: "socket hang up" }).complete({ user: "u" }),
    (e) => e.kind === "network" && e.status === null,
  );
});

test("empty model output is a bad_response, not silent success", async () => {
  const http = fakeHttp(() => ({ data: { candidates: [{ content: { parts: [] } }] } }));
  const g = new GeminiProvider({ apiKey: "k", completeModel: "m" }, http);
  await assert.rejects(() => g.complete({ user: "u" }), (e) => e.kind === "bad_response");
});

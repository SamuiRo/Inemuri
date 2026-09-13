import test from "node:test";
import assert from "node:assert/strict";

import { LLMGateway } from "../src/services/ai/LLMGateway.js";

const taxonomy = {
  version: 1,
  topics: { steam: {}, crypto: {}, other: {} },
  signals: { promo_code: {}, security: {}, launch: {} },
};

const GOOD = {
  text_en: "Free code SAVE20 for the pass",
  lang: "en",
  summary_uk: null,
  topic: "steam",
  signal_type: "promo_code",
  confidence: 0.9,
  entities: { project: "Game", tickers: [] },
  extracted: { promo_codes: [{ code: "SAVE20" }], event: null },
  why_interesting: "limited",
  is_ad: false,
};

function fakeQuota() {
  const used = new Map();
  const exhausted = new Set();
  return {
    used: async (p) => used.get(p) ?? 0,
    bump: async (p) => { const n = (used.get(p) ?? 0) + 1; used.set(p, n); return n; },
    markExhausted: async (p) => { exhausted.add(p); },
    isExhausted: async (p) => exhausted.has(p),
    _used: used, _exhausted: exhausted,
  };
}

function fakeProvider(name, over = {}) {
  return {
    name,
    config: { completeModel: "m-" + name },
    capabilities: () => over.caps ?? { complete: true, embed: false, vision: false },
    complete: over.complete ?? (async () => ({ text: JSON.stringify(GOOD), model: "m-" + name })),
    embed: over.embed ?? (async () => ({ vector: Float32Array.from([1, 0]), model: "e-" + name, dim: 2 })),
  };
}

function mkGateway(providers, over = {}) {
  const meta = {};
  for (const k of Object.keys(providers)) meta[k] = { rpd: 100, rpm: 100_000, ...(over.meta?.[k] ?? {}) };
  return new LLMGateway({
    providers,
    providersMeta: meta,
    order: over.order ?? Object.keys(providers),
    quota: over.quota ?? fakeQuota(),
    sleep: async () => {},
    now: () => 0,
    cacheTtlMs: 10_000,
    cacheMaxSize: 50,
    tierUp: over.tierUp ?? null,
    tierUpBelow: over.tierUpBelow ?? 0.5,
    quotaReserve: over.quotaReserve ?? 0.15,
    maxConcurrency: over.maxConcurrency ?? 2,
  });
}

const input = () => ({ text: "Use code SAVE20 now", candidates: { promo_codes: ["SAVE20"] }, taxonomy });

test("enrich — happy path returns a validated verdict with model_used", async () => {
  const g = mkGateway({ primary: fakeProvider("primary") });
  const r = await g.enrich(input());
  assert.equal(r.model_used, "m-primary");
  assert.equal(r.value.topic, "steam");
  assert.deepEqual(r.discarded, []);
});

test("enrich — identical input is served from cache (provider called once)", async () => {
  let calls = 0;
  const g = mkGateway({ primary: fakeProvider("primary", {
    complete: async () => { calls++; return { text: JSON.stringify(GOOD), model: "m" }; },
  }) });
  await g.enrich(input());
  const second = await g.enrich(input());
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
});

test("enrich — falls back to the next provider on a server error, trips the breaker", async () => {
  const quota = fakeQuota();
  const g = mkGateway({
    primary: fakeProvider("primary", {
      complete: async () => { const e = new Error("500"); e.kind = "server"; throw e; },
    }),
    backup: fakeProvider("backup"),
  }, { quota });
  const r = await g.enrich(input());
  assert.equal(r.model_used, "m-backup");
  assert.equal(g.providers.get("primary").breaker.state, "open");
});

test("enrich — daily quota error marks the provider exhausted and falls back", async () => {
  const quota = fakeQuota();
  const g = mkGateway({
    primary: fakeProvider("primary", {
      complete: async () => { const e = new Error("quota"); e.kind = "quota"; throw e; },
    }),
    backup: fakeProvider("backup"),
  }, { quota });
  const r = await g.enrich(input());
  assert.equal(r.model_used, "m-backup");
  assert.ok(quota._exhausted.has("primary"));
});

test("enrich — a rate_limit is retried on the SAME provider, not a fallback", async () => {
  let n = 0;
  const g = mkGateway({
    primary: fakeProvider("primary", {
      complete: async () => {
        n++;
        if (n === 1) { const e = new Error("429"); e.kind = "rate_limit"; throw e; }
        return { text: JSON.stringify(GOOD), model: "m-primary" };
      },
    }),
    backup: fakeProvider("backup"),
  });
  const r = await g.enrich(input());
  assert.equal(n, 2);
  assert.equal(r.model_used, "m-primary");
});

test("enrich — a structurally invalid verdict throws, never writes silently", async () => {
  const g = mkGateway({ primary: fakeProvider("primary", {
    complete: async () => ({ text: JSON.stringify({ ...GOOD, topic: "not-a-topic" }), model: "m" }),
  }) });
  await assert.rejects(() => g.enrich(input()), (e) => e.kind === "bad_response");
});

test("enrich — non-JSON output is bad_response, retried once, then fallback", async () => {
  let n = 0;
  const g = mkGateway({
    primary: fakeProvider("primary", { complete: async () => { n++; return { text: "not json", model: "m" }; } }),
    backup: fakeProvider("backup"),
  });
  const r = await g.enrich(input());
  assert.equal(n, 2); // one retry on primary
  assert.equal(r.model_used, "m-backup");
});

test("enrich — verbatim stripping flows through to discarded[]", async () => {
  const g = mkGateway({ primary: fakeProvider("primary", {
    complete: async () => ({
      text: JSON.stringify({
        ...GOOD,
        entities: { project: "Game", tickers: ["$GHOST"] },
        extracted: { promo_codes: [{ code: "SAVE20" }, { code: "FAKE99" }], event: null },
      }),
      model: "m",
    }),
  }) });
  const r = await g.enrich(input());
  assert.deepEqual(r.value.extracted.promo_codes.map((c) => c.code), ["SAVE20"]);
  assert.deepEqual(r.value.entities.tickers, []);
  assert.equal(r.discarded.length, 2);
});

test("shed — low priority is deferred near the quota reserve; critical is not", async () => {
  const quota = fakeQuota();
  quota._used.set("primary", 90); // rpd 100, reserve 15 -> remaining 10 <= 15
  const g = mkGateway({ primary: fakeProvider("primary") }, { quota });

  const low = await g.enrich(input(), { priority: "low" });
  assert.equal(low.shed, true);

  const crit = await g.enrich(input(), { priority: "critical" });
  assert.equal(crit.model_used, "m-primary");
});

test("tiering — a low-confidence verdict is re-run on the stronger model, once", async () => {
  const seen = [];
  const g = mkGateway({ primary: fakeProvider("primary", {
    complete: async (_msgs, opts) => {
      // the clone carries the overridden completeModel; detect via call count
      seen.push(opts);
      const conf = seen.length === 1 ? 0.3 : 0.95;
      return { text: JSON.stringify({ ...GOOD, confidence: conf }), model: seen.length === 1 ? "m-primary" : "m-strong" };
    },
  }) }, { tierUp: "m-strong", tierUpBelow: 0.5 });

  const r = await g.enrich(input());
  assert.equal(seen.length, 2);
  assert.equal(r.tiered, true);
  assert.equal(r.model_used, "m-strong");
});

test("embed — returns null when no provider advertises the capability", async () => {
  const g = mkGateway({ primary: fakeProvider("primary") }); // complete only
  assert.equal(await g.embed("hello"), null);
});

test("embed — happy path, cached on repeat", async () => {
  let n = 0;
  const g = mkGateway({ e: fakeProvider("e", {
    caps: { complete: false, embed: true, vision: false },
    embed: async () => { n++; return { vector: Float32Array.from([1, 0]), model: "emb", dim: 2 }; },
  }) });
  const a = await g.embed("hello world");
  assert.equal(a.dim, 2);
  assert.equal(a.model, "emb");
  const b = await g.embed("hello world");
  assert.equal(b.cached, true);
  assert.equal(n, 1);
});

test("no capable provider at all -> throws kind:unavailable", async () => {
  const g = mkGateway({ e: fakeProvider("e", { caps: { complete: false, embed: true, vision: false } }) });
  await assert.rejects(() => g.enrich(input()), (e) => e.kind === "unavailable");
});

test("priority queue respects the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const g = mkGateway({ primary: fakeProvider("primary", {
    complete: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { text: JSON.stringify(GOOD), model: "m" };
    },
  }) }, { maxConcurrency: 2 });

  // distinct inputs so every call goes through the provider (no cache hits)
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      g.enrich({ text: `distinct message ${i} SAVE20`, candidates: {}, taxonomy })),
  );
  assert.equal(peak, 2, `peak in-flight should be exactly the cap`);
});

test("quota — the ledger day is computed in each provider's own reset zone", async () => {
  // Gemini скидає RPD за тихоокеанським часом. Gateway має питати реєстр про
  // день саме в поясі провайдера, а не про UTC-дату для всіх.
  const seen = [];
  const quota = fakeQuota();
  quota.today = (tz) => `day-in-${tz}`;
  const origUsed = quota.used, origBump = quota.bump;
  quota.used = async (p, day) => { seen.push(["used", p, day]); return origUsed(p); };
  quota.bump = async (p, day) => { seen.push(["bump", p, day]); return origBump(p); };

  const g = mkGateway(
    { primary: fakeProvider("primary") },
    { quota, meta: { primary: { quotaTimeZone: "America/Los_Angeles" } } },
  );
  await g.enrich(input());

  assert.ok(seen.length >= 2, "реєстр мав бути опитаний");
  for (const [, , day] of seen) assert.equal(day, "day-in-America/Los_Angeles");
});

test("quota — a provider with no zone configured uses UTC", async () => {
  const days = [];
  const quota = fakeQuota();
  quota.today = (tz) => tz;
  const origBump = quota.bump;
  quota.bump = async (p, day) => { days.push(day); return origBump(p); };

  const g = mkGateway({ primary: fakeProvider("primary") }, { quota });
  await g.enrich(input());
  assert.deepEqual([...new Set(days)], ["UTC"]);
});

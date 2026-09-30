import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeUrl,
  tier1Keys,
  decodeEmbedding,
  cosine,
  richness,
  entitySet,
  windowHours,
  maxWindowHours,
  clusterAccepts,
  decide,
} from "../src/module/theflow/dedup/DedupCore.js";

const HOUR = 3_600_000;
const T = { high: 0.9, low: 0.75, gateFactor: 1.15, replaceFactor: 2 };
const taxonomy = {
  signals: {
    promo_code: { dedup_window_hours: 24 },
    security: { dedup_window_hours: 6 },
    analysis: { dedup_window_hours: 72 },
    event: {},
  },
};

test("normalizeUrl: same resource, same key", () => {
  assert.equal(normalizeUrl("https://www.Example.com/a/?utm_source=tg&b=2&a=1#x"), "example.com/a?a=1&b=2");
  assert.equal(normalizeUrl("https://youtu.be/feQH2mNWBww?si=abc"), "youtube.com/watch?v=feQH2mNWBww");
  assert.equal(normalizeUrl("https://www.youtube.com/watch?v=feQH2mNWBww&feature=share"), "youtube.com/watch?v=feQH2mNWBww");
  assert.equal(normalizeUrl("http://m.site.org/"), "site.org");
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl("tg://resolve?domain=x"), null);
});

test("tier1Keys: verified codes only, boilerplate URLs excluded", () => {
  const post = {
    analysis: { extracted: { promo_codes: [
      { code: "save20x", verified: true },
      { code: "OCRCODE", verified: false, source: "ocr" },
      { code: "AB", verified: true }, // закороткий — не ключ
    ] } },
    candidates: { urls: ["https://t.me/mychannel", "https://site.com/drop?utm_campaign=1"] },
    text_hash: "h1",
    external_url: null,
  };
  const keys = tier1Keys(post, new Set(["t.me/mychannel"]));
  assert.deepEqual(keys.sort(), ["code:SAVE20X", "hash:h1", "url:site.com/drop"]);
});

test("decodeEmbedding checks the length against dim; cosine of unit vectors", () => {
  const v = Float32Array.from([0.6, 0.8]);
  const buf = Buffer.from(v.buffer);
  assert.deepEqual([...decodeEmbedding(buf, 2)].map((x) => x.toFixed(1)), ["0.6", "0.8"]);
  assert.equal(decodeEmbedding(buf, 3), null);
  assert.equal(decodeEmbedding(null, 2), null);
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(v, Float32Array.from([0.8, -0.6]))) < 1e-6);
  assert.equal(cosine(v, Float32Array.from([1])), null);
});

test("richness and entitySet", () => {
  const p = {
    text_en: "x".repeat(100),
    has_media: true,
    candidates: { urls: ["https://a.com"], dates: ["03.05"], amounts: ["50%"] },
    analysis: { entities: { tickers: ["$ABC"], project: "Proj" }, extracted: { promo_codes: [{ code: "C0DE1" }] } },
  };
  assert.equal(richness(p), 100 + 1 + 2 + 3 + 1);
  assert.deepEqual([...entitySet(p)].sort(), [
    "amount:50%", "code:C0DE1", "date:03.05", "project:proj", "ticker:ABC", "url:a.com",
  ]);
  assert.equal(richness({}), 0);
});

test("windows: source override, then signal, then fallback; max for the pool", () => {
  assert.equal(windowHours("promo_code", taxonomy), 24);
  assert.equal(windowHours("promo_code", taxonomy, { dedup_window_hours: 3 }), 3);
  assert.equal(windowHours("event", taxonomy), 48);
  assert.equal(windowHours("unknown", taxonomy, null, 12), 12);
  assert.equal(maxWindowHours(taxonomy), 72);
});

test("clusterAccepts: closed or out of window refuses", () => {
  const c = { closed: false, last_seen_at: 0 };
  assert.equal(clusterAccepts(c, 5 * HOUR, 6), true);
  assert.equal(clusterAccepts(c, 7 * HOUR, 6), false);
  assert.equal(clusterAccepts({ ...c, closed: true }, HOUR, 6), false);
});

const canonical = {
  id: 1, text_en: "Free case drop this weekend", signal_type: "event",
  candidates: { urls: [], dates: [], amounts: [] }, analysis: {},
};
const cluster = { id: 10, signal_type: "event", richness: richness(canonical), members_count: 1 };

test("decide: no match, far → new; gray zone → new with the flag", () => {
  const post = { id: 2, text_en: "other", embedding_model: "emb" };
  const far = decide({ post, tier1: null, tier2: { cluster, post: canonical, s: 0.5 }, thresholds: T });
  assert.equal(far.decision, "new");
  assert.equal(far.log.gray, false);
  const gray = decide({ post, tier1: null, tier2: { cluster, post: canonical, s: 0.82 }, thresholds: T });
  assert.equal(gray.decision, "new");
  assert.equal(gray.log.gray, true);
  assert.equal(gray.log.nearest_post_id, 1);
  assert.equal(gray.log.s, 0.82);
});

test("decide: a tier-2 duplicate that adds nothing is suppressed", () => {
  const post = { id: 3, text_en: "Free case drop on the weekend", signal_type: "event",
    candidates: {}, analysis: {}, embedding_model: "emb" };
  const d = decide({ post, tier1: null, tier2: { cluster, post: canonical, s: 0.95 }, canonicalOf: canonical, thresholds: T });
  assert.equal(d.decision, "join");
  assert.equal(d.tier, 2);
  assert.equal(d.role, "duplicate");
  assert.equal(d.suppress, true);
  assert.equal(d.log.cluster_id, 10);
});

test("decide: a new entity makes it linked, never suppressed", () => {
  const post = { id: 4, text_en: "Free case drop this weekend", signal_type: "event",
    candidates: { dates: ["14.03"] }, analysis: {}, embedding_model: "emb" };
  const d = decide({ post, tier1: null, tier2: { cluster, post: canonical, s: 0.93 }, canonicalOf: canonical, thresholds: T });
  assert.equal(d.role, "linked");
  assert.equal(d.suppress, false);
  assert.deepEqual(d.log.gate.adds_entities, ["date:14.03"]);
});

test("decide: tier 1 wins regardless of s", () => {
  const post = { id: 5, text_en: "code", signal_type: "promo_code", candidates: {}, analysis: {} };
  const d = decide({ post, tier1: { cluster, post: canonical, key: "code:SAVE20" }, tier2: null, canonicalOf: canonical, thresholds: T });
  assert.equal(d.tier, 1);
  assert.equal(d.log.key, "code:SAVE20");
  assert.equal(d.log.no_embedding, true);
});

test("decide: security is never suppressed", () => {
  const secCluster = { ...cluster, signal_type: "security" };
  const post = { id: 6, text_en: "Exchange hacked", signal_type: "security", candidates: {}, analysis: {}, embedding_model: "e" };
  const d = decide({ post, tier1: null, tier2: { cluster: secCluster, post: canonical, s: 0.99 },
    canonicalOf: { ...canonical, text_en: "Exchange X hacked, withdrawals halted" }, thresholds: T });
  assert.equal(d.role, "linked");
  assert.equal(d.suppress, false);
  assert.equal(d.log.never_suppress, true);
});

test("decide: a much richer post replaces the canonical", () => {
  const post = { id: 7, text_en: "x".repeat(200), signal_type: "event", candidates: {}, analysis: {}, embedding_model: "e" };
  const d = decide({ post, tier1: null, tier2: { cluster, post: canonical, s: 0.91 }, canonicalOf: canonical, thresholds: T });
  assert.equal(d.replaceCanonical, true);
  assert.equal(d.role, "canonical");
  assert.equal(d.suppress, false);
});

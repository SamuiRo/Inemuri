import test from "node:test";
import assert from "node:assert/strict";

import { TokenBucket, CircuitBreaker, TtlCache } from "../src/services/ai/internal.js";

test("TokenBucket — starts full, depletes, refills over time", () => {
  let t = 0;
  const b = new TokenBucket(60, () => t); // 60/min => 1/sec, capacity 60
  b.tokens = 2;

  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  assert.ok(b.msUntilNext() > 0 && b.msUntilNext() <= 1000);

  t += 1000; // one second -> ~1 token back
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
});

test("TokenBucket.take resolves once a token is available (fake sleep advances clock)", async () => {
  let t = 0;
  const b = new TokenBucket(60, () => t);
  b.tokens = 0;
  const sleep = async (ms) => { t += ms; };
  await b.take(sleep);
  assert.ok(t > 0);
});

test("CircuitBreaker — opens after threshold, half-opens after coolOff, closes on success", () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 2, coolOffMs: 1000, now: () => t });

  assert.equal(cb.allow(), true);
  cb.recordFailure();
  assert.equal(cb.allow(), true);
  cb.recordFailure(); // hits threshold
  assert.equal(cb.state, "open");
  assert.equal(cb.allow(), false);

  t += 1000;
  assert.equal(cb.allow(), true); // half-open probe
  assert.equal(cb.state, "half");
  cb.recordSuccess();
  assert.equal(cb.state, "closed");
});

test("CircuitBreaker — a failed half-open probe re-opens immediately", () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 1, coolOffMs: 100, now: () => t });
  cb.recordFailure();
  assert.equal(cb.state, "open");
  t += 100;
  assert.equal(cb.allow(), true); // half
  cb.recordFailure();
  assert.equal(cb.state, "open");
});

test("TtlCache — get/set, TTL expiry, size cap", () => {
  let t = 0;
  const c = new TtlCache({ ttlMs: 100, maxSize: 2, now: () => t });

  c.set("a", 1);
  assert.equal(c.get("a"), 1);

  t += 101;
  assert.equal(c.get("a"), undefined); // expired

  t = 0;
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // evicts "a" (oldest)
  assert.equal(c.size, 2);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
});

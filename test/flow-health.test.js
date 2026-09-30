import test from "node:test";
import assert from "node:assert/strict";

import {
  assessHealth,
  topErrors,
  formatAge,
  isQuotaWait,
  formatHealthMessage,
  FlowHealthMonitor,
  primaryQuota,
} from "../src/module/theflow/FlowHealth.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date("2026-09-30T12:00:00Z");
const T = { pendingMaxAgeMin: 120, failureMin: 5, failureShare: 0.5, ingestSilentHours: 24 };

function snap(over = {}) {
  return {
    now: NOW,
    pending: 0,
    oldestPendingAt: null,
    window: { minutes: 60, enriched: 10, failed: 0, topErrors: [] },
    lastIngestAt: new Date(NOW.getTime() - 5 * MIN),
    lastFinishedAt: new Date(NOW.getTime() - 3 * MIN),
    flowSources: 3,
    quota: { key: "gemini:m", used: 40, rpd: 500, exhausted: false },
    ...over,
  };
}
const keys = (r) => r.problems.map((p) => p.key);

test("a healthy corpus has no problems", () => {
  const r = assessHealth(snap(), T);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test("enrich_failing: the 2026-09-29 pilot — every call failing, nothing pending", () => {
  const r = assessHealth(snap({
    window: { minutes: 60, enriched: 0, failed: 52,
      topErrors: [{ error: "bad_response: gemini complete: HTTP 400", count: 52 }] },
  }), T);
  assert.deepEqual(keys(r), ["enrich_failing"]);
  assert.match(r.problems[0].message, /52 of 52/);
  assert.match(r.problems[0].message, /HTTP 400 \(×52\)/);
});

test("enrich_failing needs both the count and the share", () => {
  // Кілька failed на тлі нормальної роботи — не тривога.
  assert.deepEqual(keys(assessHealth(snap({ window: { minutes: 60, enriched: 40, failed: 6, topErrors: [] } }), T)), []);
  // Велика частка, але мало — теж ні (один поганий пост не привід).
  assert.deepEqual(keys(assessHealth(snap({ window: { minutes: 60, enriched: 1, failed: 3, topErrors: [] } }), T)), []);
});

test("enrich_stalled: old pending, nothing finishing, quota available", () => {
  const r = assessHealth(snap({
    pending: 217,
    oldestPendingAt: new Date(NOW.getTime() - 3 * HOUR),
    lastFinishedAt: new Date(NOW.getTime() - 5 * HOUR),
  }), T);
  assert.deepEqual(keys(r), ["enrich_stalled"]);
  assert.match(r.problems[0].message, /217 post\(s\) pending, the oldest for 3h 0m; nothing enriched or failed for 5h 0m/);
});

test("old pending that the worker is draining is not a stall (after flow requeue)", () => {
  const r = assessHealth(snap({
    pending: 150,
    oldestPendingAt: new Date(NOW.getTime() - 20 * HOUR),
    lastFinishedAt: new Date(NOW.getTime() - MIN),
  }), T);
  assert.equal(r.ok, true);
});

test("a just-started process is given the threshold before it counts as stalled", () => {
  const stuck = { pending: 217, oldestPendingAt: new Date(NOW.getTime() - 20 * HOUR), lastFinishedAt: null };
  assert.equal(assessHealth(snap(stuck), T, { since: new Date(NOW.getTime() - 10 * MIN) }).ok, true);
  const r = assessHealth(snap(stuck), T, { since: new Date(NOW.getTime() - 3 * HOUR) });
  assert.deepEqual(keys(r), ["enrich_stalled"]);
  assert.match(r.problems[0].message, /nothing enriched or failed yet/);
});

test("old pending during quota exhaustion is a note, not a problem", () => {
  for (const quota of [
    { key: "gemini:m", used: 12, rpd: 500, exhausted: true },
    { key: "gemini:m", used: 500, rpd: 500, exhausted: false },
  ]) {
    const r = assessHealth(snap({
      pending: 90, oldestPendingAt: new Date(NOW.getTime() - 10 * HOUR),
      lastFinishedAt: new Date(NOW.getTime() - 9 * HOUR), quota,
    }), T);
    assert.equal(r.ok, true);
    assert.match(r.notes.join(), /waiting for the daily quota reset/);
  }
});

test("fresh pending is not a stall", () => {
  const r = assessHealth(snap({ pending: 217, oldestPendingAt: new Date(NOW.getTime() - 30 * MIN) }), T);
  assert.equal(r.ok, true);
});

test("without a worker in the process, enrich is not judged", () => {
  const r = assessHealth(snap({
    pending: 50, oldestPendingAt: new Date(NOW.getTime() - 48 * HOUR),
    window: { minutes: 60, enriched: 0, failed: 30, topErrors: [] },
  }), T, { workerRunning: false });
  assert.equal(r.ok, true);
  assert.match(r.notes.join(), /worker is not running/);
});

test("ingest_silent, counted from the later of last ingest and monitor start", () => {
  const old = new Date(NOW.getTime() - 30 * HOUR);
  assert.deepEqual(keys(assessHealth(snap({ lastIngestAt: old }), T)), ["ingest_silent"]);
  // Монітор щойно стартував — старий останній пост ще не тиша.
  assert.deepEqual(keys(assessHealth(snap({ lastIngestAt: old }), T, { since: new Date(NOW.getTime() - HOUR) })), []);
  // Порожній корпус: рахуємо від старту монітора.
  assert.deepEqual(keys(assessHealth(snap({ lastIngestAt: null }), T, { since: new Date(NOW.getTime() - HOUR) })), []);
  const r = assessHealth(snap({ lastIngestAt: null }), T, { since: new Date(NOW.getTime() - 25 * HOUR) });
  assert.match(r.problems[0].message, /since the monitor started/);
});

test("no flow sources — nothing to watch", () => {
  const r = assessHealth(snap({ flowSources: 0, lastIngestAt: null, pending: 5, oldestPendingAt: new Date(0) }), T,
    { since: new Date(0) });
  assert.equal(r.ok, true);
});

test("helpers: topErrors groups by prefix, formatAge, isQuotaWait, primaryQuota", () => {
  const long = "bad_response: HTTP 400 " + "x".repeat(200);
  assert.deepEqual(topErrors([long + "a", long + "b", "server: down", null]), [
    { error: long.slice(0, 120), count: 2 },
    { error: "server: down", count: 1 },
  ]);
  assert.equal(formatAge(59 * 1000), "0m");
  assert.equal(formatAge(125 * MIN), "2h 5m");
  assert.equal(formatAge(50 * HOUR), "2d 2h");
  assert.equal(isQuotaWait(null), false);
  assert.equal(isQuotaWait({ used: 1, rpd: null, exhausted: false }), false);
  assert.deepEqual(
    primaryQuota({ gemini: { completeModel: "lite", quotaTimeZone: "America/Los_Angeles", rpd: 9,
      modelLimits: { lite: { rpd: 500 } } } }, "gemini"),
    { key: "gemini:lite", timeZone: "America/Los_Angeles", rpd: 500 },
  );
  assert.equal(primaryQuota({}, "gemini"), null);
});

test("formatHealthMessage", () => {
  const t = formatHealthMessage({
    raised: [{ key: "enrich_failing", message: "m1" }],
    recovered: ["ingest_silent"],
  });
  assert.equal(t, "⚠️ TheFlow health — 1 problem(s)\n• enrich failing: m1\n✅ recovered: ingest silent");
  assert.equal(formatHealthMessage({ recovered: ["enrich_stalled"] }),
    "✅ TheFlow health — recovered\n✅ recovered: enrich stalled");
});

test("monitor notifies on transitions only: raise, silence, repeat, recover", async () => {
  let clock = NOW.getTime();
  let current = snap();
  const sent = [];
  const m = new FlowHealthMonitor({
    collect: async () => ({ ...current, now: new Date(clock) }),
    notify: (text) => { sent.push(text); },
    thresholds: T,
    intervalMs: 10 * MIN,
    repeatMs: 6 * HOUR,
    now: () => clock,
  });

  assert.equal(await m.tick(), null, "healthy — nothing sent");

  current = snap({ window: { minutes: 60, enriched: 0, failed: 9, topErrors: [] } });
  const first = await m.tick();
  assert.equal(first.raised.length, 1);
  assert.equal(sent.length, 1);

  clock += 10 * MIN;
  assert.equal(await m.tick(), null, "same problem, no repeat yet");

  clock += 6 * HOUR;
  const again = await m.tick();
  assert.equal(again.repeated.length, 1);
  assert.match(sent[1], /still — enrich failing/);

  current = snap();
  clock += 10 * MIN;
  const rec = await m.tick();
  assert.deepEqual(rec.recovered, ["enrich_failing"]);
  assert.match(sent[2], /recovered/);
  assert.equal(await m.tick(), null);
  assert.equal(sent.length, 3);
});

test("monitor survives a failing collect and a failing notify", async () => {
  const logs = [];
  const m = new FlowHealthMonitor({
    collect: async () => { throw new Error("db locked"); },
    notify: () => {},
    thresholds: T, intervalMs: MIN, repeatMs: HOUR,
    log: (msg) => logs.push(msg),
  });
  assert.equal(await m.tick(), null);
  assert.match(logs[0], /check failed: db locked/);

  const m2 = new FlowHealthMonitor({
    collect: async () => snap({ window: { minutes: 60, enriched: 0, failed: 9, topErrors: [] } }),
    notify: async () => { throw new Error("telegram down"); },
    thresholds: T, intervalMs: MIN, repeatMs: HOUR,
    now: () => NOW.getTime(),
    log: (msg) => logs.push(msg),
  });
  const r = await m2.tick();
  assert.equal(r.raised.length, 1, "state still advances — no alert storm on the next tick");
  assert.match(logs.at(-1), /notify failed: telegram down/);
});

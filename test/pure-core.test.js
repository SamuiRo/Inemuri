import test from "node:test";
import assert from "node:assert/strict";

import { planClusterUpdate } from "../src/module/theflow/delivery/FlowDelivery.js";
import { phaseOffsetMs, dueSources, nextDueAt } from "../src/sources/telegram/pollingSchedule.js";
import { aggregateFlowStats } from "../src/module/theflow/stats.js";
import { copyDestinations, destinationIdProblems } from "../src/shared/destinations.js";
import { buildStatus } from "../src/module/status/StatusBoard.js";
import { DISCORD, TELEGRAM } from "../src/shared/platformLimits.js";
import { HOUR, DAY } from "../src/shared/time.js";

const adds = { adds: { relation: "adds" } };
const corrects = { adds: { relation: "corrects" } };
const denies = { adds: { relation: "denies" } };

test("planClusterUpdate: additions edit under the cap, only count over it", () => {
  assert.deepEqual(
    { ...planClusterUpdate({ triggers: [adds], appendsCount: 0, maxAppends: 3 }), corrections: undefined, additions: undefined },
    { edit: true, capped: false, corrections: undefined, additions: undefined },
  );
  const over = planClusterUpdate({ triggers: [adds, adds], appendsCount: 3, maxAppends: 3 });
  assert.equal(over.edit, false);
  assert.equal(over.capped, true);
  assert.equal(over.additions.length, 2);
});

test("planClusterUpdate: a correction or denial always edits, cap or no cap", () => {
  for (const t of [corrects, denies]) {
    const p = planClusterUpdate({ triggers: [adds, t], appendsCount: 99, maxAppends: 3 });
    assert.equal(p.edit, true);
    assert.equal(p.capped, false);
    assert.equal(p.corrections.length, 1);
  }
});

test("planClusterUpdate: force rewrites with no triggers; nothing to do otherwise", () => {
  assert.equal(planClusterUpdate({ triggers: [], force: true }).edit, true);
  const idle = planClusterUpdate({ triggers: [] });
  assert.equal(idle.edit, false);
  assert.equal(idle.capped, false);
});

test("pollingSchedule: offset is deterministic and within the interval", () => {
  assert.equal(phaseOffsetMs(7, HOUR), phaseOffsetMs(7, HOUR));
  for (const id of [1, 2, 3, 42, "x"]) {
    const o = phaseOffsetMs(id, HOUR);
    assert.ok(o >= 0 && o < HOUR);
  }
  assert.equal(phaseOffsetMs(1, 0), 0);
  assert.equal(phaseOffsetMs(1, NaN), 0);
});

test("pollingSchedule: due sources are the most overdue first, capped", () => {
  const due = new Map([[1, 500], [2, 100], [3, 900], [4, 2_000]]);
  assert.deepEqual(dueSources(due, 1_000, 2), [2, 1]);
  assert.deepEqual(dueSources(due, 1_000, 10), [2, 1, 3]);
  assert.deepEqual(dueSources(due, 50, 10), []);
});

test("pollingSchedule: the phase offset is added only on the first reschedule", () => {
  const first = nextDueAt({ sourceId: 5, now: 0, everyMs: HOUR, phased: false });
  assert.equal(first, HOUR + phaseOffsetMs(5, HOUR));
  assert.equal(nextDueAt({ sourceId: 5, now: first, everyMs: HOUR, phased: true }), first + HOUR);
});

test("aggregateFlowStats: totals, per source, length buckets, candidates, span", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  const rows = [
    { source_id: 1, status: "enriched", has_media: true, len: 10, created_at: new Date(now - 2 * DAY), candidates: { promo_codes: ["SAVE20"] } },
    { source_id: 1, status: "skipped_repost", has_media: false, len: 0, created_at: new Date(now - DAY), candidates: "{\"urls\":[\"https://x\"]}" },
    { source_id: 2, status: "enriched", has_media: false, len: 1_500, created_at: new Date(now - DAY), candidates: "not json" },
  ];
  const { total, perSource, spanDays } = aggregateFlowStats(rows, { now });
  assert.equal(total.n, 3);
  assert.equal(spanDays, 2);
  assert.deepEqual(total.status, { enriched: 2, skipped_repost: 1 });
  assert.equal(total.lenBuckets["0"], 1);
  assert.equal(total.lenBuckets["<50"], 1);
  assert.equal(total.lenBuckets["1000+"], 1);
  assert.equal(total.mediaShort, 1);
  assert.equal(total.cand.promo_codes.n, 1);
  assert.equal(total.cand.urls.n, 1);
  assert.equal(perSource.get(1).n, 2);
  assert.equal(perSource.get(2).lenMax, 1_500);
  assert.equal(aggregateFlowStats([], { now }).spanDays, 0);
});

test("shared destinations: copy drops empty ids; id problems catch placeholders", () => {
  const src = { telegram: ["-100123", ""], discord: "123456789012345678", empty: [] };
  const copy = copyDestinations(src);
  assert.deepEqual(copy, { telegram: ["-100123"], discord: ["123456789012345678"] });
  copy.telegram.push("x");
  assert.deepEqual(src.telegram, ["-100123", ""]);
  assert.deepEqual(destinationIdProblems({ telegram: ["@channel_name", "-1001"], discord: ["123456789012345678"] }, "r"), []);
  assert.equal(destinationIdProblems({ discord: ["TODO:claims"], telegram: ["@ab"] }, "routing").length, 2);
});

test("status board takes its line cap from the thresholds", () => {
  const now = Date.parse("2026-10-07T00:00:00Z");
  const sources = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, lastSeenAt: null }));
  const capped = buildStatus({ sources, channels: [] }, { sourceSilentHours: 72, channelSilentHours: 168, maxLines: 2 }, now);
  const text = JSON.stringify(capped);
  assert.match(text, /і ще 3/);
});

test("platform limits are the API's numbers", () => {
  assert.equal(DISCORD.messageContent, 2000);
  assert.equal(DISCORD.embedDescription, 4096);
  assert.equal(DISCORD.buttonsPerRow * DISCORD.componentRows, 25);
  assert.equal(TELEGRAM.caption, 1024);
  assert.equal(TELEGRAM.message, 4096);
  assert.throws(() => { DISCORD.messageContent = 1; });
});

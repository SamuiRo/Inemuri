import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Source, SourceState, StatusMessage } from "../src/module/teapot/models/index.js";
import { StatusBoard, buildStatus, formatAge } from "../src/module/status/StatusBoard.js";
import { SourceActivity } from "../src/module/status/SourceActivity.js";
import { deliveryChannels, collectChannels } from "../src/module/status/collect.js";
import { snowflakeTime } from "../src/module/discord/DiscordRest.js";

const H = 3_600_000;
const NOW = Date.parse("2026-10-04T12:00:00Z");
const T = { sourceSilentHours: 72, channelSilentHours: 168 };
const ago = (hours) => new Date(NOW - hours * H);
const XID = `__st_${process.pid}_`;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
});
test.after(async () => {
  await StatusMessage.destroy({ where: { channel_id: [`${XID}a`, `${XID}b`] } });
  const sources = await Source.findAll({ where: { channel_id: `${XID}src` } });
  for (const s of sources) await SourceState.destroy({ where: { source_id: s.id } });
  await Source.destroy({ where: { channel_id: `${XID}src` } });
  await database.disconnect();
});

// ── рендер ────────────────────────────────────────────────────────────

test("buildStatus — silent sources and channels are listed oldest first; fresh ones are not", () => {
  const r = buildStatus({
    sources: [
      { name: "Fresh", platform: "telegram", lastSeenAt: ago(5) },
      { name: "Quiet", platform: "telegram", lastSeenAt: ago(100) },
      { name: "Dead", platform: "rss", lastSeenAt: ago(500) },
      { name: "New", platform: "telegram", lastSeenAt: null },
    ],
    channels: [
      { platform: "discord", id: "1", name: "#busy", lastActivityAt: ago(2) },
      { platform: "discord", id: "2", name: "#idle", lastActivityAt: ago(200) },
      { platform: "telegram", id: "-3", name: null, lastActivityAt: null },
      { platform: "discord", id: "4", name: null, lastActivityAt: null, error: "Missing Access" },
    ],
  }, T, NOW);
  assert.equal(r.silentSources, 2);
  assert.equal(r.silentChannels, 2);
  assert.ok(r.text.indexOf("Dead") < r.text.indexOf("Quiet"), "the longest silence first");
  assert.ok(!r.text.includes("Fresh"));
  assert.ok(r.text.includes("🔇 **Джерела мовчать понад 3 д** · 2 з 4"));
  assert.ok(r.text.includes("Ще не бачили з початку відстеження** · 1") && r.text.includes("• New · telegram"));
  assert.ok(r.text.includes("#idle · discord — 8 д 8 год"));
  assert.ok(r.text.includes("-3 · telegram — ніколи"));
  assert.ok(r.text.includes("Не вдалося перевірити") && r.text.includes("Missing Access"));
  assert.ok(!r.text.includes("#busy"));
  assert.equal(r.allGood, false);
});

test("buildStatus — everything active says so", () => {
  const r = buildStatus({ sources: [{ name: "A", platform: "telegram", lastSeenAt: ago(1) }], channels: [] }, T, NOW);
  assert.ok(r.text.includes("✅ Усе активне: джерел — 1, каналів — 0"));
  assert.equal(r.allGood, true);
});

test("formatAge", () => {
  assert.equal(formatAge(40 * 60_000), "40 хв");
  assert.equal(formatAge(7 * H), "7 год");
  assert.equal(formatAge(72 * H), "3 д");
  assert.equal(formatAge(123 * H), "5 д 3 год");
});

// ── публікація ─────────────────────────────────────────────────────────

function fakeTransport({ editFails = false } = {}) {
  const calls = [];
  return {
    calls,
    send: async (platform, id) => { calls.push(["send", platform, id]); return { message_id: `m-${calls.length}` }; },
    edit: async (platform, id, messageId) => { calls.push(["edit", platform, id, messageId]); if (editFails) throw new Error("Unknown Message"); },
  };
}

test("StatusBoard — posts once, then edits the same message in place", async () => {
  const t = fakeTransport();
  const board = new StatusBoard({
    collect: async () => ({ sources: [], channels: [] }),
    destinations: { discord: [`${XID}a`] },
    send: t.send, edit: t.edit, store: StatusMessage, thresholds: T, now: () => NOW, log: () => {},
  });
  await board.runOnce();
  await board.runOnce();
  assert.deepEqual(t.calls.map((c) => c[0]), ["send", "edit"]);
  assert.equal(t.calls[1][3], "m-1", "edits the message it posted");
  assert.equal((await StatusMessage.find("discord", `${XID}a`)).message_id, "m-1");
});

test("StatusBoard — a deleted status message is replaced by a new one, which is remembered", async () => {
  await StatusMessage.remember("discord", `${XID}b`, "gone");
  const t = fakeTransport({ editFails: true });
  const board = new StatusBoard({
    collect: async () => ({ sources: [], channels: [] }),
    destinations: { discord: [`${XID}b`] },
    send: t.send, edit: t.edit, store: StatusMessage, thresholds: T, now: () => NOW, log: () => {},
  });
  await board.runOnce();
  assert.deepEqual(t.calls.map((c) => c[0]), ["edit", "send"]);
  assert.equal((await StatusMessage.find("discord", `${XID}b`)).message_id, "m-2");
});

// ── збір ───────────────────────────────────────────────────────────────

test("deliveryChannels — sources and routing, without duplicates, the status and health channels left out", () => {
  const channels = deliveryChannels({
    sources: [{ destinations: { discord: ["111111111111111111"], telegram: ["-1001"] } }, { destinations: { discord: ["111111111111111111"] } }],
    routing: {
      unsorted_destinations: { discord: ["222222222222222222"] },
      digest_destinations: { telegram: ["-1002"] },
      routing: [{ when: {}, destinations: { discord: ["333333333333333333"] } }],
      status_destinations: { discord: ["333333333333333333"] },
      health_destinations: { telegram: ["-1002"] },
    },
  });
  assert.deepEqual(channels.map((c) => `${c.platform}:${c.id}`).sort(), [
    "discord:111111111111111111", "discord:222222222222222222", "telegram:-1001",
  ]);
});

test("collectChannels — one unreachable channel does not stop the rest", async () => {
  const adapter = {
    describeChannel: async (id) => {
      if (id === "bad") throw new Error("Missing Access");
      return { name: `#${id}`, lastActivityAt: ago(1) };
    },
  };
  const out = await collectChannels([{ platform: "discord", id: "bad" }, { platform: "discord", id: "ok" }, { platform: "x", id: "skip" }],
    (p) => (p === "discord" ? adapter : undefined));
  assert.equal(out.length, 2, "a platform without describeChannel is skipped");
  assert.equal(out[0].error, "Missing Access");
  assert.equal(out[1].name, "#ok");
});

test("snowflakeTime — the creation time inside a Discord id", () => {
  // 175928847299117063 — приклад із документації Discord: 2016-04-30T11:18:25.796Z.
  assert.equal(snowflakeTime("175928847299117063").toISOString(), "2016-04-30T11:18:25.796Z");
  assert.equal(snowflakeTime(null), null);
  assert.equal(snowflakeTime("abc"), null);
});

// ── останнє «бачили» ───────────────────────────────────────────────────

test("SourceActivity — throttled per source, never moves back in time", async () => {
  const writes = [];
  let clock = NOW;
  const a = new SourceActivity({ Model: { touch: async (id, at) => writes.push([id, at.toISOString()]) }, minIntervalMs: 5 * 60_000, now: () => clock });
  assert.equal(await a.touch(1, NOW / 1000 - 60), true, "unix seconds, like Telegram");
  assert.equal(await a.touch(1, NOW / 1000 - 30), false, "too soon — remembered, not written");
  assert.equal(await a.touch(1, NOW / 1000 - 3_600), false, "older than what was written");
  clock += 6 * 60_000;
  assert.equal(await a.touch(1, NOW / 1000 - 20), true);
  assert.equal(await a.touch(2, null), true, "no time — now");
  assert.equal(await a.touch(null), false);
  assert.deepEqual(writes.map((w) => w[0]), [1, 1, 2]);
});

test("SourceState.touch — creates the row for any source and only moves forward", async () => {
  const [src] = await Source.findOrCreate({
    where: { channel_id: `${XID}src` },
    defaults: { platform: "telegram", channel_id: `${XID}src`, channel_name: "status test source", mode: "listener" },
  });
  assert.equal(await SourceState.touch(src.id, ago(10)), true);
  assert.equal(await SourceState.touch(src.id, ago(20)), false, "older is ignored");
  const state = await SourceState.findOne({ where: { source_id: src.id } });
  assert.equal(new Date(state.last_seen_at).toISOString(), ago(10).toISOString());
  assert.equal(state.last_message_id, null, "the polling checkpoint is untouched");
});

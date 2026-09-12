import test from "node:test";
import assert from "node:assert/strict";

import { positiveNumber } from "../src/config/app.config.js";
import TelegramSourceListener from "../src/sources/telegram/TelegramSourceListener.js";

// ── positiveNumber ────────────────────────────────────────────────────

test("positiveNumber — falls back instead of producing NaN", () => {
  const sink = [];
  assert.equal(positiveNumber("X", undefined, 5, sink), 5);
  assert.equal(positiveNumber("X", "", 5, sink), 5);
  assert.equal(positiveNumber("X", "   ", 5, sink), 5);
  assert.equal(positiveNumber("X", "abc", 5, sink), 5);
  assert.equal(positiveNumber("X", "0", 5, sink), 5);
  assert.equal(positiveNumber("X", "-3", 5, sink), 5);
  assert.equal(sink.length, 6, "кожен фолбек має лишити попередження");
});

test("positiveNumber — a valid value passes through untouched", () => {
  const sink = [];
  assert.equal(positiveNumber("X", "7", 5, sink), 7);
  assert.equal(positiveNumber("X", "0.5", 5, sink), 0.5);
  assert.equal(positiveNumber("X", 12, 5, sink), 12);
  assert.deepEqual(sink, [], "валідне значення не має попереджати");
});

test("positiveNumber — the reason a missing env var was dangerous", () => {
  // Регресія: Number(undefined) * 60 * 1000 === NaN, а setTimeout(fn, NaN)
  // виконується негайно — полінг перетворювався на потік запитів без пауз.
  assert.ok(Number.isNaN(Number(undefined) * 60 * 1000));
  const sink = [];
  const minutes = positiveNumber("POLLING_INTERVAL_MIN", undefined, 5, sink);
  assert.ok(Number.isFinite(minutes * 60 * 1000));
  assert.equal(minutes * 60 * 1000, 300_000);
});

// ── floodWaitSeconds ──────────────────────────────────────────────────

test("floodWaitSeconds — recognises a GramJS FloodWaitError", () => {
  class FloodWaitError extends Error {
    constructor(seconds) {
      super(`A wait of ${seconds} seconds is required`);
      this.seconds = seconds;
      this.className = "FloodWaitError";
    }
  }
  assert.equal(TelegramSourceListener.floodWaitSeconds(new FloodWaitError(300)), 300);
});

test("floodWaitSeconds — `seconds` alone is not enough", () => {
  // Інша помилка може нести поле `seconds`; трактувати її як flood означало б
  // зупинити полінг на рівному місці.
  const notFlood = Object.assign(new Error("timeout"), { seconds: 30 });
  assert.equal(TelegramSourceListener.floodWaitSeconds(notFlood), null);
});

test("floodWaitSeconds — rejects everything that is not a positive wait", () => {
  const f = TelegramSourceListener.floodWaitSeconds;
  assert.equal(f(null), null);
  assert.equal(f(undefined), null);
  assert.equal(f("FLOOD_WAIT_300"), null);
  assert.equal(f(Object.assign(new Error("flood"), { seconds: 0 })), null);
  assert.equal(f(Object.assign(new Error("flood"), { seconds: -1 })), null);
  assert.equal(f(Object.assign(new Error("flood"), { seconds: "abc" })), null);
  assert.equal(f(new Error("FLOOD_WAIT")), null, "без seconds чекати невідомо скільки");
});

// ── _runPollingCycle ──────────────────────────────────────────────────

/**
 * Слухач із підставленими каналами, без мережі й без БД.
 * Усі канали одразу due — планувальник опитує лише те, чий час настав.
 */
function makeListener(channels, { everyMs = 300_000 } = {}) {
  const events = [];
  const listener = new TelegramSourceListener({ emit: (n, p) => events.push([n, p]) });
  listener.isListening = true;
  const now = Date.now();
  for (const ch of channels) {
    listener.stateCache.set(ch.id, { last_message_id: 1, advance: async () => {} });
    listener.sourcesCache.set(ch.channel_id, ch);
    listener.pollDueAt.set(ch.id, now);
    listener.pollEveryMs.set(ch.id, everyMs);
  }
  listener._getSourceById = (id) => channels.find((c) => c.id === id) ?? null;
  return { listener, events };
}

const channel = (id, name) => ({
  id, channel_id: `-100${id}`, channel_name: name, mode: "polling",
});

test("_runPollingCycle — a FLOOD_WAIT aborts the cycle instead of hitting the next channel", async () => {
  const polled = [];
  const { listener, events } = makeListener([
    channel(1, "first"), channel(2, "second"), channel(3, "third"),
  ]);

  listener._pollChannel = async (source) => {
    polled.push(source.channel_name);
    if (source.channel_name === "second") {
      throw Object.assign(new Error("A wait of 300 seconds is required"), {
        seconds: 300, className: "FloodWaitError",
      });
    }
  };

  const backoffMs = await listener._runPollingCycle();

  // Ліміти Telegram — на акаунт, тож "third" чіпати не можна.
  assert.deepEqual(polled, ["first", "second"]);
  assert.equal(backoffMs, 300 * 1000 + 5_000, "наступний цикл відкладено на час флуду + запас");
  assert.equal(listener.isPolling, false, "прапорець знято навіть при ранньому виході");

  const errors = events.filter(([n]) => n === "error.occurred");
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].error, /FLOOD_WAIT 300s/);
});

test("_runPollingCycle — an ordinary error skips one channel and the cycle continues", async () => {
  const polled = [];
  const { listener, events } = makeListener([
    channel(1, "first"), channel(2, "second"), channel(3, "third"),
  ]);

  listener._pollChannel = async (source) => {
    polled.push(source.channel_name);
    if (source.channel_name === "second") throw new Error("network hiccup");
  };

  const backoffMs = await listener._runPollingCycle();

  assert.deepEqual(polled, ["first", "second", "third"], "звичайна помилка не зупиняє цикл");
  assert.equal(backoffMs, null, "наступний цикл планується як зазвичай");
  assert.equal(events.filter(([n]) => n === "error.occurred").length, 1);
});

test("_runPollingCycle — a clean cycle returns no backoff and clears isPolling", async () => {
  const { listener, events } = makeListener([channel(1, "only")]);
  listener._pollChannel = async () => {};

  assert.equal(await listener._runPollingCycle(), null);
  assert.equal(listener.isPolling, false);
  assert.deepEqual(events.filter(([n]) => n === "error.occurred"), []);
});

test("_runPollingCycle — refuses to overlap with a running cycle", async () => {
  const { listener } = makeListener([channel(1, "only")]);
  listener._pollChannel = async () => {};
  listener.isPolling = true;

  assert.equal(await listener._runPollingCycle(), null);
  assert.equal(listener.isPolling, true, "чужий цикл не чіпаємо");
});

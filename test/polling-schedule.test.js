import test from "node:test";
import assert from "node:assert/strict";

import {
  optionalNumber,
  POLLING_MAX_PER_TICK,
  POLLING_FETCH_LIMIT,
  POLLING_MAX_DRAIN_PAGES,
} from "../src/config/app.config.js";
import TelegramSourceListener from "../src/sources/telegram/TelegramSourceListener.js";
import { Source } from "../src/module/teapot/models/index.js";

// ── optionalNumber ────────────────────────────────────────────────────

test("optionalNumber — silent when unset, but still warns on garbage", () => {
  // Різниця з positiveNumber: опційна ручка з робочим дефолтом не має
  // засипати старт попередженнями. Але задане й невалідне — має.
  const sink = [];
  assert.equal(optionalNumber("TICK", undefined, 30, sink), 30);
  assert.equal(optionalNumber("TICK", "", 30, sink), 30);
  assert.deepEqual(sink, [], "незадане значення — тиша");

  assert.equal(optionalNumber("TICK", "abc", 30, sink), 30);
  assert.equal(sink.length, 1, "задане сміття — попередження");
});

// ── Source.getPollIntervalMin ─────────────────────────────────────────

test("getPollIntervalMin — NULL means the global default", () => {
  const s = Source.build({ platform: "telegram", channel_id: "-1", channel_name: "x" });
  assert.equal(s.poll_interval_min, null);
  assert.equal(s.getPollIntervalMin(5), 5);
});

test("getPollIntervalMin — a set value wins", () => {
  const s = Source.build({
    platform: "telegram", channel_id: "-2", channel_name: "y", poll_interval_min: 1440,
  });
  assert.equal(s.getPollIntervalMin(5), 1440);
});

test("getPollIntervalMin — zero and garbage fall back, never to a zero interval", () => {
  // Нульовий інтервал означав би due кожен тік без кінця. Краще дефолт.
  for (const bad of [0, -10, NaN, "abc", ""]) {
    const s = Source.build({
      platform: "telegram", channel_id: "-3", channel_name: "z", poll_interval_min: bad,
    });
    assert.equal(s.getPollIntervalMin(5), 5, `poll_interval_min=${JSON.stringify(bad)}`);
  }
});

// ── _phaseOffsetMs ────────────────────────────────────────────────────

const offset = TelegramSourceListener._phaseOffsetMs;

test("_phaseOffsetMs — stays inside the interval", () => {
  const everyMs = 24 * 60 * 60 * 1000;
  for (let id = 1; id <= 50; id++) {
    const o = offset(id, everyMs);
    assert.ok(o >= 0 && o < everyMs, `id=${id} -> ${o}`);
  }
});

test("_phaseOffsetMs — deterministic, so a restart reproduces the schedule", () => {
  assert.equal(offset(7, 3_600_000), offset(7, 3_600_000));
  assert.equal(offset("7", 3_600_000), offset(7, 3_600_000));
});

test("_phaseOffsetMs — spreads same-interval sources instead of stacking them", () => {
  // Це і є сенс зсуву: шість каналів "раз на добу", виставлених разом, без
  // нього назавжди лишаються синхронними — шість запитів в одну секунду.
  const dayMs = 24 * 60 * 60 * 1000;
  const ids = [1, 2, 3, 4, 5, 6];
  const offsets = ids.map((id) => offset(id, dayMs));
  assert.equal(new Set(offsets).size, ids.length, "жодних збігів");

  // І розкидані по добі, а не злиплі в одному її кутку.
  const buckets = new Set(offsets.map((o) => Math.floor(o / (dayMs / 6))));
  assert.ok(buckets.size >= 4, `розсіювання слабке: ${[...buckets].join(",")}`);
});

test("_phaseOffsetMs — a non-positive interval yields no offset", () => {
  assert.equal(offset(1, 0), 0);
  assert.equal(offset(1, -5), 0);
  assert.equal(offset(1, NaN), 0);
});

// ── _dueSources / _rescheduleSource ───────────────────────────────────

function bareListener() {
  return new TelegramSourceListener({ emit: () => {} });
}

test("_dueSources — only what is due, longest-overdue first", () => {
  const l = bareListener();
  const now = 1_000_000;
  l.pollDueAt.set("a", now - 10);       // прострочене
  l.pollDueAt.set("b", now - 5_000);    // прострочене сильніше
  l.pollDueAt.set("c", now + 60_000);   // ще не час

  assert.deepEqual(l._dueSources(now), ["b", "a"]);
});

test("_dueSources — caps the work per tick", () => {
  // Навіть якщо все стало due разом (рестарт, довгий FLOOD_WAIT), один тік
  // обмежений: решта сповзає на наступний.
  const l = bareListener();
  const now = 1_000_000;
  for (let i = 0; i < POLLING_MAX_PER_TICK + 5; i++) l.pollDueAt.set(i, now - i);
  assert.equal(l._dueSources(now).length, POLLING_MAX_PER_TICK);
});

test("_dueSources — a starved source eventually wins", () => {
  // Сортування за простроченістю — не косметика: без нього джерело з коротким
  // інтервалом витісняло б те, що чекає з минулого тіку, безкінечно.
  const l = bareListener();
  const now = 1_000_000;
  for (let i = 0; i < POLLING_MAX_PER_TICK; i++) l.pollDueAt.set(`fresh${i}`, now - 1);
  l.pollDueAt.set("starved", now - 999_999);
  assert.ok(l._dueSources(now).includes("starved"));
});

test("_rescheduleSource — first reschedule adds the phase offset, later ones do not", () => {
  const l = bareListener();
  const everyMs = 600_000;
  l.pollEveryMs.set(42, everyMs);
  const now = 5_000_000;

  l._rescheduleSource(42, now);
  const first = l.pollDueAt.get(42) - now;
  assert.equal(first, everyMs + offset(42, everyMs));

  l._rescheduleSource(42, now);
  assert.equal(l.pollDueAt.get(42) - now, everyMs, "далі інтервал рівний");
});

test("_rescheduleSource — an unknown source falls back to the global interval", () => {
  const l = bareListener();
  const now = 1_000;
  l._rescheduleSource("ghost", now);
  assert.ok(l.pollDueAt.get("ghost") > now, "щось запланувати все одно треба");
});

// ── інтеграція: хто опитується в якому тіку ───────────────────────────

test("cycle — a source is not polled again until its own interval elapses", async () => {
  const events = [];
  const l = new TelegramSourceListener({ emit: (n, p) => events.push([n, p]) });
  l.isListening = true;

  const fast = { id: 1, channel_id: "-1", channel_name: "fast", mode: "polling" };
  const slow = { id: 2, channel_id: "-2", channel_name: "slow", mode: "polling" };
  for (const s of [fast, slow]) {
    l.stateCache.set(s.id, { last_message_id: 1, advance: async () => {} });
  }
  l._getSourceById = (id) => [fast, slow].find((s) => s.id === id) ?? null;
  l.pollEveryMs.set(fast.id, 60_000);          // щохвилини
  l.pollEveryMs.set(slow.id, 24 * 3_600_000);  // раз на добу

  const now = Date.now();
  l.pollDueAt.set(fast.id, now);
  l.pollDueAt.set(slow.id, now);

  const polled = [];
  l._pollChannel = async (source) => { polled.push(source.channel_name); };

  // Перший тік: due обидва.
  await l._runPollingCycle();
  assert.deepEqual(polled.sort(), ["fast", "slow"]);

  // Другий тік одразу по тому: не due жоден.
  polled.length = 0;
  await l._runPollingCycle();
  assert.deepEqual(polled, [], "інтервал ще не пройшов");

  // Зсуваємо час так, щоб настав час лише швидкого.
  l.pollDueAt.set(fast.id, Date.now() - 1);
  await l._runPollingCycle();
  assert.deepEqual(polled, ["fast"], "повільний чекає свою добу");
});

test("cycle — a source missing from the caches is dropped from the schedule", async () => {
  // Інакше воно лишається due назавжди й марно займає місце в стелі тіку.
  const l = new TelegramSourceListener({ emit: () => {} });
  l.isListening = true;
  l._getSourceById = () => null;
  l.pollDueAt.set(99, Date.now());

  await l._runPollingCycle();
  assert.equal(l.pollDueAt.has(99), false);
});

// ── наздогін сторінками у _pollChannel ────────────────────────────────

/**
 * Слухач із фейковим Telegram: канал має `total` повідомлень з id 2..total+1,
 * getMessages віддає сторінку після offsetId, не довше за limit.
 */
function makeDraining(total) {
  const l = new TelegramSourceListener({ emit: () => {} });
  const all = Array.from({ length: total }, (_, i) => ({ id: i + 2 }));
  const calls = [];
  l.client = {
    getMessages: async (_chan, { limit, offsetId }) => {
      calls.push({ limit, offsetId });
      return all.filter((m) => m.id > offsetId).slice(0, limit);
    },
  };
  l._parser = { parseRaw: (msg) => ({ messageId: msg.id }) };
  l._routeIncoming = async () => {};
  const state = {
    last_message_id: 1,
    advance: async function (id) { this.last_message_id = id; },
  };
  const source = { id: 1, channel_id: "-1", channel_name: "busy", mode: "polling" };
  return { listener: l, state, source, calls };
}

test("_pollChannel — a single partial page ends the drain", async () => {
  const { listener, state, source, calls } = makeDraining(3);
  await listener._pollChannel(source, state);
  assert.equal(calls.length, 1, "неповна сторінка — більше не питаємо");
  assert.equal(state.last_message_id, 4);
});

test("_pollChannel — drains several pages so a long interval cannot fall behind", async () => {
  // Це і є причина сторінкового наздогону: канал з інтервалом "раз на добу"
  // і лімітом 50 інакше забирає 50 на тік і відстає назавжди.
  const total = POLLING_FETCH_LIMIT * 2 + 7;
  const { listener, state, source, calls } = makeDraining(total);
  await listener._pollChannel(source, state);
  assert.equal(calls.length, 3, "дві повні сторінки + хвіст");
  assert.equal(state.last_message_id, total + 1, "канал вичерпано повністю");
});

test("_pollChannel — the drain is capped, the rest waits for the next tick", async () => {
  const total = POLLING_FETCH_LIMIT * (POLLING_MAX_DRAIN_PAGES + 3);
  const { listener, state, source, calls } = makeDraining(total);
  await listener._pollChannel(source, state);
  assert.equal(calls.length, POLLING_MAX_DRAIN_PAGES, "один тік лишається обмеженим");
  assert.equal(state.last_message_id, POLLING_FETCH_LIMIT * POLLING_MAX_DRAIN_PAGES + 1);

  // Прогрес зберігся — наступний тік продовжить, а не почне спочатку.
  calls.length = 0;
  await listener._pollChannel(source, state);
  assert.equal(calls[0].offsetId, POLLING_FETCH_LIMIT * POLLING_MAX_DRAIN_PAGES + 1);
});

test("_pollChannel — an empty channel costs exactly one request", async () => {
  const { listener, state, source, calls } = makeDraining(0);
  await listener._pollChannel(source, state);
  assert.equal(calls.length, 1);
  assert.equal(state.last_message_id, 1, "чекпоінт не зрушив");
});

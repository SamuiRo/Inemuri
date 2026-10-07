import test from "node:test";
import assert from "node:assert/strict";

import EventBus from "../src/module/eventbus/EventBus.js";
import CronScheduler from "../src/module/cron/CronScheduler.js";
import { dropsInfo, formatDailyReport, createDailyJob, GAME_DROPS } from "../src/module/cron/dailyReport.js";

const METRICS = {
  btc_dominance: 55.123, btc_dominance_yesterday: 54.9, defi_24h_percentage_change: -1.25,
};
const BTC = { quote: { USD: { price: 61234.56, percent_change_24h: 2.04 } } };
const FNG = { classification: "Greed", value: 71 };

test("dropsInfo: today, tomorrow, in N days", () => {
  // 2026-10-07 is a Wednesday (CS2 drop day), TF2 drops Thursday.
  const wed = new Date("2026-10-07T12:00:00");
  assert.deepEqual(dropsInfo(wed).map((d) => [d.game, d.status]), [["CS2", "Сьогодні"], ["TF2", "Завтра"]]);
  const fri = new Date("2026-10-09T12:00:00");
  assert.deepEqual(dropsInfo(fri).map((d) => d.status), ["in 5 days", "in 6 days"]);
  assert.equal(GAME_DROPS.length, 2);
});

test("formatDailyReport: the numbers and the drops table; null without data", () => {
  const text = formatDailyReport({ globalMetrics: METRICS, btcStat: BTC, fearAndGreed: FNG, drops: dropsInfo(new Date("2026-10-07T12:00:00")) });
  assert.match(text, /BTC \| Price: \$61234\.6 \| 24h: 2\.0%/);
  assert.match(text, /BTC\.D: 55\.1% \| Yesterday: 54\.9%/);
  assert.match(text, /🔴 DeFi 24h: -1\.3%/);
  assert.match(text, /Greed: 71\/100/);
  assert.match(text, /CS2  \| Сьогодні/);
  assert.equal(formatDailyReport({ globalMetrics: METRICS, btcStat: null, fearAndGreed: FNG }), null);
});

test("createDailyJob: builds the message from injected data, null when a source fails", async () => {
  const crypto = { getGlobalMetrics: async () => METRICS, findToken: async () => BTC, getFearAndGreedIndex: async () => FNG };
  const job = createDailyJob({
    crypto, loadImage: async () => ({ type: "photo" }), destinations: { telegram: ["-1001"] }, schedule: "5 0 * * *",
    now: () => new Date("2026-10-07T12:00:00"),
  });
  assert.equal(job.id, "dailyinfo");
  const md = await job.handler();
  assert.deepEqual(md.source.destinations, { telegram: ["-1001"] });
  assert.equal(md.downloadedMedia.length, 1);
  assert.equal(md.metadata.fearAndGreed, 71);

  const broken = createDailyJob({ ...{ crypto: { ...crypto, findToken: async () => null } }, loadImage: async () => null, destinations: {}, schedule: "x" });
  assert.equal(await broken.handler(), null);
});

test("CronScheduler: cron.run on the bus runs a job and emits message.received", async () => {
  const bus = new EventBus();
  const scheduler = new CronScheduler(bus);
  const received = [];
  bus.on("message.received", (m) => received.push(m));
  scheduler.scheduleJob({ id: "j1", schedule: "0 0 1 1 *", description: "test", handler: async () => ({ text: "hi", source: { destinations: {} } }) });
  scheduler.scheduleJob({ id: "empty", schedule: "0 0 1 1 *", description: "test", handler: async () => null });
  try {
    assert.equal(await bus.request("cron.run", { id: "j1", triggeredBy: "op" }), true);
    assert.equal(received.length, 1);
    assert.equal(received[0].metadata.cronJobId, "j1");
    assert.equal(received[0].metadata.source, "discord-command");
    assert.equal(await bus.request("cron.run", { id: "empty" }), false);
    assert.equal(await bus.request("cron.run", { id: "missing" }), false);
  } finally {
    await scheduler.stop();
  }
});

test("CronScheduler: a failing job reports, does not throw", async () => {
  const bus = new EventBus();
  const scheduler = new CronScheduler(bus);
  const errors = [];
  bus.on("error.occurred", (e) => errors.push(e));
  scheduler.scheduleJob({ id: "boom", schedule: "0 0 1 1 *", description: "test", handler: async () => { throw new Error("nope"); } });
  try {
    assert.equal(await scheduler.runJob("boom"), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error, "nope");
  } finally {
    await scheduler.stop();
  }
});

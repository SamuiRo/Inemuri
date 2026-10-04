import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../src/module/teapot/models/index.js";
import DeltaStage from "../src/module/theflow/dedup/DeltaStage.js";
import FlowDelivery, { MAX_APPENDS } from "../src/module/theflow/delivery/FlowDelivery.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
const XID = `__dl_${process.pid}_`;
const routing = {
  unsorted_destinations: { telegram: ["-100unsorted"] },
  routing: [{ priority: 1, when: { topic: "steam" }, destinations: { telegram: ["-100steam"] } }],
};
let src;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  [src] = await Source.findOrCreate({
    where: { channel_id: `${XID}src` },
    defaults: { platform: "telegram", channel_id: `${XID}src`, channel_name: "Delta Src", flow: { enabled: true } },
  });
});
async function cleanup() {
  const rows = await Post.findAll({ where: { source_id: src.id }, attributes: ["id", "cluster_id"] });
  const cids = [...new Set(rows.map((r) => r.cluster_id).filter(Boolean))];
  if (rows.length) await Post.destroy({ where: { id: rows.map((r) => r.id) } });
  if (cids.length) await Cluster.destroy({ where: { id: cids } });
}
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await Source.destroy({ where: { id: src.id } });
  await database.disconnect();
});

let seq = 0;
async function post(over = {}) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: src.id, platform: "telegram", external_id: `${XID}${seq}`, channel_id: "-1002222222222",
    raw_text: `Body ${seq}`, text_md: `Body ${seq}`, text_hash: `${XID}h${seq}`,
    status: "enriched", topic: "steam", signal_type: "event", confidence: 0.9, text_en: `Text ${seq}`,
    attempts: 1, posted_at: new Date(), dedup: { decision: "join" }, ...over,
  });
  return p;
}

async function clusterWith({ delivered = [], appends = 0, signal = "event" } = {}) {
  const canonical = await post({ link_role: "canonical", signal_type: signal, dedup: { decision: "new" } });
  const cluster = await Cluster.create({
    canonical_post_id: canonical.id, topic: "steam", signal_type: signal, members_count: 2,
    delivered, appends_count: appends,
  });
  await canonical.update({ cluster_id: cluster.id });
  return { canonical, cluster };
}

const fakeGateway = (answer) => ({
  calls: 0,
  async delta() { this.calls++; if (answer instanceof Error) throw answer; return typeof answer === "function" ? answer() : answer; },
});

// ── DeltaStage ─────────────────────────────────────────────────────────────

test("delta: `same` suppresses, `adds` stays linked, `denies` becomes a correction and closes the cluster", async () => {
  const { cluster } = await clusterWith();
  const same = await post({ cluster_id: cluster.id, link_role: "linked" });
  await new DeltaStage({ gateway: fakeGateway({ relation: "same", adds: [], confidence: 0.9, model_used: "m" }) }).runOnce();
  const S = await Post.findByPk(same.id);
  assert.equal(S.link_role, "duplicate");
  assert.equal(S.status, "suppressed");
  assert.equal(S.adds.relation, "same");

  const adds = await post({ cluster_id: cluster.id, link_role: "linked" });
  await new DeltaStage({ gateway: fakeGateway({ relation: "adds", adds: [{ kind: "date", text: "Fri 18:00" }], confidence: 0.8 }) }).runOnce();
  const A = await Post.findByPk(adds.id);
  assert.equal(A.link_role, "linked");
  assert.equal(A.adds.adds[0].text, "Fri 18:00");

  const denies = await post({ cluster_id: cluster.id, link_role: "linked" });
  await new DeltaStage({ gateway: fakeGateway({ relation: "denies", adds: [{ kind: "detail", text: "cancelled" }], confidence: 0.9 }) }).runOnce();
  assert.equal((await Post.findByPk(denies.id)).link_role, "correction");
  assert.equal((await Cluster.findByPk(cluster.id)).closed, true);
});

test("delta: security is never suppressed, even as `same`", async () => {
  const { cluster } = await clusterWith({ signal: "security" });
  const p = await post({ cluster_id: cluster.id, link_role: "linked", signal_type: "security" });
  await new DeltaStage({ gateway: fakeGateway({ relation: "same", adds: [], confidence: 0.9 }) }).runOnce();
  const P = await Post.findByPk(p.id);
  assert.equal(P.link_role, "linked");
  assert.equal(P.status, "enriched");
});

test("delta: a shed stops the batch without an attempt; errors retry up to the cap", async () => {
  const { cluster } = await clusterWith();
  const p = await post({ cluster_id: cluster.id, link_role: "linked" });
  await new DeltaStage({ gateway: fakeGateway({ shed: true }) }).runOnce();
  assert.equal((await Post.findByPk(p.id)).adds, null);

  const failing = new DeltaStage({ gateway: fakeGateway(new Error("500")), maxAttempts: 2 });
  await failing.runOnce();
  assert.equal((await Post.findByPk(p.id)).adds.attempts, 1);
  await failing.runOnce();
  assert.equal((await Post.findByPk(p.id)).adds.attempts, 2);
  assert.equal((await failing.candidates()).length, 0, "attempts exhausted");
});

// ── FlowDelivery: оновлення надісланого ───────────────────────────────────

function fakeTransport({ editFails = false } = {}) {
  const edits = [];
  const sends = [];
  let n = 1000;
  return {
    edits, sends,
    edit: async (platform, channelId, messageId, md) => {
      if (editFails) throw new Error("MESSAGE_ID_INVALID");
      edits.push({ platform, channelId, messageId, md });
    },
    sendTo: async (platform, channelId, md) => {
      sends.push({ platform, channelId, md });
      return { platform, channel_id: channelId, message_id: ++n };
    },
    route: async () => [],
  };
}
const TG = { platform: "telegram", channel_id: "-100steam", message_id: 77 };

test("an addition re-renders and edits every delivered message, then counts toward the cap", async () => {
  const { cluster } = await clusterWith({ delivered: [TG] });
  const p = await post({ cluster_id: cluster.id, link_role: "linked",
    adds: { relation: "adds", adds: [{ kind: "date", text: "Fri 18:00", text_uk: "пт 18:00" }], confidence: 0.8 } });
  const t = fakeTransport();
  const d = new FlowDelivery({ ...t, routing });

  assert.equal(await d.refreshOnce(), 1);
  assert.equal(t.edits.length, 1);
  assert.equal(t.edits[0].messageId, 77);
  assert.match(t.edits[0].md.rawText, /➕ пт 18:00/);
  assert.equal(t.sends.length, 0, "an addition is an edit, not a new message");
  assert.equal((await Cluster.findByPk(cluster.id)).appends_count, 1);
  const P = await Post.findByPk(p.id);
  assert.ok(P.adds.applied_at);
  assert.equal(P.adds.applied[0].mode, "edit");
  assert.equal(await d.refreshOnce(), 0, "applied once");
});

test("past the cap an addition is not edited in — only counted", async () => {
  const { cluster } = await clusterWith({ delivered: [TG], appends: MAX_APPENDS });
  const p = await post({ cluster_id: cluster.id, link_role: "linked",
    adds: { relation: "adds", adds: [{ kind: "detail", text: "more" }], confidence: 0.8 } });
  const t = fakeTransport();
  await new FlowDelivery({ ...t, routing }).refreshOnce();
  assert.equal(t.edits.length, 0);
  assert.equal((await Post.findByPk(p.id)).adds.applied[0].mode, "capped");
});

test("a denial ignores the cap: the message is edited AND a reply with the denial is sent", async () => {
  const { cluster } = await clusterWith({ delivered: [TG], appends: MAX_APPENDS });
  const p = await post({ cluster_id: cluster.id, link_role: "correction",
    adds: { relation: "denies", adds: [{ kind: "detail", text: "cancelled", text_uk: "скасовано" }], confidence: 0.9 } });
  const t = fakeTransport();
  await new FlowDelivery({ ...t, routing }).refreshOnce();
  assert.equal(t.edits.length, 1);
  assert.match(t.edits[0].md.rawText, /⛔ Denied: скасовано/);
  assert.equal(t.sends.length, 1);
  assert.equal(t.sends[0].md.replyTo, 77, "the denial replies to the original, so it notifies");
  assert.match(t.sends[0].md.rawText, /⛔ Denied: скасовано/);
  const modes = (await Post.findByPk(p.id)).adds.applied.map((x) => x.mode);
  assert.deepEqual(modes, ["edit", "notice"]);
});

test("a failed edit falls back to a reply carrying the re-rendered message", async () => {
  const { cluster } = await clusterWith({ delivered: [TG] });
  await post({ cluster_id: cluster.id, link_role: "linked",
    adds: { relation: "adds", adds: [{ kind: "detail", text: "x" }], confidence: 0.8 } });
  const t = fakeTransport({ editFails: true });
  const results = await new FlowDelivery({ ...t, routing }).refreshCluster(cluster.id,
    await Post.findAll({ where: { cluster_id: cluster.id, link_role: "linked" } }));
  assert.equal(results[0].mode, "reply");
  assert.match(results[0].error, /MESSAGE_ID_INVALID/);
  assert.equal(t.sends[0].md.replyTo, 77);
});

test("before the cluster is delivered an update is only marked — the first render includes it", async () => {
  const { cluster } = await clusterWith({ delivered: [] });
  const p = await post({ cluster_id: cluster.id, link_role: "linked",
    adds: { relation: "adds", adds: [{ kind: "detail", text: "x" }], confidence: 0.8 } });
  const t = fakeTransport();
  await new FlowDelivery({ ...t, routing }).refreshOnce();
  assert.equal(t.edits.length + t.sends.length, 0);
  assert.equal((await Post.findByPk(p.id)).adds.applied[0].mode, "before_delivery");
});

test("a new canonical in a delivered cluster rewrites the message instead of sending a second one", async () => {
  const { canonical: old, cluster } = await clusterWith({ delivered: [TG] });
  const richer = await post({ cluster_id: cluster.id, link_role: "canonical", raw_text: "Much richer body" });
  await cluster.update({ canonical_post_id: richer.id });
  await old.update({ link_role: "linked", delivery: { outcome: "routed" }, status: "routed" });

  const t = fakeTransport();
  const d = new FlowDelivery({ ...t, routing });
  await d.runOnce();
  assert.equal(t.edits.length, 1);
  assert.match(t.edits[0].md.rawText, /Much richer body/);
  const R = await Post.findByPk(richer.id);
  assert.equal(R.delivery.rewrote_cluster, cluster.id);
  assert.equal(R.status, "routed");
});

test("delta: a quota error stops the batch without an attempt, like a shed", async () => {
  const { cluster } = await clusterWith();
  const p = await post({ cluster_id: cluster.id, link_role: "linked" });
  const quota = Object.assign(new Error("daily quota"), { kind: "quota" });
  await new DeltaStage({ gateway: fakeGateway(quota) }).runOnce();
  assert.equal((await Post.findByPk(p.id)).adds, null);
});

test("Telegram: a caption over the limit is cut and its entities clipped to it", async () => {
  const { default: TelegramDestination, clipEntities } = await import("../src/destinations/telegram/TelegramDestination.js");
  const { Api } = await import("telegram");
  const bold = new Api.MessageEntityBold({ offset: 5, length: 10 });
  const clipped = clipEntities([bold, new Api.MessageEntityItalic({ offset: 20, length: 3 })], 10);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].length, 5);
  assert.equal(clipped[0].className, "MessageEntityBold");
  assert.equal(bold.length, 10, "the original entity is not mutated");

  const tg = Object.create(TelegramDestination.prototype);
  tg.limits = { caption: 1024 };
  tg.prepareMediaForSend = async (m) => m;
  let sent;
  tg.sendSingleMedia = async (entity, media, caption, options) => { sent = { caption, options }; return { id: 1 }; };
  await tg.sendWithMedia({}, "y".repeat(2000), [{ type: "photo", data: Buffer.from("x") }], {
    formattingEntities: [new Api.MessageEntityBold({ offset: 1000, length: 100 }), new Api.MessageEntityBold({ offset: 1500, length: 5 })],
  });
  assert.equal(sent.caption.length, 1024);
  assert.equal(sent.options.formattingEntities.length, 1);
  const e = sent.options.formattingEntities[0];
  assert.ok(e.offset + e.length <= 1024);
});

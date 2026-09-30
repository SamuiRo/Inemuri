import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { Post, Source, Cluster } from "../src/module/teapot/models/index.js";
import HistorySearch from "../src/module/theflow/search/HistorySearch.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Слова-маркери з XID не зустрічаються в інших наборах, тож FTS бачить лише свої.
const XID = `zq${process.pid}`;
let src;
let clusterId;

const vec = (...xs) => {
  const v = Float32Array.from(xs);
  const n = Math.hypot(...v);
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return Buffer.from(v.buffer);
};

let seq = 0;
async function post(over) {
  seq += 1;
  const [p] = await Post.ingest({
    source_id: src.id, platform: "telegram", external_id: String(700000 + seq),
    channel_id: "-1009876543210", raw_text: "", text_md: "",
    text_hash: `${XID}h${seq}`, status: "enriched", topic: "steam", signal_type: "event",
    attempts: 1, posted_at: new Date(), ...over,
  });
  return p;
}

test.before(async () => {
  assertTestDatabase();
  await database.connect();
  [src] = await Source.findOrCreate({
    where: { channel_id: `${XID}src` },
    defaults: { platform: "telegram", channel_id: `${XID}src`, channel_name: "Search Src", flow: { enabled: true } },
  });
  const c = await Cluster.create({ topic: "steam", signal_type: "event", members_count: 2 });
  clusterId = c.id;

  await post({ text_en: `Giving away AWP Asiimov ${XID}alpha`, raw_text: `Розыгрыш AWP Азимов ${XID}alpha`,
    cluster_id: clusterId, embedding: vec(1, 0, 0), embedding_model: "emb", embedding_dim: 3 });
  await post({ text_en: `AWP Asiimov giveaway, second channel ${XID}alpha`, cluster_id: clusterId,
    embedding: vec(0.95, 0.3, 0), embedding_model: "emb", embedding_dim: 3 });
  await post({ text_en: `Hamster airdrop snapshot ${XID}alpha`, topic: "airdrop", signal_type: "launch",
    embedding: vec(0, 1, 0), embedding_model: "emb", embedding_dim: 3 });
  await post({ raw_text: `Blacklisted noise ${XID}alpha`, status: "skipped_blacklist", topic: null, signal_type: null });
  await post({ text_en: `Old news ${XID}alpha`, posted_at: new Date(Date.now() - 40 * 86_400_000),
    embedding: vec(1, 0, 0), embedding_model: "emb", embedding_dim: 3 });
});

test.after(async () => {
  await Post.destroy({ where: { source_id: src.id } });
  await Cluster.destroy({ where: { id: clusterId } });
  await Source.destroy({ where: { id: src.id } });
  await database.disconnect();
});

test("keyword: finds by the original or the translation, collapses the cluster, skips skipped_*", async () => {
  const s = new HistorySearch();
  const r = await s.search({ query: `${XID}alpha` });
  const texts = r.results.map((x) => x.snippet);
  assert.equal(r.results.length, 3, "cluster of 2 → one row; blacklisted excluded");
  assert.ok(!texts.some((t) => t.includes("Blacklisted")));
  const awp = r.results.find((x) => x.members === 2);
  assert.ok(awp, "the cluster row carries members_count");
  assert.equal(awp.source, "Search Src");
  assert.match(awp.link, /^https:\/\/t\.me\/c\/9876543210\/\d+$/);

  const cyr = await s.search({ query: `азимов ${XID}alpha` });
  assert.equal(cyr.results.length, 1, "Cyrillic, case-folded, prefix-matched in raw_text");
  assert.match(r.text, /🔎 keyword/);
});

test("keyword filters: topic, signal, days", async () => {
  const s = new HistorySearch();
  assert.equal((await s.search({ query: `${XID}alpha`, topic: "airdrop" })).results.length, 1);
  assert.equal((await s.search({ query: `${XID}alpha`, signal: "launch" })).results.length, 1);
  const recent = await s.search({ query: `${XID}alpha`, days: 7 });
  assert.ok(!recent.results.some((x) => x.snippet.startsWith("Old news")));
});

test("the index follows inserts, updates and deletes (triggers)", async () => {
  const s = new HistorySearch();
  const p = await post({ text_en: `Fresh ${XID}beta` });
  assert.equal((await s.search({ query: `${XID}beta` })).results.length, 1);
  await p.update({ text_en: `Renamed ${XID}gamma` });
  assert.equal((await s.search({ query: `${XID}beta` })).results.length, 0);
  assert.equal((await s.search({ query: `${XID}gamma` })).results.length, 1);
  await p.destroy();
  assert.equal((await s.search({ query: `${XID}gamma` })).results.length, 0);
});

test("semantic: cosine over the same model, window, collapse; shed and no gateway are explained", async () => {
  const gateway = { embed: async () => ({ vector: new Float32Array(new Uint8Array(vec(1, 0.05, 0)).buffer), model: "emb", dim: 3 }) };
  const s = new HistorySearch({ gateway });
  const r = await s.search({ query: "free sniper skin", mode: "semantic" });
  assert.ok(r.results.length >= 1);
  assert.equal(r.results[0].members, 2, "best match is the AWP cluster, collapsed");
  assert.ok(r.results[0].score > 0.9);
  assert.ok(r.results.some((x) => x.snippet.startsWith("Old news")), "no default window: history is searchable");
  assert.equal(r.note, null);
  const recent = await s.search({ query: "free sniper skin", mode: "semantic", days: 7 });
  assert.ok(!recent.results.some((x) => x.snippet.startsWith("Old news")), "days still filters");

  const shed = await new HistorySearch({ gateway: { embed: async () => ({ shed: true }) } })
    .search({ query: "x", mode: "semantic" });
  assert.match(shed.error, /quota is reserved/);
  const none = await new HistorySearch().search({ query: "x", mode: "semantic" });
  assert.match(none.error, /needs the LLM gateway/);
});

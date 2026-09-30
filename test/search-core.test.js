import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFtsQuery, telegramLink, snippet, collapseByCluster, clampLimit, formatResults,
} from "../src/module/theflow/search/HistorySearch.js";
import EventBus from "../src/module/eventbus/EventBus.js";

test("buildFtsQuery quotes every word as a prefix and ANDs them", () => {
  assert.equal(buildFtsQuery("Hamster airdrop"), '"hamster"* "airdrop"*');
  assert.equal(buildFtsQuery("$ARB"), '"arb"*');
  assert.equal(buildFtsQuery('розыгрыш "AWP" OR NEAR(x)'), '"розыгрыш"* "awp"* "or"* "near"*');
  assert.equal(buildFtsQuery("a ! ?"), null);
  assert.equal(buildFtsQuery(""), null);
  assert.equal(buildFtsQuery("aa bb cc dd ee ff gg hh ii jj kk").split(" ").length, 8, "at most 8 words");
});

test("telegramLink: private-channel link for -100 ids, external_url otherwise", () => {
  assert.equal(telegramLink({ channel_id: "-1001234567890", external_id: "42" }), "https://t.me/c/1234567890/42");
  assert.equal(telegramLink({ channel_id: "@name", external_id: "42" }), null);
  assert.equal(telegramLink({ platform: "reddit", external_url: "https://reddit.com/x" }), "https://reddit.com/x");
});

test("snippet, clampLimit", () => {
  assert.equal(snippet("a\n\n b"), "a b");
  assert.equal(snippet("x".repeat(200), 10), "x".repeat(9) + "…");
  assert.equal(clampLimit(undefined), 10);
  assert.equal(clampLimit(100), 25);
  assert.equal(clampLimit("3"), 3);
});

test("collapseByCluster keeps the best-ranked post of each event", () => {
  const rows = [
    { id: 1, cluster_id: 7 }, { id: 2, cluster_id: 7 }, { id: 3, cluster_id: null },
    { id: 4, cluster_id: null }, { id: 5, cluster_id: 8 },
  ];
  assert.deepEqual(collapseByCluster(rows, 10).map((r) => r.id), [1, 3, 4, 5]);
  assert.deepEqual(collapseByCluster(rows, 2).map((r) => r.id), [1, 3]);
});

test("formatResults", () => {
  const res = {
    mode: "keyword", query: "awp", filtersText: "topic steam", results: [{
      id: 5, when: "2026-05-12T10:00:00.000Z", topic: "steam", signal_type: "event", source: "Chan",
      members: 3, score: 1, snippet: "Giving away AWP", link: "https://t.me/c/1/2",
    }],
  };
  assert.equal(formatResults(res),
    '🔎 keyword · "awp" · topic steam\n**#5** 2026-05-12 · steam/event · Chan · ×3\n> Giving away AWP\n<https://t.me/c/1/2>');
  assert.match(formatResults({ ...res, results: [] }), /Nothing found\./);
  assert.match(formatResults({ ...res, error: "boom" }), /❌ boom/);
  assert.match(formatResults({ ...res, mode: "semantic", results: [{ ...res.results[0], score: 0.8123 }] }), /s=0\.81/);
});

test("EventBus request/reply: answers, refuses a second handler, reports a missing one, times out", async () => {
  const bus = new EventBus();
  bus.handle("x.echo", async (d) => ({ got: d }));
  assert.deepEqual(await bus.request("x.echo", 1), { got: 1 });
  assert.throws(() => bus.handle("x.echo", () => 1), /already registered/);
  await assert.rejects(bus.request("x.none", 1), /nothing handles "x.none"/);
  bus.handle("x.slow", () => new Promise((r) => setTimeout(r, 200)));
  await assert.rejects(bus.request("x.slow", 1, { timeoutMs: 20 }), /timed out/);
  bus.handle("x.throws", () => { throw new Error("inner"); });
  await assert.rejects(bus.request("x.throws"), /inner/);
});

test("/search sends the options over the bus and returns the text", async () => {
  const { default: search } = await import("../src/module/discordapp/commands/search.js");
  const json = search.data.toJSON();
  assert.equal(json.name, "search");
  assert.equal(search.admin, true);
  assert.ok(json.options.find((o) => o.name === "topic").choices.some((c) => c.value === "steam"));

  const bus = new EventBus();
  let got;
  bus.handle("theflow.search", (q) => { got = q; return { text: "result text" }; });
  const values = { query: "awp", mode: null, topic: "steam", signal: null, days: 7, limit: null };
  const interaction = {
    options: { getString: (n) => values[n] ?? null, getInteger: (n) => values[n] ?? null },
  };
  const out = await search.execute(interaction, { eventBus: bus });
  assert.equal(out, "result text");
  assert.deepEqual(got, { query: "awp", mode: "keyword", topic: "steam", signal: null, days: 7, limit: null });
});

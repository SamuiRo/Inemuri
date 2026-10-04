import test from "node:test";
import assert from "node:assert/strict";

import {
  resolve,
  validateRouting,
  orderRules,
  matchesWhen,
  RESOLVE_REASONS as R,
} from "../src/module/theflow/ResolveStage.js";
import { CATEGORIES } from "../src/config/app.config.js";

const UNSORTED = { telegram: ["-1009990001"] };

const routing = (rules) => ({ unsorted_destinations: UNSORTED, routing: rules });

const post = (over = {}) => ({
  status: "enriched", topic: "steam", signal_type: "promo_code", confidence: 0.9, ...over,
});

const FLOW = { topics: null, min_confidence: 0.6 };

// ── правила специфікації ──────────────────────────────────────────────

test("rule 2 — the first matching rule supplies the destinations", () => {
  const r = resolve({
    post: post(),
    flow: FLOW,
    routing: routing([
      { when: { topic: "steam", signal_type: "promo_code" }, destinations: { telegram: ["-100promo"] } },
    ]),
  });
  assert.equal(r.outcome, "routed");
  assert.equal(r.reason, R.MATCHED_RULE);
  assert.deepEqual(r.destinations, { telegram: ["-100promo"] });
});

test("rule 1 — rules are evaluated in descending priority", () => {
  const r = resolve({
    post: post(),
    flow: FLOW,
    routing: routing([
      { when: { topic: "steam" }, destinations: { telegram: ["-100broad"] }, priority: 1 },
      { when: { topic: "steam", signal_type: "promo_code" }, destinations: { telegram: ["-100narrow"] }, priority: 10 },
    ]),
  });
  assert.deepEqual(r.destinations, { telegram: ["-100narrow"] }, "вищий пріоритет, хоч і другий у списку");
  assert.deepEqual(r.rule, { index: 1, priority: 10 });
});

test("rule 1 — equal priority keeps config order (stable)", () => {
  const r = resolve({
    post: post(),
    flow: FLOW,
    routing: routing([
      { when: { topic: "steam" }, destinations: { telegram: ["-100first"] }, priority: 5 },
      { when: { topic: "steam" }, destinations: { telegram: ["-100second"] }, priority: 5 },
    ]),
  });
  assert.deepEqual(r.destinations, { telegram: ["-100first"] });
});

test("rule 3 — nothing matches, falls through to unsorted", () => {
  const r = resolve({
    post: post({ topic: "crypto" }),
    flow: FLOW,
    routing: routing([{ when: { topic: "steam" }, destinations: { telegram: ["-100x"] } }]),
  });
  assert.equal(r.outcome, "unsorted");
  assert.equal(r.reason, R.NO_RULE);
  assert.deepEqual(r.destinations, UNSORTED);
});

test("rule 4 — low confidence goes to unsorted REGARDLESS of a match", () => {
  const r = resolve({
    post: post({ confidence: 0.4 }),
    flow: FLOW,
    routing: routing([{ when: { topic: "steam" }, destinations: { telegram: ["-100x"] }, priority: 99 }]),
  });
  assert.equal(r.outcome, "unsorted");
  assert.equal(r.reason, R.LOW_CONFIDENCE);
});

test("rule 4 — confidence exactly at the threshold is not low", () => {
  const r = resolve({
    post: post({ confidence: 0.6 }),
    flow: FLOW,
    routing: routing([{ when: { topic: "steam" }, destinations: { telegram: ["-100x"] } }]),
  });
  assert.equal(r.outcome, "routed");
});

test("rule 4 — a missing or garbage confidence is treated as low", () => {
  // Краще в unsorted, ніж маршрутизувати вердикт без впевненості.
  for (const confidence of [undefined, null, NaN, "abc"]) {
    const r = resolve({
      post: post({ confidence }),
      flow: FLOW,
      routing: routing([{ when: {}, destinations: { telegram: ["-100x"] } }]),
    });
    assert.equal(r.reason, R.LOW_CONFIDENCE, `confidence=${confidence}`);
  }
});

test("rule 5 — a single value in `when` equals a one-element array", () => {
  const single = { when: { topic: "steam" }, destinations: { telegram: ["-100x"] } };
  const array = { when: { topic: ["steam"] }, destinations: { telegram: ["-100x"] } };
  const a = resolve({ post: post(), flow: FLOW, routing: routing([single]) });
  const b = resolve({ post: post(), flow: FLOW, routing: routing([array]) });
  assert.deepEqual(a, b);
});

// ── #unsorted is mandatory ────────────────────────────────────────────

test("#unsorted — a failed post lands there, never disappears", () => {
  const r = resolve({ post: { status: "failed" }, flow: FLOW, routing: routing([]) });
  assert.equal(r.outcome, "unsorted");
  assert.equal(r.reason, R.MODEL_FAILED);
});

test("#unsorted — topic `other` always lands there, even with a catch-all rule", () => {
  const r = resolve({
    post: post({ topic: "other" }),
    flow: FLOW,
    routing: routing([{ when: {}, destinations: { telegram: ["-100catchall"] } }]),
  });
  assert.equal(r.reason, R.TOPIC_OTHER);
});

// ── заповнена діра специфікації ───────────────────────────────────────

test("flow.topics — a post off the source's topics goes to unsorted, not the bin", () => {
  const r = resolve({
    post: post({ topic: "crypto" }),
    flow: { topics: ["steam"], min_confidence: 0.6 },
    routing: routing([{ when: { topic: "crypto" }, destinations: { telegram: ["-100crypto"] } }]),
  });
  assert.equal(r.outcome, "unsorted");
  assert.equal(r.reason, R.TOPIC_NOT_IN_SOURCE, "правило для crypto є, але джерело його не приймає");
});

test("flow.topics — null or empty means all topics", () => {
  for (const topics of [null, undefined, []]) {
    const r = resolve({
      post: post({ topic: "crypto" }),
      flow: { topics, min_confidence: 0.6 },
      routing: routing([{ when: { topic: "crypto" }, destinations: { telegram: ["-100crypto"] } }]),
    });
    assert.equal(r.outcome, "routed", `topics=${JSON.stringify(topics)}`);
  }
});

// ── захисні властивості ───────────────────────────────────────────────

test("a matching rule with no destinations does not swallow the post", () => {
  const r = resolve({
    post: post(),
    flow: FLOW,
    routing: routing([
      { when: { topic: "steam" }, destinations: {}, priority: 10 },
      { when: { topic: "steam" }, destinations: { telegram: ["-100real"] }, priority: 1 },
    ]),
  });
  assert.deepEqual(r.destinations, { telegram: ["-100real"] });
});

test("returned destinations are copies — mutating them cannot corrupt the config", () => {
  const rules = [{ when: { topic: "steam" }, destinations: { telegram: ["-100x"] } }];
  const r = resolve({ post: post(), flow: FLOW, routing: routing(rules) });
  r.destinations.telegram.push("-100INJECTED");
  assert.deepEqual(rules[0].destinations.telegram, ["-100x"]);
});

test("a status that should never reach resolve throws instead of hiding the bug", () => {
  // Тихий unsorted для pending замаскував би ваду в стадії, що вибирає пости.
  for (const status of ["pending", "skipped_blacklist", "routed", "suppressed", undefined]) {
    assert.throws(() => resolve({ post: post({ status }), flow: FLOW, routing: routing([]) }), /status/);
  }
});

test("numeric ids in config come back as strings", () => {
  const r = resolve({
    post: post(),
    flow: FLOW,
    routing: routing([{ when: { topic: "steam" }, destinations: { discord: [1234567890] } }]),
  });
  assert.deepEqual(r.destinations, { discord: ["1234567890"] });
});

// ── helpers ───────────────────────────────────────────────────────────

test("matchesWhen — empty `when` is a catch-all; missing when never matches", () => {
  assert.equal(matchesWhen({}, { topic: "steam", signal_type: "x" }), true);
  assert.equal(matchesWhen(undefined, { topic: "steam" }), false);
  assert.equal(matchesWhen(null, { topic: "steam" }), false);
});

test("orderRules — missing priority counts as 0", () => {
  const ordered = orderRules([{ id: "a" }, { id: "b", priority: 1 }, { id: "c", priority: -1 }]);
  assert.deepEqual(ordered.map((o) => o.rule.id), ["b", "a", "c"]);
});

// ── validateRouting ───────────────────────────────────────────────────

test("validateRouting — a correct config has no problems", () => {
  assert.deepEqual(validateRouting(routing([
    { when: { topic: "steam", signal_type: ["promo_code", "freebie"] }, destinations: { telegram: ["-1"] }, priority: 10 },
  ]), CATEGORIES), []);
});

test("validateRouting — a topic that is not in the taxonomy is reported", () => {
  // Приклад у TAXONOMY.md колись використовував `market`, якого немає (є
  // `markets`). Скопійований routing.json мовчки не маршрутизував би нічого.
  const problems = validateRouting(routing([
    { when: { topic: "games" }, destinations: { telegram: ["-1"] } },
    { when: { topic: ["market", "crypto"] }, destinations: { telegram: ["-2"] } },
  ]), CATEGORIES);
  assert.ok(problems.some((p) => p.includes('"market"')));
  assert.equal(problems.some((p) => p.includes('"games"')), false, "games у таксономії з v3");
  assert.equal(problems.some((p) => p.includes('"crypto"')), false, "crypto у таксономії є");
});

test("validateRouting — a typo'd condition key is caught, not silently matched", () => {
  // `signal` замість `signal_type`: ключ ігнорувався б і правило збігалося б з усім.
  const problems = validateRouting(routing([
    { when: { topic: "steam", signal: ["promo_code"] }, destinations: { telegram: ["-1"] } },
  ]), CATEGORIES);
  assert.ok(problems.some((p) => p.includes("when.signal")));
});

test("validateRouting — missing #unsorted is a problem", () => {
  const problems = validateRouting({ unsorted_destinations: {}, routing: [] }, CATEGORIES);
  assert.ok(problems.some((p) => p.includes("unsorted_destinations")));
});

test("validateRouting — a rule that matches but delivers nowhere is flagged", () => {
  const problems = validateRouting(routing([{ when: { topic: "steam" }, destinations: {} }]), CATEGORIES);
  assert.ok(problems.some((p) => p.includes("destinations is empty")));
});

test("validateRouting — the shipped routing.sample.json is valid", async () => {
  const { loadLocalConfig } = await import("../src/config/localConfig.js");
  const sample = loadLocalConfig("routing.sample", null, []);
  assert.deepEqual(validateRouting(sample, CATEGORIES), []);
});

// ── реклама ───────────────────────────────────────────────────────────

test("is_ad — an ad goes to #unsorted with reason ad, even when a rule matches", () => {
  const rules = routing([{ when: { topic: "steam" }, destinations: { telegram: ["-100steam"] } }]);
  const r = resolve({ post: post({ analysis: { is_ad: true } }), flow: FLOW, routing: rules });
  assert.equal(r.outcome, "unsorted");
  assert.equal(r.reason, R.AD);
  assert.deepEqual(r.destinations, UNSORTED);
  // is_ad false або відсутній — звичайна маршрутизація.
  assert.equal(resolve({ post: post({ analysis: { is_ad: false } }), flow: FLOW, routing: rules }).outcome, "routed");
  assert.equal(resolve({ post: post({ analysis: null }), flow: FLOW, routing: rules }).outcome, "routed");
});

// ── when.source і also ────────────────────────────────────────────────

const GAME_A = { telegram: ["-1001"] };
const GAME_B = { telegram: ["-1002"] };
const CODES = { telegram: ["-1003"], discord: ["123456789012345678"] };
const GAMES = { telegram: ["-1004"] };

test("when.source — a source dedicated to one topic routes by its channel id or its name", () => {
  const rules = routing([
    { when: { source: "-100500" }, destinations: GAME_A, priority: 50 },
    { when: { source: ["Game B channel"] }, destinations: GAME_B, priority: 50 },
    { when: { topic: "games" }, destinations: GAMES },
  ]);
  const game = (over) => post({ topic: "games", signal_type: "launch", ...over });
  assert.deepEqual(resolve({ post: game({ channel_id: "-100500" }), flow: FLOW, routing: rules }).destinations, GAME_A);
  assert.deepEqual(resolve({ post: game({ channel_id: "-100600" }), flow: FLOW, routing: rules, source: { channel_name: "Game B channel" } }).destinations, GAME_B);
  assert.deepEqual(resolve({ post: game({ channel_id: "-100700" }), flow: FLOW, routing: rules }).destinations, GAMES, "other sources fall to the topic rule");
});

test("also — a promo code goes to its game channel AND the shared codes channel, whatever the priorities", () => {
  const rules = routing([
    { when: { source: "-100500" }, destinations: GAME_A, priority: 50 },
    { when: { topic: ["games", "steam"], signal_type: ["promo_code", "freebie"] }, destinations: CODES, also: true, priority: 0 },
  ]);
  const r = resolve({ post: post({ topic: "games", signal_type: "promo_code", channel_id: "-100500" }), flow: FLOW, routing: rules });
  assert.equal(r.outcome, "routed");
  assert.deepEqual(r.destinations, { telegram: ["-1001", "-1003"], discord: ["123456789012345678"] });
  assert.deepEqual(r.rule, { index: 0, priority: 50 }, "the main rule is the non-also one");
  assert.equal(r.rules.length, 2);

  // Лише also збіглося — пост маршрутизовано туди, а не в #unsorted.
  const onlyCodes = resolve({ post: post({ topic: "steam", signal_type: "freebie", channel_id: "-100999" }), flow: FLOW, routing: rules });
  assert.equal(onlyCodes.outcome, "routed");
  assert.deepEqual(onlyCodes.destinations, CODES);

  // Звичайний пост цього ж джерела — без збірного каналу.
  assert.deepEqual(resolve({ post: post({ topic: "games", signal_type: "launch", channel_id: "-100500" }), flow: FLOW, routing: rules }).destinations, GAME_A);
});

test("also never overrides the gates: an ad or low confidence still goes to #unsorted", () => {
  const rules = routing([{ when: { signal_type: "promo_code" }, destinations: CODES, also: true }]);
  assert.equal(resolve({ post: post({ analysis: { is_ad: true } }), flow: FLOW, routing: rules }).outcome, "unsorted");
  assert.equal(resolve({ post: post({ confidence: 0.1 }), flow: FLOW, routing: rules }).outcome, "unsorted");
});

test("validateRouting — source, also and destination ids", () => {
  const problems = validateRouting({
    unsorted_destinations: { discord: ["TODO:unsorted"] },
    status_destinations: { telegram: ["@ok_channel"] },
    routing: [
      { when: { source: [] }, destinations: GAME_A },
      { when: { topic: "games" }, destinations: { discord: ["TODO:claims"] }, also: "yes" },
    ],
  }, CATEGORIES);
  assert.ok(problems.some((p) => p.includes('unsorted_destinations.discord "TODO:unsorted"')));
  assert.ok(problems.some((p) => p.includes("routing[0].when.source is empty")));
  assert.ok(problems.some((p) => p.includes("routing[1].also")));
  assert.ok(problems.some((p) => p.includes('routing[1].destinations.discord "TODO:claims"')));
  assert.ok(!problems.some((p) => p.includes("status_destinations")), "@username is a valid telegram id");
});

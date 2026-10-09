import test from "node:test";
import assert from "node:assert/strict";

import { assessPreflight } from "../src/module/theflow/Preflight.js";

/** Готове розгортання; кожен тест псує одну річ. */
const ready = (over = {}) => ({
  nodeEnv: "production",
  pendingMigrations: [],
  migrationCount: 17,
  llm: { workerEnabled: true, primary: "gemini", primaryKey: true, fallback: null, fallbackKey: false },
  telegram: { session: true, apiId: true },
  configFallbacks: [],
  triageProfile: { version: 1, areas: 3 },
  taxonomyVersion: 2,
  sources: [
    { name: "T", platform: "telegram", mode: "polling", flow: true, triage: false },
    { name: "N", platform: "rss", mode: "polling", flow: true, triage: true },
  ],
  routing: { unsorted: 1, health: 1, digest: 0, rules: 0 },
  deliveryEnabled: false,
  cron: { dailyEnabled: true, daily: 1, problems: [] },
  knowledge: 8,
  triageExamples: 8,
  ...over,
});

const levelOf = (report, key) => report.items.find((i) => i.key === key)?.level;

test("a configured shadow deployment is ready with no warnings", () => {
  const r = assessPreflight(ready());
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.filter((i) => i.level !== "ok"), []);
  assert.equal(levelOf(r, "delivery"), "ok");
});

test("blockers: development env, pending migrations, no model key, missing triage profile", () => {
  assert.equal(levelOf(assessPreflight(ready({ nodeEnv: "development" })), "node_env"), "fail");
  const m = assessPreflight(ready({ pendingMigrations: ["017-discovered-items"] }));
  assert.equal(m.ok, false);
  assert.match(m.items.find((i) => i.key === "migrations").message, /017-discovered-items/);

  const noKey = assessPreflight(ready({ llm: { workerEnabled: true, primary: "gemini", primaryKey: false } }));
  assert.match(noKey.items.find((i) => i.key === "llm").message, /no gemini API key — triage runs inside it/);

  assert.equal(levelOf(assessPreflight(ready({ configFallbacks: ["triage"] })), "config_triage"), "fail");
  assert.equal(levelOf(assessPreflight(ready({ triageProfile: { version: 0, areas: 0 } })), "triage_profile"), "fail");
  assert.equal(levelOf(assessPreflight(ready({ telegram: { session: false, apiId: true } })), "telegram"), "fail");
});

test("Discord sources need DISCORD_USER_TOKEN; a Discord flow source is not a listener warning", () => {
  const discord = { name: "D", platform: "discord", mode: "listener", flow: true, triage: false };
  const sources = [...ready().sources, discord];
  const noToken = assessPreflight(ready({ sources }));
  assert.equal(levelOf(noToken, "discord"), "fail");
  assert.match(noToken.items.find((i) => i.key === "discord").message, /1 Discord source\(s\), but DISCORD_USER_TOKEN is not set/);

  const withToken = assessPreflight(ready({ sources, discord: { userToken: true } }));
  assert.equal(withToken.ok, true);
  assert.equal(levelOf(withToken, "discord"), undefined);
  assert.equal(levelOf(withToken, "flow_listener"), undefined, "Discord has no polling to switch to");
});

test("without triage sources, a missing triage.json is only a warning", () => {
  const r = assessPreflight(ready({ configFallbacks: ["triage"], sources: [{ name: "T", platform: "telegram", mode: "polling", flow: true, triage: false }] }));
  assert.equal(r.ok, true);
  assert.equal(levelOf(r, "config_triage"), "warn");
});

test("warnings: listener flow sources, delivery on, digest in shadow, no health, no examples, fallback without key", () => {
  const r = assessPreflight(ready({
    sources: [{ name: "L", platform: "telegram", mode: "listener", flow: true, triage: false },
      { name: "N", platform: "rss", mode: "polling", flow: true, triage: true }],
    routing: { unsorted: 1, health: 0, digest: 1, rules: 0 },
    triageExamples: 0,
    llm: { workerEnabled: true, primary: "gemini", primaryKey: true, fallback: "openrouter", fallbackKey: false },
  }));
  assert.equal(r.ok, true, "warnings do not block");
  for (const key of ["flow_listener", "digest", "health", "knowledge", "llm_fallback"]) assert.equal(levelOf(r, key), "warn", key);
  assert.equal(levelOf(assessPreflight(ready({ deliveryEnabled: true })), "delivery"), "warn");
});

test("routing.json: a placeholder id blocks, any other routing problem only warns", () => {
  const placeholder = assessPreflight(ready({ routing: { unsorted: 1, health: 1, digest: 0, rules: 1,
    problems: ['routing[0].destinations.discord "TODO:claims" is not a valid discord id'] } }));
  assert.equal(placeholder.ok, false);
  assert.equal(levelOf(placeholder, "routing_ids"), "fail");

  const typo = assessPreflight(ready({ routing: { unsorted: 1, health: 1, digest: 0, rules: 1,
    problems: ['routing[0].when.topic "game" is not in the taxonomy'] } }));
  assert.equal(typo.ok, true);
  assert.equal(levelOf(typo, "routing"), "warn");

  assert.equal(levelOf(assessPreflight(ready()), "routing"), "ok");
  assert.equal(levelOf(assessPreflight(ready({ routing: { unsorted: 1, health: 1, digest: 0, status: 1, rules: 0 } })), "status"), "ok");
});

test("delivery off with routing rules warns: posts are enriched and reach no channel", () => {
  const r = assessPreflight(ready({ routing: { unsorted: 1, health: 1, digest: 0, rules: 12 } }));
  assert.equal(levelOf(r, "delivery"), "warn");
  assert.match(r.items.find((i) => i.key === "delivery").message, /FLOW_DELIVERY_ENABLED/);
  assert.equal(r.ok, true);
});

test("a deployment running on the routing or cronjob sample is blocked: those ids do not exist", () => {
  for (const name of ["routing", "cronjob.config"]) {
    const r = assessPreflight(ready({ configFallbacks: [name] }));
    assert.equal(levelOf(r, `config_${name}`), "fail");
    assert.equal(r.ok, false);
  }
  assert.equal(levelOf(assessPreflight(ready({ configFallbacks: ["sources"] })), "config_sources"), "warn");
});

test("daily report: placeholder ids block, no destinations warns, off is silent", () => {
  const bad = assessPreflight(ready({ cron: { dailyEnabled: true, daily: 1, problems: ['cronjob.config dailyinfo.discord "1234567" is not a valid discord id'] } }));
  assert.equal(levelOf(bad, "cron_ids"), "fail");
  assert.match(bad.items.find((i) => i.key === "cron_ids").message, /1234567/);
  assert.equal(levelOf(assessPreflight(ready({ cron: { dailyEnabled: true, daily: 0, problems: [] } })), "cron"), "warn");
  assert.equal(levelOf(assessPreflight(ready()), "cron"), "ok");
  const off = assessPreflight(ready({ cron: { dailyEnabled: false, daily: 0, problems: ["x"] } }));
  assert.equal(levelOf(off, "cron"), undefined);
  assert.equal(levelOf(off, "cron_ids"), undefined);
});

test("a classic source with a placeholder destination id is a blocker", () => {
  const r = assessPreflight(ready({
    sources: [{ name: "C", platform: "telegram", mode: "polling", flow: false, triage: false,
      destinationProblems: ['source "C".discord "TODO" is not a valid discord id'] }],
  }));
  assert.equal(levelOf(r, "source_ids"), "fail");
});

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

import test from "node:test";
import assert from "node:assert/strict";

import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { ProviderQuota } from "../src/module/teapot/models/index.js";

// Touches the real dev database. Uses a throwaway provider name and cleans up.
const P = `__test_${process.pid}`;

test.before(async () => { await database.connect(); });
test.after(async () => {
  await ProviderQuota.destroy({ where: { provider: P } });
  await database.disconnect();
});

test("bump increments per (provider, day) and is isolated per provider", async () => {
  assert.equal(await ProviderQuota.used(P), 0);
  assert.equal(await ProviderQuota.bump(P), 1);
  assert.equal(await ProviderQuota.bump(P), 2);
  assert.equal(await ProviderQuota.bump(P), 3);
  assert.equal(await ProviderQuota.used(P), 3);
  assert.equal(await ProviderQuota.used(`${P}_other`), 0);
});

test("a different UTC day is a different counter", async () => {
  await ProviderQuota.bump(P, "2000-01-01");
  assert.equal(await ProviderQuota.used(P, "2000-01-01"), 1);
  assert.equal(await ProviderQuota.used(P), 3); // today untouched
  await ProviderQuota.destroy({ where: { provider: P, day_utc: "2000-01-01" } });
});

test("markExhausted / isExhausted", async () => {
  assert.equal(await ProviderQuota.isExhausted(P), false);
  await ProviderQuota.markExhausted(P);
  assert.equal(await ProviderQuota.isExhausted(P), true);
  // marking exhausted does not lose the count
  assert.equal(await ProviderQuota.used(P), 3);
});

test("today() is a YYYY-MM-DD UTC string", () => {
  assert.match(ProviderQuota.today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ProviderQuota.today(), new Date().toISOString().slice(0, 10));
});

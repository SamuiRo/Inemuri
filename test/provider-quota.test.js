import test from "node:test";
import assert from "node:assert/strict";

import { assertTestDatabase } from "./support/testDatabase.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { ProviderQuota } from "../src/module/teapot/models/index.js";

// Пише в SQLite — лише на одноразовій базі з `npm test` (test/support).
// Throwaway provider name, cleaned up after.
const P = `__test_${process.pid}`;

test.before(async () => {
  assertTestDatabase();
  await database.connect();
});
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

test("today() defaults to the UTC day as YYYY-MM-DD", () => {
  assert.match(ProviderQuota.today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ProviderQuota.today(), new Date().toISOString().slice(0, 10));
});

test("today(tz) — Gemini's day is the Pacific one, not the UTC one", () => {
  // 06:00 UTC 13 вересня = 23:00 PDT 12 вересня. Google ще рахує 12-те.
  // Раніше реєстр писав 13-те — і вичерпання в цю годину блокувало Gemini
  // на всю UTC-добу, хоча Google відновлював квоту вже о 07:00 UTC.
  const at = new Date("2026-09-13T06:00:00Z");
  assert.equal(ProviderQuota.today("UTC", at), "2026-09-13");
  assert.equal(ProviderQuota.today("America/Los_Angeles", at), "2026-09-12");
});

test("today(tz) — the Pacific day rolls over at Pacific midnight", () => {
  // PDT = UTC-7: опівніч за Pacific — це 07:00 UTC.
  assert.equal(ProviderQuota.today("America/Los_Angeles", new Date("2026-09-13T06:59:59Z")), "2026-09-12");
  assert.equal(ProviderQuota.today("America/Los_Angeles", new Date("2026-09-13T07:00:00Z")), "2026-09-13");
});

test("today(tz) — handles DST: winter Pacific midnight is 08:00 UTC", () => {
  assert.equal(ProviderQuota.today("America/Los_Angeles", new Date("2026-01-15T07:30:00Z")), "2026-01-14");
  assert.equal(ProviderQuota.today("America/Los_Angeles", new Date("2026-01-15T08:00:00Z")), "2026-01-15");
});

test("today(tz) — an invalid zone falls back to UTC instead of throwing", () => {
  // Квотний облік не має валити воркер через опечатку в конфігу.
  const at = new Date("2026-09-13T06:00:00Z");
  assert.equal(ProviderQuota.today("Not/A_Zone", at), "2026-09-13");
});

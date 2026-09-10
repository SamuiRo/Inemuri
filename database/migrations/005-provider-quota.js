/**
 * Migration 005 — `provider_quota` table (ROADMAP §3.5, LLM_GATEWAY.md).
 *
 * The LLM gateway's persistent per-provider daily request counter. An
 * in-memory RPD counter resets on restart; this table is what a service would
 * have provided instead, shared by any process opening the same database file.
 *
 * Fields: provider, day_utc (YYYY-MM-DD), count, exhausted_at. Unique on
 * (provider, day_utc). Rows are per-day and never updated across days.
 *
 * Idempotent: `sequelize.sync()` creates the table only if it does not exist.
 */

import { print } from "../../src/shared/utils.js";
import { ProviderQuota } from "../../src/module/teapot/models/index.js";

export async function up({ sequelize, queryInterface: qi }) {
  const before = (await qi.showAllTables()).map(String);
  if (before.includes("provider_quota")) {
    print("provider_quota already present — skipping", "info");
    return;
  }

  await sequelize.sync();

  const after = (await qi.showAllTables()).map(String);
  if (!after.includes("provider_quota")) {
    throw new Error("provider_quota was not created");
  }
  print(`provider_quota created (${await ProviderQuota.count()} rows)`, "success");
}

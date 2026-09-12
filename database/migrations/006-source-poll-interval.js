/**
 * Migration 006 — per-source polling interval.
 *
 * Until now one global `POLLING_INTERVAL_MIN` drove every polling channel:
 * each cycle walked all of them, 500 ms apart. That is fine for uniform
 * sources and wrong for a real mix — a channel that posts twice a day was
 * being asked 288 times, while a busy one could not be tightened without
 * dragging every other channel along with it.
 *
 * Adds `sources.poll_interval_min` INTEGER NULL. NULL means "use the global
 * default", so existing rows keep behaving exactly as before and the column
 * needs no backfill.
 *
 * Plain ADD COLUMN, no table rebuild (ROADMAP §12). Idempotent.
 */

import { print } from "../../src/shared/utils.js";

async function hasColumn(qi, table, column) {
  const desc = await qi.describeTable(table);
  return Boolean(desc[column]);
}

export async function up({ sequelize, queryInterface: qi }) {
  if (await hasColumn(qi, "sources", "poll_interval_min")) {
    print("sources.poll_interval_min already present — skipping", "info");
    return;
  }

  await sequelize.query("ALTER TABLE `sources` ADD COLUMN `poll_interval_min` INTEGER");
  print("Added sources.poll_interval_min (INTEGER NULL = global default)", "success");

  const [[{ n }]] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM `sources` WHERE `mode` IN ('polling', 'both')",
  );
  print(`${n} polling source(s) now inherit the global interval until set`, "info");
}

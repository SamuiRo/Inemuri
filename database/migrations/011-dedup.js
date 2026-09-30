/**
 * Migration 011 — deduplication, tiers 1 and 2 (ROADMAP §6).
 *
 * - `posts.dedup` JSON NULL — the decision log (§6.7): which tier decided,
 *   the similarity `s` behind it, the cluster and post it matched, the gray
 *   zone flag. Thresholds are calibrated from this (§6.8); without it there is
 *   nothing to calibrate against. NULL = not deduplicated yet.
 * - `clusters.embedding_model` STRING NULL, `clusters.embedding_dim` INTEGER
 *   NULL — DATA_MODEL.md has always listed them (§13.2: a centroid is a vector
 *   with the same identity problem as a post's), the model never had them.
 * - index `clusters (closed, last_seen_at)` — tier 1 and tier 2 look up open
 *   clusters active inside a window.
 *
 * Plain ADD COLUMN / CREATE INDEX IF NOT EXISTS, no table rebuild (§12).
 * Idempotent: on a fresh database `db:bootstrap` already created all of it.
 */

import { print } from "../../src/shared/utils.js";

async function addColumn(sequelize, qi, table, column, ddl) {
  const desc = await qi.describeTable(table);
  if (desc[column]) {
    print(`${table}.${column} already present — skipping`, "info");
    return;
  }
  await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
  print(`Added ${table}.${column}`, "success");
}

export async function up({ sequelize, queryInterface: qi }) {
  await addColumn(sequelize, qi, "posts", "dedup", "JSON");
  await addColumn(sequelize, qi, "clusters", "embedding_model", "VARCHAR(255)");
  await addColumn(sequelize, qi, "clusters", "embedding_dim", "INTEGER");
  await sequelize.query(
    "CREATE INDEX IF NOT EXISTS `clusters_closed_last_seen_at` ON `clusters` (`closed`, `last_seen_at`)",
  );
  print("Index clusters (closed, last_seen_at) ready", "success");
}

/**
 * Migration 018 — the status board (docs/ARCHITECTURE.md § Status).
 *
 * 1. `source_states.last_seen_at` DATETIME NULL — when the source last
 *    published, as far as Inemuri saw it (any mode: listener, polling,
 *    feeds). Before this only polling and flow sources left a trace, so a
 *    listener channel that went quiet was invisible. NULL = not seen since
 *    tracking began; no backfill.
 * 2. `status_messages` — the one message per destination that the status
 *    board edits in place: (platform, channel_id) → message_id.
 *
 * Plain ADD COLUMN and CREATE TABLE, no table rebuild (ROADMAP §12).
 * Idempotent.
 */

import { print } from "../../src/shared/utils.js";

export async function up({ sequelize, queryInterface: qi }) {
  const states = await qi.describeTable("source_states");
  if (states.last_seen_at) {
    print("source_states.last_seen_at already present — skipping", "info");
  } else {
    await sequelize.query("ALTER TABLE `source_states` ADD COLUMN `last_seen_at` DATETIME");
    print("Added source_states.last_seen_at (NULL = not seen since tracking began)", "success");
  }

  const tables = (await qi.showAllTables()).map(String);
  if (tables.includes("status_messages")) {
    print("status_messages already present — skipping", "info");
    return;
  }
  await sequelize.query(
    "CREATE TABLE `status_messages` (" +
      "`id` INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "`platform` VARCHAR(255) NOT NULL, " +
      "`channel_id` VARCHAR(255) NOT NULL, " +
      "`message_id` VARCHAR(255) NOT NULL, " +
      "`createdAt` DATETIME NOT NULL, " +
      "`updatedAt` DATETIME NOT NULL)",
  );
  await sequelize.query(
    "CREATE UNIQUE INDEX `status_messages_platform_channel` ON `status_messages` (`platform`, `channel_id`)",
  );
  print("Created status_messages", "success");
}

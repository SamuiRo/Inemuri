/**
 * Migration 003 — generalize the polling cursor.
 *
 * `SourceState.last_message_id` is a Telegram per-channel sequence number.
 * Reddit stores a fullname, an RSS feed stores a guid plus timestamp — each
 * adapter needs its own cursor shape (ROADMAP §2.4).
 *
 * Adds `source_states.cursor` JSON and backfills it from the existing
 * `last_message_id`. `last_message_id` stays for now — the Telegram adapter
 * keeps reading it — and is dropped once nothing does.
 *
 * Idempotent.
 */

import { print } from "../../src/shared/utils.js";

async function hasColumn(qi, table, column) {
  const desc = await qi.describeTable(table);
  return Boolean(desc[column]);
}

export async function up({ sequelize, queryInterface: qi }) {
  if (await hasColumn(qi, "source_states", "cursor")) {
    print("source_states.cursor already present — skipping", "info");
  } else {
    await sequelize.query("ALTER TABLE `source_states` ADD COLUMN `cursor` JSON");
    print("Added source_states.cursor (JSON)", "success");
  }

  // Backfill { "last_message_id": <value> } wherever a checkpoint exists.
  await sequelize.query(
    "UPDATE `source_states` SET `cursor` = json_object('last_message_id', `last_message_id`) " +
      "WHERE `cursor` IS NULL AND `last_message_id` IS NOT NULL",
  );
  const [[{ n }]] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM `source_states` WHERE `cursor` IS NOT NULL",
  );
  print(`source_states rows with a cursor: ${n}`, "info");
}

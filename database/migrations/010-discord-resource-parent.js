/**
 * Migration 010 — `discord_resources.parent_id` (docs/DISCORDAPP.md, «State»).
 *
 * A provisioned message lives in a channel, and its row needs that channel's
 * id: to check the message still exists, to edit it, and to notice that the
 * config moved it to another channel. Roles, categories and channels leave it
 * NULL.
 *
 * Plain ADD COLUMN, no table rebuild. On a database where 009 created the
 * table from the current model the column is already there — skipped.
 * Idempotent.
 */

import { print } from "../../src/shared/utils.js";

export async function up({ sequelize, queryInterface: qi }) {
  const desc = await qi.describeTable("discord_resources");
  if (desc.parent_id) {
    print("discord_resources.parent_id already present — skipping", "info");
    return;
  }

  await sequelize.query("ALTER TABLE `discord_resources` ADD COLUMN `parent_id` VARCHAR(255)");
  print("Added discord_resources.parent_id (channel of a provisioned message)", "success");
}

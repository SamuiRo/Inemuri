/**
 * Migration 009 — `discord_resources` table (docs/DISCORDAPP.md, «State»).
 *
 * Provisioning state for discordapp: which Discord role, category or channel
 * each `key` of a server config refers to, and which channels were archived
 * after leaving the config. Without it an update would have to guess the
 * resource by name, and renaming a channel in the config would create a new one.
 *
 * Idempotent: `sequelize.sync()` creates the table only if it does not exist.
 */

import { print } from "../../src/shared/utils.js";
import { DiscordResource } from "../../src/module/teapot/models/index.js";

export async function up({ sequelize, queryInterface: qi }) {
  const before = (await qi.showAllTables()).map(String);
  if (before.includes("discord_resources")) {
    print("discord_resources already present — skipping", "info");
    return;
  }

  await sequelize.sync();

  const after = (await qi.showAllTables()).map(String);
  if (!after.includes("discord_resources")) {
    throw new Error("discord_resources was not created");
  }
  print(`discord_resources created (${await DiscordResource.count()} rows)`, "success");
}

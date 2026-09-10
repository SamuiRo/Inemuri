/**
 * Migration 002 — generalize `posts` for non-Telegram sources.
 *
 * `posts` is Telegram-shaped in four places, and each breaks on Reddit or an
 * RSS item (ROADMAP §2.4). This migration adds the platform-neutral columns
 * while the corpus is still small, and swaps the identity/uniqueness key from
 * `(channel_id, message_id)` to `(source_id, external_id)`.
 *
 * All changes are `ADD COLUMN` plus index add/remove — no table rebuild
 * (ROADMAP §12). `message_id` keeps its NOT NULL and stays populated for
 * Telegram (FlowIngest always has it); nothing *reads* it any more. A later
 * migration DROPs the column outright once a non-Telegram adapter exists —
 * cleaner than nullable-then-drop, and SQLite 3.44 on the VPS has DROP COLUMN.
 *
 * Idempotent: every step checks first, so a partially-applied run is safe.
 */

import { print } from "../../src/shared/utils.js";

// New columns. JSON-typed ones are declared `JSON` in DDL, not `TEXT` —
// Sequelize v6 on SQLite decides JSON parsing from the column's declared type
// (the lesson from migration 001).
const COLUMNS = [
  ["platform", "TEXT NOT NULL DEFAULT 'telegram'"],
  ["external_id", "TEXT"],
  ["external_url", "TEXT"],
  ["title", "TEXT"],
  ["author", "TEXT"],
  ["media_ref", "JSON"],
  ["entities", "JSON"],
  ["embedding_model", "TEXT"],
  ["embedding_dim", "INTEGER"],
];

async function hasColumn(qi, table, column) {
  const desc = await qi.describeTable(table);
  return Boolean(desc[column]);
}

async function indexNames(qi, table) {
  const [rows] = await qi.sequelize.query(`PRAGMA index_list(\`${table}\`)`);
  return new Set(rows.map((r) => r.name));
}

export async function up({ sequelize, queryInterface: qi }) {
  // ── 1. Add the platform-neutral columns ─────────────────────────
  for (const [name, ddl] of COLUMNS) {
    if (await hasColumn(qi, "posts", name)) {
      print(`posts.${name} already present — skipping`, "info");
      continue;
    }
    await sequelize.query(`ALTER TABLE \`posts\` ADD COLUMN \`${name}\` ${ddl}`);
    print(`Added posts.${name} (${ddl})`, "success");
  }

  // ── 2. Backfill from the Telegram-shaped columns ────────────────
  await sequelize.query(
    "UPDATE `posts` SET `platform` = 'telegram' WHERE `platform` IS NULL",
  );
  await sequelize.query(
    "UPDATE `posts` SET `external_id` = CAST(`message_id` AS TEXT) " +
      "WHERE `external_id` IS NULL AND `message_id` IS NOT NULL",
  );
  // media_ref: what stage 3 needs to fetch media later, per platform.
  await sequelize.query(
    "UPDATE `posts` SET `media_ref` = json_object(" +
      "'kind', 'telegram', 'channel_id', `channel_id`, " +
      "'message_id', `message_id`, 'grouped_id', `grouped_id`) " +
      "WHERE `has_media` = 1 AND `media_ref` IS NULL",
  );
  // `entities` cannot be backfilled — phase-0 rows never stored the original
  // MTProto entities. New rows carry them from FlowIngest onward.
  const [[{ n }]] = await sequelize.query(
    "SELECT COUNT(*) AS n FROM `posts`",
  );
  print(`Backfilled ${n} existing post row(s)`, "info");

  // ── 3. Swap the identity key ───────────────────────────────────
  const before = await indexNames(qi, "posts");

  if (before.has("posts_channel_id_message_id")) {
    await qi.removeIndex("posts", "posts_channel_id_message_id");
    print("Dropped UNIQUE (channel_id, message_id)", "warning");
  }
  if (!before.has("posts_source_id_external_id")) {
    await qi.addIndex("posts", ["source_id", "external_id"], {
      unique: true,
      name: "posts_source_id_external_id",
    });
    print("Added UNIQUE (source_id, external_id)", "success");
  }
  // channel_id stays a denormalized fast lookup key for Telegram, just not
  // part of an item's identity any more.
  if (!before.has("posts_channel_id")) {
    await qi.addIndex("posts", ["channel_id"], { name: "posts_channel_id" });
    print("Added index (channel_id)", "success");
  }
  // Tier 2 deduplication compares only vectors produced by the same model
  // (DATA_MODEL.md). Empty until phase 1 writes verdicts.
  if (!before.has("posts_embedding_model")) {
    await qi.addIndex("posts", ["embedding_model"], { name: "posts_embedding_model" });
    print("Added index (embedding_model)", "success");
  }
}

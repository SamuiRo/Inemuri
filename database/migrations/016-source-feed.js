/**
 * Migration 016 — per-source feed settings (NEWS_INTAKE.md §2.1, ROADMAP §14.2).
 *
 * Adds `sources.feed` JSON NULL: how an `rss` source finds new articles —
 * `{ "discovery": "rss" | "sitemap" | "wpjson" }`. NULL means a plain
 * RSS/Atom feed, so every existing source keeps behaving exactly as before
 * and the column needs no backfill.
 *
 * Plain ADD COLUMN, no table rebuild (ROADMAP §12). Idempotent.
 */

import { print } from "../../src/shared/utils.js";

export async function up({ sequelize, queryInterface: qi }) {
  const desc = await qi.describeTable("sources");
  if (desc.feed) {
    print("sources.feed already present — skipping", "info");
    return;
  }
  await sequelize.query("ALTER TABLE `sources` ADD COLUMN `feed` JSON");
  print("Added sources.feed (JSON NULL = plain RSS/Atom)", "success");
}

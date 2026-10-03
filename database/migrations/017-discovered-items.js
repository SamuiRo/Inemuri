/**
 * Migration 017 — `discovered_items` table (NEWS_INTAKE.md §2.2, ROADMAP §14.3).
 *
 * Candidates of news sources with `feed.triage: true`: every new article lands
 * here first, with its triage decision (rule or LLM), and only what passes
 * becomes a post. Short-lived — swept after FLOW_TRIAGE_RETENTION_DAYS.
 *
 * Idempotent: `sequelize.sync()` creates only what is missing (on a fresh
 * database `db:bootstrap` already did).
 */

import { print } from "../../src/shared/utils.js";
// Registers the model on the shared sequelize instance.
import "../../src/module/teapot/models/index.js";

export async function up({ sequelize, queryInterface: qi }) {
  const before = (await qi.showAllTables()).map(String);
  if (before.includes("discovered_items")) {
    print("discovered_items already present — skipping", "info");
    return;
  }
  await sequelize.sync();
  const after = (await qi.showAllTables()).map(String);
  if (!after.includes("discovered_items")) {
    throw new Error("discovered_items was not created");
  }
  print("discovered_items created", "success");
}

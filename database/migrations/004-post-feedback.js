/**
 * Migration 004 — `post_feedback` table (ROADMAP §2.6).
 *
 * A human's label on a TheFlow post. Lands in phase 0.5, not phase 5:
 * `flow:review` starts writing rows during phase 1 shadow mode, so the
 * verdict-checking you do anyway becomes a labelled dataset. Collecting it
 * retroactively is expensive.
 *
 * Fields (DATA_MODEL.md): post_id (FK, SET NULL), verdict
 * (good | noise | wrong_topic | missed), note, created_at. Rows are immutable
 * — no updatedAt.
 *
 * Idempotent: `sequelize.sync()` creates the table only if it does not exist,
 * exactly as migration 001 did for `posts` / `clusters`.
 */

import { print } from "../../src/shared/utils.js";
// Registers the model on the shared sequelize instance.
import { PostFeedback } from "../../src/module/teapot/models/index.js";

export async function up({ sequelize, queryInterface: qi }) {
  const before = (await qi.showAllTables()).map(String);
  if (before.includes("post_feedback")) {
    print("post_feedback already present — skipping", "info");
    return;
  }

  await sequelize.sync();

  const after = (await qi.showAllTables()).map(String);
  if (!after.includes("post_feedback")) {
    throw new Error("post_feedback was not created");
  }
  print(`post_feedback created (${await PostFeedback.count()} rows)`, "success");
}

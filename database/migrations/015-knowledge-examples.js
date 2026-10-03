/**
 * Migration 015 — `knowledge_examples` table (NEWS_INTAKE.md §3, ROADMAP §14).
 *
 * The knowledge base: self-contained labelled examples that carry a snapshot
 * of what was labelled, so labels survive pruning `posts` and move between
 * instances (`flow knowledge export|import`). `post_feedback` stays the
 * review event log; few-shot now reads this table.
 *
 * Creates the table, then backfills every `post_feedback` label that still
 * has its post. Both halves are idempotent: `sequelize.sync()` creates only
 * what is missing (on a fresh database `db:bootstrap` already did), and the
 * backfill skips labels already present through the UNIQUE `feedback_id`.
 */

import { print } from "../../src/shared/utils.js";
import { KnowledgeExample } from "../../src/module/teapot/models/index.js";
import { backfillFromFeedback } from "../../src/module/theflow/knowledge/KnowledgeBase.js";

export async function up({ sequelize, queryInterface: qi }) {
  const before = (await qi.showAllTables()).map(String);
  if (before.includes("knowledge_examples")) {
    print("knowledge_examples already present — skipping create", "info");
  } else {
    await sequelize.sync();
    const after = (await qi.showAllTables()).map(String);
    if (!after.includes("knowledge_examples")) {
      throw new Error("knowledge_examples was not created");
    }
    print("knowledge_examples created", "success");
  }

  const { created, skipped } = await backfillFromFeedback();
  print(
    `Backfilled ${created} label(s) from post_feedback` +
      (skipped ? `, ${skipped} skipped (no post or no text)` : "") +
      ` — ${await KnowledgeExample.count()} example(s) in total`,
    "success",
  );
}

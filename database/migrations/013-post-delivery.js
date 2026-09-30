/**
 * Migration 013 — delivery log (ROADMAP §5.4–5.6).
 *
 * Adds `posts.delivery` JSON NULL: what the delivery stage decided and did —
 * outcome (`routed` / `unsorted`), resolve's reason, the destinations, the
 * identities of what was sent, or why nothing was (too old, no destinations,
 * send failed and how many times). NULL = not handled yet. It is what keeps a
 * post from being sent twice, and what `flow preview` / `flow stats` read.
 *
 * Plain ADD COLUMN, no table rebuild (§12). Idempotent.
 */

import { print } from "../../src/shared/utils.js";

export async function up({ sequelize, queryInterface: qi }) {
  const desc = await qi.describeTable("posts");
  if (desc.delivery) {
    print("posts.delivery already present — skipping", "info");
    return;
  }
  await sequelize.query("ALTER TABLE `posts` ADD COLUMN `delivery` JSON");
  print("Added posts.delivery", "success");
}

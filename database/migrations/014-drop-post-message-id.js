/**
 * Migration 014 — drop `posts.message_id` (ROADMAP §2.4 deviation, §7).
 *
 * `message_id` was the Telegram message id, INTEGER NOT NULL. Migration 002
 * made `external_id` the platform-neutral identity and left `message_id`
 * written but unread, to be dropped "when the first non-Telegram adapter
 * lands". That is now: a Reddit id is `t3_abc123` and an RSS item's identity
 * is its guid or URL — neither fits an INTEGER NOT NULL column. The Telegram
 * message id lives on in `external_id` (as text) and in `media_ref`.
 *
 * SQLite refuses DROP COLUMN for a column that is part of an index, so any
 * index that still covers it (none should, after 002) is dropped first.
 * SQLite ≥ 3.35 has DROP COLUMN; the bundled one is 3.44. Idempotent: a
 * database bootstrapped from the current models never had the column.
 */

import { print } from "../../src/shared/utils.js";

export async function up({ sequelize, queryInterface: qi }) {
  const desc = await qi.describeTable("posts");
  if (!desc.message_id) {
    print("posts.message_id already absent — skipping", "info");
    return;
  }

  const [indexes] = await sequelize.query("PRAGMA index_list('posts')");
  for (const idx of indexes) {
    const [cols] = await sequelize.query(`PRAGMA index_info('${String(idx.name).replace(/'/g, "''")}')`);
    if (cols.some((c) => c.name === "message_id")) {
      if (idx.origin !== "c") {
        throw new Error(`index ${idx.name} on posts.message_id is a constraint (${idx.origin}) — cannot drop it here`);
      }
      await sequelize.query(`DROP INDEX \`${idx.name}\``);
      print(`Dropped index ${idx.name} (covered message_id)`, "warning");
    }
  }

  await sequelize.query("ALTER TABLE `posts` DROP COLUMN `message_id`");
  print("Dropped posts.message_id — the item identity is external_id", "success");
}

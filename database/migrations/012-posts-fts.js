/**
 * Migration 012 — full-text search over the corpus (ROADMAP §9.1, tier 1).
 *
 * `posts_fts` is an FTS5 index over `text_en`, `raw_text` and `title`, as an
 * **external-content** table (`content='posts'`): it stores only the index,
 * the text stays in `posts`. Three triggers keep it in sync — after insert,
 * after delete, and after an update that touches one of the three columns
 * (the worker's claims and status changes do not re-index anything).
 *
 * Tokenizer `unicode61 remove_diacritics 2`: case-folds Cyrillic as well as
 * Latin, so "розыгрыш" finds "Розыгрыш". Verified against the bundled SQLite
 * (node-sqlite3 ships its own, 3.44.2, so the VPS gets the same after
 * `npm ci`).
 *
 * The index is built from the existing rows at the end (`'rebuild'`). Every
 * statement is IF NOT EXISTS, and a rebuild is idempotent — re-running is safe.
 * Nothing here alters `posts`, so there is no table rebuild (§12).
 */

import { print } from "../../src/shared/utils.js";

const COLS = "text_en, raw_text, title";

export async function up({ sequelize }) {
  await sequelize.query(
    `CREATE VIRTUAL TABLE IF NOT EXISTS \`posts_fts\` USING fts5(${COLS}, ` +
      "content='posts', content_rowid='id', tokenize=\"unicode61 remove_diacritics 2\")",
  );

  await sequelize.query(
    "CREATE TRIGGER IF NOT EXISTS `posts_fts_ai` AFTER INSERT ON `posts` BEGIN " +
      `INSERT INTO posts_fts(rowid, ${COLS}) VALUES (new.id, new.text_en, new.raw_text, new.title); END`,
  );
  await sequelize.query(
    "CREATE TRIGGER IF NOT EXISTS `posts_fts_ad` AFTER DELETE ON `posts` BEGIN " +
      `INSERT INTO posts_fts(posts_fts, rowid, ${COLS}) VALUES ('delete', old.id, old.text_en, old.raw_text, old.title); END`,
  );
  await sequelize.query(
    "CREATE TRIGGER IF NOT EXISTS `posts_fts_au` AFTER UPDATE OF text_en, raw_text, title ON `posts` BEGIN " +
      `INSERT INTO posts_fts(posts_fts, rowid, ${COLS}) VALUES ('delete', old.id, old.text_en, old.raw_text, old.title); ` +
      `INSERT INTO posts_fts(rowid, ${COLS}) VALUES (new.id, new.text_en, new.raw_text, new.title); END`,
  );

  await sequelize.query("INSERT INTO `posts_fts`(`posts_fts`) VALUES ('rebuild')");
  const [[{ n }]] = await sequelize.query("SELECT COUNT(*) AS n FROM `posts`");
  print(`posts_fts ready — ${n} post(s) indexed`, "success");
}

import fs from "fs";

import database from "../teapot/sqlite/sqlite_db.js";
import { SQLITE_STORAGE, FLOW_STORAGE } from "../../config/app.config.js";

/**
 * TheFlow — зберігання корпусу (ROADMAP §13.9).
 *
 * Рішення, а не недогляд: **нічого не видаляється**. `raw_text` зберігається
 * завжди — це інваріант (ARCHITECTURE.md «Resilience invariants»: без нього
 * нові промпти не прогнати по історії), і корпус — те, заради чого TheFlow
 * існує. Ембеддинг — ~3 КБ на пост (768 × float32); кілька сотень постів на
 * добу — кілька мегабайт на місяць.
 *
 * Натомість — точка перегляду: FLOW_STORAGE.reviewRows постів або
 * reviewBytes бази. Коли її перетнуто, це видно в `flow stats` / `flow health`
 * і одним попередженням на старті — і тоді варто вирішити про архівування
 * старих ембеддингів чи VACUUM. Не алерт: нічого не зламалось.
 */

/** Чиста оцінка. */
export function assessStorage({ posts, dbBytes }, { reviewRows, reviewBytes } = FLOW_STORAGE) {
  const reasons = [];
  if (posts >= reviewRows) reasons.push(`${posts} posts ≥ ${reviewRows}`);
  if (dbBytes != null && dbBytes >= reviewBytes) reasons.push(`database ${formatBytes(dbBytes)} ≥ ${formatBytes(reviewBytes)}`);
  return {
    reviewDue: reasons.length > 0,
    note: reasons.length
      ? `storage review point reached (${reasons.join(", ")}) — decide on archiving old embeddings or VACUUM (ROADMAP §13.9)`
      : null,
  };
}

export function formatBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Розміри: постів, файлу бази, ембеддингів. */
export async function collectStorage() {
  const [[row]] = await database.sequelize.query(
    "SELECT COUNT(*) AS posts, COALESCE(SUM(LENGTH(`embedding`)), 0) AS embeddingBytes, " +
      "COALESCE(SUM(LENGTH(`raw_text`) + LENGTH(COALESCE(`text_en`, ''))), 0) AS textBytes FROM `posts`",
  );
  let dbBytes = null;
  try {
    dbBytes = fs.statSync(SQLITE_STORAGE).size;
  } catch {
    // Немає файлу (in-memory тощо) — розмір невідомий.
  }
  return { posts: Number(row.posts), embeddingBytes: Number(row.embeddingBytes), textBytes: Number(row.textBytes), dbBytes };
}

export function storageLine(s) {
  return `storage: ${s.posts} posts · database ${formatBytes(s.dbBytes)} · embeddings ${formatBytes(s.embeddingBytes)} · text ${formatBytes(s.textBytes)}`;
}

/**
 * Migration 008 — `vision_cache` table (ROADMAP §4, VISION.md gate 3).
 *
 * Persistent transcriptions keyed by the perceptual hash of the image, so the
 * same screenshot reposted across channels costs one vision call. Persistent
 * for the same reason as provider_quota: an in-memory cache is empty after a
 * restart and everything already paid for would be paid for again.
 *
 * image_hash is deliberately NOT unique. A recompressed repost hashes 4–7 bits
 * away from the original, so lookup is by Hamming distance
 * (VisionCache.nearest), and near-identical images legitimately produce
 * distinct rows.
 *
 * Idempotent: `sequelize.sync()` creates the table only if it does not exist.
 */

import { print } from "../../src/shared/utils.js";
import { VisionCache } from "../../src/module/teapot/models/index.js";

export async function up({ sequelize, queryInterface: qi }) {
  const before = (await qi.showAllTables()).map(String);
  if (before.includes("vision_cache")) {
    print("vision_cache already present — skipping", "info");
    return;
  }

  await sequelize.sync();

  const after = (await qi.showAllTables()).map(String);
  if (!after.includes("vision_cache")) {
    throw new Error("vision_cache was not created");
  }
  print(`vision_cache created (${await VisionCache.count()} rows)`, "success");
}

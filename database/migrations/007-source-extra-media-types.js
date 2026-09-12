/**
 * Migration 007 — per-source extra media types.
 *
 * `DOWNLOADABLE_MEDIA_TYPES` is global: photo, video, document, animation.
 * `audio` parses correctly but was never downloaded anywhere, and the loss was
 * silent (a bare `continue` in the downloader, no log line). For some channels
 * audio is worth keeping; for most it is noise.
 *
 * Adds `sources.extra_media_types` JSON NULL — types to download *in addition*
 * to the global list. Additive on purpose rather than a full override: a full
 * list invites omitting `photo` by accident and silently losing every image on
 * that source, while this can only ever add.
 *
 * NULL means "global list only", so existing rows are unchanged and no
 * backfill is needed. Plain ADD COLUMN, no table rebuild (ROADMAP §12).
 * Idempotent.
 */

import { print } from "../../src/shared/utils.js";

async function hasColumn(qi, table, column) {
  const desc = await qi.describeTable(table);
  return Boolean(desc[column]);
}

export async function up({ sequelize, queryInterface: qi }) {
  if (await hasColumn(qi, "sources", "extra_media_types")) {
    print("sources.extra_media_types already present — skipping", "info");
    return;
  }

  await sequelize.query("ALTER TABLE `sources` ADD COLUMN `extra_media_types` JSON");
  print("Added sources.extra_media_types (JSON NULL = global list only)", "success");
}

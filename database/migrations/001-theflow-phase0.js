/**
 * Migration 001 — TheFlow Phase 0 schema.
 *
 * On the VPS (a pre-TheFlow database with only `sources`, `sqlite_sequence`
 * and `source_states`) this CREATES the phase 0 schema. On a development copy
 * that already ran the old `scripts/migrate-theflow-phase0.js` it ADOPTS the
 * existing schema — every step is idempotent, so both paths work from this
 * one file.
 *
 * This wraps the original one-off script. The runner (`scripts/migrate.js`)
 * now owns what that script did around the schema work: the
 * NODE_ENV=development refusal and the per-batch backup into
 * `database/backups/`.
 *
 *   1. Add `sources.flow` — declared JSON, not TEXT. Sequelize v6 on SQLite
 *      decides whether to parse a column as JSON from its DDL type; a TEXT
 *      column comes back as a raw string despite `DataTypes.JSON` on the
 *      model. A column left from an earlier mistyped run is dropped and
 *      re-added.
 *   2. Backfill `flow` with the default object for rows where it is NULL.
 *   3. `sequelize.sync()` — creates `posts` and `clusters`. A plain sync()
 *      (no alter, no force) only creates tables that do not exist yet.
 *   4. Verify: expected tables present, sources preserved.
 */

import { print } from "../../src/shared/utils.js";
// Importing the models registers `posts` and `clusters` on the shared
// sequelize instance so sync() below can create them.
import { Source, SourceState, Post, Cluster } from "../../src/module/teapot/models/index.js";

// Frozen snapshot of the default at phase 0. A migration is a historical
// artifact — it must keep writing what it wrote originally even if
// Source.js FLOW_DEFAULTS changes later.
const FLOW_DEFAULT = {
  enabled: false,
  topics: null,
  min_confidence: 0.6,
  dedup_window_hours: null,
  vision: { enabled: false, text_threshold: 200, max_images_per_post: 2 },
};

// The exact DEFAULT literal Sequelize would generate for this column via
// sync(), so raw INSERTs also get a valid `flow`.
const FLOW_COLUMN_DDL =
  "`flow` JSON DEFAULT '" + JSON.stringify(FLOW_DEFAULT).replace(/'/g, "''") + "'";

async function columnInfo(qi, table, column) {
  const desc = await qi.describeTable(table);
  return desc[column] ?? null; // { type, allowNull, defaultValue, ... } | null
}

export async function up({ sequelize, queryInterface: qi }) {
  // ── 1. sources.flow ──────────────────────────────────────────────
  const flowCol = await columnInfo(qi, "sources", "flow");
  const flowTypeOk = flowCol && String(flowCol.type).toUpperCase().includes("JSON");

  if (flowTypeOk) {
    print("sources.flow already present with JSON type — skipping", "info");
  } else {
    if (flowCol) {
      // Created earlier with the wrong type (TEXT) — recreate it.
      // ALTER TABLE DROP COLUMN exists in SQLite 3.35+.
      await sequelize.query("ALTER TABLE `sources` DROP COLUMN `flow`");
      print(`Dropped mistyped sources.flow (was ${flowCol.type})`, "warning");
    }
    await sequelize.query(`ALTER TABLE \`sources\` ADD COLUMN ${FLOW_COLUMN_DDL}`);
    print("Added sources.flow (JSON)", "success");
  }

  // ── 2. Backfill NULL flow ────────────────────────────────────────
  await sequelize.query(
    "UPDATE `sources` SET `flow` = ? WHERE `flow` IS NULL",
    { replacements: [JSON.stringify(FLOW_DEFAULT)] },
  );
  const [[{ nulls }]] = await sequelize.query(
    "SELECT COUNT(*) AS nulls FROM `sources` WHERE `flow` IS NULL",
  );
  print(
    `Backfill done — sources with NULL flow: ${nulls}`,
    nulls === 0 ? "success" : "warning",
  );

  // ── 3. Create posts and clusters ────────────────────────────────
  // Plain sync() (no alter/force) creates only what does not exist yet.
  await sequelize.sync();

  // ── 4. Verify ───────────────────────────────────────────────────
  const tables = (await qi.showAllTables()).map(String);
  const missing = ["sources", "source_states", "posts", "clusters"].filter(
    (t) => !tables.includes(t),
  );
  if (missing.length) {
    throw new Error(`missing tables after migration: ${missing.join(", ")}`);
  }

  const srcCount = await Source.count();
  print(
    `Verify: ${srcCount} sources, ${await SourceState.count()} source_states, ` +
      `${await Post.count()} posts, ${await Cluster.count()} clusters`,
    "info",
  );
  if (srcCount === 0) {
    print("WARNING: zero sources after migration — expected 14 on the VPS", "warning");
  }
}

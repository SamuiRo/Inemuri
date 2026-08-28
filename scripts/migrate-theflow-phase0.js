/**
 * TheFlow Phase 0 — одноразова міграція схеми.
 *
 * Що робить:
 *   1. Відмовляється працювати при NODE_ENV=development (там sync() = force:true,
 *      що перестворює таблиці й знищує джерела).
 *   2. Робить власний бекап database/pot.sqlite у database/backups/.
 *   3. Додає колонку `flow` до таблиці `sources`, якщо її ще немає
 *      (ручний ALTER TABLE ADD COLUMN — один безпечний statement, без
 *      перебудови таблиці, яку робить sequelize sync({alter:true}) на SQLite).
 *   4. Бекфілить flow дефолтом {enabled:false,...} для наявних рядків.
 *   5. Викликає database.sync() — створює нові таблиці posts і clusters
 *      (звичайного sync() достатньо для таблиць, яких ще немає).
 *   6. Верифікує результат.
 *
 * Ідемпотентний: повторний запуск нічого не ламає.
 *
 *   node scripts/migrate-theflow-phase0.js
 */

import fs from "fs";
import path from "path";

import { print } from "../src/shared/utils.js";
import { NODE_ENV } from "../src/config/app.config.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
// Імпорт моделей реєструє їх на sequelize — потрібно, щоб sync() побачив
// posts і clusters.
import { Source, SourceState, Post, Cluster } from "../src/module/teapot/models/index.js";

const FLOW_DEFAULT = {
  enabled: false,
  topics: null,
  min_confidence: 0.6,
  dedup_window_hours: null,
  vision: { enabled: false, text_threshold: 200, max_images_per_post: 2 },
};

async function columnInfo(qi, table, column) {
  const desc = await qi.describeTable(table);
  return desc[column] ?? null; // { type, allowNull, defaultValue, ... } | null
}

// Точний DEFAULT-literal, який Sequelize згенерував би для цієї колонки
// з sync() — щоб raw-вставки теж отримували валідний flow.
const FLOW_COLUMN_DDL =
  "`flow` JSON DEFAULT '" + JSON.stringify(FLOW_DEFAULT).replace(/'/g, "''") + "'";

async function backup() {
  const src = path.resolve(process.cwd(), "database", "pot.sqlite");
  if (!fs.existsSync(src)) {
    print(`No database at ${src} — nothing to back up (fresh install)`, "warning");
    return;
  }
  const dir = path.resolve(process.cwd(), "database", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `pot.sqlite.${stamp}.pre-theflow-phase0`);
  fs.copyFileSync(src, dest);
  print(`Backup written: ${path.relative(process.cwd(), dest)}`, "success");
}

async function main() {
  print("TheFlow Phase 0 migration — start", "system");

  if (NODE_ENV === "development") {
    print(
      "NODE_ENV=development detected. database.sync() runs with force:true in this mode " +
      "and would recreate tables, destroying configured sources. Aborting. " +
      "Run with NODE_ENV=production.",
      "error",
    );
    process.exit(1);
  }

  await backup();

  await database.connect();
  const qi = database.sequelize.getQueryInterface();

  // ── 1. Колонка flow на sources ────────────────────────────────────
  // ВАЖЛИВО: колонку треба оголосити типом JSON, а не TEXT. Sequelize v6
  // на SQLite вирішує парсити значення як JSON за оголошеним типом колонки
  // в DDL — колонка TEXT повертається сирим рядком попри DataTypes.JSON
  // у моделі.
  const flowCol = await columnInfo(qi, "sources", "flow");
  const flowTypeOk = flowCol && String(flowCol.type).toUpperCase().includes("JSON");

  if (flowTypeOk) {
    print("Column sources.flow already exists with JSON type — skipping", "info");
  } else {
    if (flowCol) {
      // Створена раніше з неправильним типом (TEXT) — перестворюємо.
      // ALTER TABLE DROP COLUMN є в SQLite 3.35+ (бандл sqlite3@5 новіший).
      await qi.sequelize.query("ALTER TABLE `sources` DROP COLUMN `flow`");
      print(`Dropped mistyped column sources.flow (was ${flowCol.type})`, "warning");
    }
    await qi.sequelize.query(`ALTER TABLE \`sources\` ADD COLUMN ${FLOW_COLUMN_DDL}`);
    print("Added column sources.flow (JSON)", "success");
  }

  // ── 2. Бекфіл дефолту для рядків із NULL ──────────────────────────
  await qi.sequelize.query(
    "UPDATE `sources` SET `flow` = ? WHERE `flow` IS NULL",
    { replacements: [JSON.stringify(FLOW_DEFAULT)] },
  );
  const [[{ nulls }]] = await qi.sequelize.query(
    "SELECT COUNT(*) AS nulls FROM `sources` WHERE `flow` IS NULL",
  );
  print(`Backfill done — sources with NULL flow remaining: ${nulls}`, nulls === 0 ? "success" : "warning");

  // ── 3. Створення нових таблиць posts і clusters ───────────────────
  // Звичайний sync() (без alter/force) створює лише те, чого ще немає.
  await database.sync();

  // ── 4. Верифікація ───────────────────────────────────────────────
  const tables = await qi.showAllTables();
  const need = ["sources", "source_states", "posts", "clusters"];
  const missing = need.filter((t) => !tables.map(String).includes(t));
  if (missing.length) {
    print(`Verification FAILED — missing tables: ${missing.join(", ")}`, "error");
    process.exit(1);
  }

  const srcCount = await Source.count();
  const stateCount = await SourceState.count();
  const postCount = await Post.count();
  const clusterCount = await Cluster.count();
  const sample = await Source.findOne();

  print("Verification:", "system");
  print(`  tables:        ${need.join(", ")}`, "info");
  print(`  sources:       ${srcCount} (source_states: ${stateCount})`, "info");
  print(`  posts:         ${postCount}   clusters: ${clusterCount}`, "info");
  print(`  sample flow:   ${JSON.stringify(sample?.getFlowConfig?.() ?? null)}`, "info");

  if (srcCount === 0) {
    print("WARNING: zero sources after migration — expected 14. Check the backup.", "warning");
  }

  await database.disconnect();
  print("TheFlow Phase 0 migration — done", "success");
}

main().catch(async (err) => {
  print(`Migration error: ${err.message}`, "error");
  console.error(err);
  try { await database.disconnect(); } catch { /* already down */ }
  process.exit(1);
});

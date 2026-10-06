/**
 * Migration runner (ROADMAP §2.2).
 *
 * A hand-rolled runner, ~matching how the rest of the project is built —
 * sequelize-cli is CJS, wants its own config loader, and fits ESM badly.
 *
 *   npm run migrate           apply every pending migration, in order
 *   npm run migrate:status    print applied and pending, change nothing
 *
 * Rules (see ROADMAP §12 "Migration discipline"):
 *   - forward-only. No down(). Recovery on a database holding the corpus is
 *     a restore from the backup this runner takes, not a reverse migration;
 *   - one backup per run into database/backups/, before the first migration;
 *   - refuses NODE_ENV=development — that path uses sync({ force: true }) and
 *     recreates tables, destroying sources and corpus;
 *   - each migration file is database/migrations/NNN-*.js exporting
 *     `up({ sequelize, queryInterface })`;
 *   - applied migrations are recorded in the `schema_migrations` table
 *     (name PK, applied_at), shared by any process opening the same file.
 *
 * Run `npm run migrate:status` on the VPS before every deploy: code that
 * assumes a column the deployed database lacks fails at runtime in the
 * ingest path, the one place that must never stop.
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

import { print } from "../src/shared/utils.js";
import { NODE_ENV, SQLITE_STORAGE } from "../src/config/app.config.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "database", "migrations");
const DB_FILE = SQLITE_STORAGE;
// Бекапи лежать поруч із базою: для робочої це database/backups/, а прогін
// тестів на тимчасовій базі не смітить у репозиторій.
const BACKUP_DIR = path.resolve(path.dirname(DB_FILE), "backups");

// database/migrations/NNN-name.js — three-digit prefix, sorted lexically
// (zero-padded, so lexical order is numeric order).
const MIGRATION_RE = /^\d{3}-.*\.js$/;

function migrationName(file) {
  return file.replace(/\.js$/, "");
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_RE.test(f)).sort();
}

async function ensureLedger(qi) {
  await qi.sequelize.query(
    "CREATE TABLE IF NOT EXISTS `schema_migrations` (" +
      "`name` TEXT PRIMARY KEY, `applied_at` TEXT NOT NULL)",
  );
}

async function appliedSet(qi) {
  const [rows] = await qi.sequelize.query("SELECT `name` FROM `schema_migrations`");
  return new Set(rows.map((r) => r.name));
}

function backup(tag) {
  if (!fs.existsSync(DB_FILE)) {
    print(`No database at ${DB_FILE} — skipping backup (fresh install)`, "warning");
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `pot.sqlite.${stamp}.${tag}`);
  fs.copyFileSync(DB_FILE, dest);
  print(`Backup written: ${path.relative(process.cwd(), dest)}`, "success");
}

async function loadMigration(file) {
  const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
  if (typeof mod.up !== "function") {
    throw new Error(`${file} does not export an up() function`);
  }
  return mod;
}

async function cmdStatus() {
  await database.connect();
  const qi = database.sequelize.getQueryInterface();
  await ensureLedger(qi);

  const applied = await appliedSet(qi);
  const files = listMigrationFiles();

  print("Migration status:", "system");
  if (files.length === 0) {
    print("  (no migration files in database/migrations/)", "info");
  }

  let pending = 0;
  for (const file of files) {
    const name = migrationName(file);
    const isApplied = applied.has(name);
    if (!isApplied) pending += 1;
    print(`  [${isApplied ? "x" : " "}] ${name}`, isApplied ? "info" : "warning");
  }
  for (const name of applied) {
    if (!files.some((f) => migrationName(f) === name)) {
      print(`  [x] ${name}  (recorded, no file)`, "warning");
    }
  }

  print(
    `${pending} pending, ${applied.size} applied`,
    pending ? "warning" : "success",
  );
  await database.disconnect();
}

/**
 * Міграції не створюють базу з нуля: `sources` і `source_states` старші за
 * них і з'являються з `database.sync()` (CLAUDE.md). Без `sources` перша ж
 * міграція падає на describeTable з повідомленням, яке нічого не пояснює.
 *
 * Дві причини, і їх треба розрізнити до будь-яких змін: свіжа установка
 * (тоді — db:bootstrap) або база не там, де її шукають (робоча тека інша,
 * ніж у сервісу; SQLITE_STORAGE). connect() тихо створює порожній файл, тож
 * «файл є» ще не означає «база є».
 */
async function guardEmptyDatabase(qi, existedBefore) {
  const tables = (await qi.showAllTables()).map(String);
  if (tables.includes("sources")) return true;
  print(`No "sources" table in ${DB_FILE}${existedBefore ? "" : " — the file did not exist and was just created empty"}.`, "error");
  print("Nothing was migrated. One of:", "error");
  print("  • the service's database is elsewhere — the working directory differs from the one the service ran in " +
    "(pm2 describe <app> → exec cwd), or SQLITE_STORAGE points elsewhere. Copy that database here (service stopped) " +
    "or run migrate from that directory;", "error");
  print("  • this is a fresh install — run npm run setup (bootstrap, migrate and seed from sources.json in one go).", "error");
  return false;
}

async function cmdMigrate() {
  const existedBefore = fs.existsSync(DB_FILE);
  await database.connect();
  const qi = database.sequelize.getQueryInterface();
  print(`Database: ${DB_FILE}`, "info");
  if (!(await guardEmptyDatabase(qi, existedBefore))) {
    await database.disconnect();
    process.exitCode = 1;
    return;
  }
  await ensureLedger(qi);

  const applied = await appliedSet(qi);
  const pending = listMigrationFiles().filter((f) => !applied.has(migrationName(f)));

  if (pending.length === 0) {
    print("Nothing to migrate — schema is up to date", "success");
    await database.disconnect();
    return;
  }

  print(
    `${pending.length} pending: ${pending.map(migrationName).join(", ")}`,
    "system",
  );

  // One backup per run, before the first migration touches the schema.
  backup("pre-migrate");

  for (const file of pending) {
    const name = migrationName(file);
    print(`-> ${name}`, "system");
    const mod = await loadMigration(file);
    await mod.up({ sequelize: database.sequelize, queryInterface: qi });
    await qi.sequelize.query(
      "INSERT INTO `schema_migrations` (`name`, `applied_at`) VALUES (?, ?)",
      { replacements: [name, new Date().toISOString()] },
    );
    print(`ok ${name}`, "success");
  }

  print(`Applied ${pending.length} migration(s)`, "success");
  await database.disconnect();
}

async function main() {
  if (NODE_ENV === "development") {
    print(
      "NODE_ENV=development detected. The sync path uses force:true in this mode " +
        "and would recreate tables, destroying sources and corpus. Aborting — " +
        "run with NODE_ENV=production.",
      "error",
    );
    process.exit(1);
  }

  const cmd = process.argv[2] ?? "up";
  if (cmd === "status") {
    await cmdStatus();
  } else if (cmd === "up" || cmd === "migrate") {
    await cmdMigrate();
  } else {
    print(`Unknown command "${cmd}". Use: migrate | migrate status`, "error");
    process.exit(1);
  }
}

main().catch(async (error) => {
  print(`Migration failed: ${error.message}`, "error");
  console.error(error);
  try { await database.disconnect(); } catch { /* already down */ }
  process.exit(1);
});

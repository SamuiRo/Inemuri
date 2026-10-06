/**
 * Розгортання бази з конфігів однією командою.
 *
 *   npm run setup                          створити/оновити базу і заповнити її
 *   npm run setup -- --new                 почати з нової бази: наявну відкласти в database/backups/
 *   npm run setup -- --knowledge kb.jsonl  ще й імпортувати мітки бази знань
 *
 * Кроки, кожен — окремим процесом, як і руками:
 *   1. db:bootstrap  — таблиці, старші за міграції (sources, source_states);
 *   2. migrate       — усе інше, з бекапом;
 *   3. seed          — джерела з src/config/sources.json;
 *   4. flow knowledge import <file> — якщо передано --knowledge;
 *   5. flow preflight — що ще лишилось налаштувати (не зупиняє setup).
 *
 * На наявній базі безпечно: bootstrap нічого не переписує, migrate застосовує
 * лише відсутнє, seed оновлює джерела з файлу і не чіпає інших. `--new` нічого
 * не видаляє — стара база переїжджає в database/backups/ під іменем
 * pot.sqlite.<час>.pre-setup.
 *
 * Без src/config/sources.json відмовляє: seed узяв би sources.sample.json, і в
 * робочу базу потрапили б зразкові джерела.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { NODE_ENV, SQLITE_STORAGE } from "../src/config/app.config.js";
import { print } from "../src/shared/utils.js";

const args = process.argv.slice(2);
const fresh = args.includes("--new");
const knowledgeAt = args.indexOf("--knowledge");
const knowledgeFile = knowledgeAt >= 0 ? args[knowledgeAt + 1] : null;
const unknown = args.filter((a, i) => !["--new", "--knowledge"].includes(a) && i !== knowledgeAt + 1);

if (unknown.length || (knowledgeAt >= 0 && !knowledgeFile)) {
  print("Usage: npm run setup [-- --new] [-- --knowledge <file.jsonl>]", "error");
  process.exit(1);
}
if (NODE_ENV === "development") {
  print("Refusing to run under NODE_ENV=development (the sync path uses force: true and recreates tables)", "error");
  process.exit(1);
}

const sourcesFile = path.resolve(process.cwd(), "src", "config", "sources.json");
if (!fs.existsSync(sourcesFile)) {
  print("src/config/sources.json is missing — seed would fill the database with the sample sources. " +
    "Copy your sources.json first (docs/DEPLOYMENT.md lists every file git does not carry).", "error");
  process.exit(1);
}
if (knowledgeFile && !fs.existsSync(knowledgeFile)) {
  print(`Knowledge file not found: ${knowledgeFile}`, "error");
  process.exit(1);
}

print(`Database: ${SQLITE_STORAGE}`, "info");

if (fresh && fs.existsSync(SQLITE_STORAGE)) {
  const dir = path.join(path.dirname(SQLITE_STORAGE), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${path.basename(SQLITE_STORAGE)}.${stamp}.pre-setup`);
  fs.renameSync(SQLITE_STORAGE, dest);
  // SQLite кладе поруч журнали — вони належать старій базі.
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (fs.existsSync(SQLITE_STORAGE + suffix)) fs.renameSync(SQLITE_STORAGE + suffix, dest + suffix);
  }
  print(`--new: the existing database moved to ${path.relative(process.cwd(), dest)} — starting from an empty one`, "warning");
}

const steps = [
  ["Schema (tables older than migrations)", ["scripts/bootstrap-schema.js"]],
  ["Migrations", ["scripts/migrate.js"]],
  ["Sources from sources.json", ["src/cli.js", "seed"]],
  ...(knowledgeFile ? [["Knowledge base", ["src/cli.js", "flow", "knowledge", "import", knowledgeFile]]] : []),
];

for (const [title, argv] of steps) {
  print(`── ${title}`, "system");
  const run = spawnSync(process.execPath, argv, { stdio: "inherit", env: process.env });
  if (run.status !== 0) {
    print(`Setup stopped: "${title}" failed (exit ${run.status ?? run.signal}). Fix it and run npm run setup again — finished steps are safe to repeat.`, "error");
    process.exit(1);
  }
}

print("── What is left to configure", "system");
spawnSync(process.execPath, ["src/cli.js", "flow", "preflight"], { stdio: "inherit", env: process.env });
print("Database is ready. Start the service once preflight has no blockers.", "success");

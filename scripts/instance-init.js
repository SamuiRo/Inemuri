/**
 * npm run instance:init [-- --apply]
 *
 * Переносить дані розгортання зі старих місць (до v4.67.0) у instance/:
 *
 *   src/config/{sources,routing,triage}.json   → instance/config/
 *   src/config/cronjob.config.json             → instance/config/cron.json
 *   src/config/discordapp/servers/<n>.json     → instance/provision/<n>/server.json
 *     і тексти з messages/, на які він посилається → поруч, посилання переписані
 *   database/pot.sqlite (+ журнали), backups/   → instance/database/
 *   database/**.jsonl                          → instance/knowledge/
 *   exports/*                                  → instance/exports/
 *
 * Без --apply лише показує план. Нічого вже наявного в instance/ не
 * перезаписує — такий пункт пропускається з поясненням. Перед --apply
 * зупиніть сервіс (pm2 stop inemuri): переноситься робоча база.
 */
import fs from "fs";
import path from "path";

import { INSTANCE } from "../src/config/app.config.js";
import { LEGACY } from "../src/config/instance.js";
import { referencedFiles, targetPath, rewriteRefs } from "../src/shared/instanceInit.js";
import { print } from "../src/shared/utils.js";

const apply = process.argv.includes("--apply");
const rel = (p) => path.relative(process.cwd(), p) || ".";
const steps = [];   // { from, to, action: "move"|"write"|"copy", note?, run }
const skipped = []; // { what, why }
const removeAfter = new Set(); // скопійовані тексти: прибрати, коли всі сервери перенесено

function move(from, to, note = null) {
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to)) {
    skipped.push({ what: rel(from), why: `${rel(to)} already exists` });
    return;
  }
  steps.push({ action: "move", from, to, note, run: () => moveFs(from, to) });
}

function moveFs(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// ── config ──────────────────────────────────────────────────────────────
for (const name of ["sources", "routing", "triage"]) {
  move(path.join(LEGACY.config, `${name}.json`), path.join(INSTANCE.config, `${name}.json`));
}
move(path.join(LEGACY.config, "cronjob.config.json"), path.join(INSTANCE.config, "cron.json"), "renamed to cron.json");

// ── provision ───────────────────────────────────────────────────────────
const legacyServers = fs.existsSync(LEGACY.servers)
  ? fs.readdirSync(LEGACY.servers).filter((f) => f.endsWith(".json") && !f.endsWith(".sample.json"))
  : [];
for (const file of legacyServers) {
  const name = file.slice(0, -".json".length);
  const from = path.join(LEGACY.servers, file);
  const folder = path.join(INSTANCE.provision, name);
  const to = path.join(folder, "server.json");
  if (fs.existsSync(to)) {
    skipped.push({ what: rel(from), why: `${rel(to)} already exists` });
    continue;
  }
  const text = fs.readFileSync(from, "utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    skipped.push({ what: rel(from), why: `not valid JSON (${error.message}) — fix it, then run again` });
    continue;
  }
  for (const ref of referencedFiles(raw)) {
    const src = path.join(LEGACY.messages, ref);
    const dst = path.join(folder, targetPath(ref, name));
    if (!fs.existsSync(src)) {
      skipped.push({ what: `${rel(from)} → ${ref}`, why: "referenced, but not in messages/ — /provision plan will report it" });
      continue;
    }
    if (fs.existsSync(dst)) continue;
    steps.push({ action: "copy", from: src, to: dst, run: () => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } });
    removeAfter.add(src);
  }
  // Решта файлів теки messages/<name>/ (без посилань) — теж до сервера.
  const own = path.join(LEGACY.messages, name);
  if (fs.existsSync(own)) {
    for (const f of fs.readdirSync(own, { recursive: true })) {
      const src = path.join(own, f);
      if (!fs.statSync(src).isFile()) continue;
      const dst = path.join(folder, f);
      if (steps.some((s) => s.to === dst)) continue;
      if (fs.existsSync(dst)) continue;
      steps.push({ action: "copy", from: src, to: dst, run: () => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } });
      removeAfter.add(src);
    }
  }
  const rewritten = rewriteRefs(text, name);
  steps.push({
    action: "write", from, to,
    note: rewritten === text ? null : `references "${name}/…" → relative to the folder`,
    run: () => { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(to, rewritten); fs.rmSync(from); },
  });
}

// ── database, knowledge ─────────────────────────────────────────────────
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  move(path.join(LEGACY.database, `pot.sqlite${suffix}`), path.join(INSTANCE.database, `pot.sqlite${suffix}`));
}
const legacyBackups = path.join(LEGACY.database, "backups");
if (fs.existsSync(legacyBackups)) {
  for (const f of fs.readdirSync(legacyBackups)) move(path.join(legacyBackups, f), path.join(INSTANCE.database, "backups", f));
}
const jsonl = [];
const scan = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== "migrations" && e.name !== "backups") scan(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) jsonl.push(p);
  }
};
scan(LEGACY.database);
for (const p of jsonl) move(p, path.join(INSTANCE.knowledge, path.basename(p)));

// ── exports ─────────────────────────────────────────────────────────────
if (fs.existsSync(LEGACY.exports)) {
  for (const f of fs.readdirSync(LEGACY.exports)) move(path.join(LEGACY.exports, f), path.join(INSTANCE.exports, f));
}

// ── звіт і виконання ────────────────────────────────────────────────────
print(`instance/: ${INSTANCE.root}`, "system");
if (!steps.length && !skipped.length) {
  print("Nothing in the old places — already moved.", "success");
  process.exit(0);
}
for (const s of steps) {
  process.stdout.write(`  ${s.action.padEnd(5)} ${rel(s.from)}  →  ${rel(s.to)}${s.note ? `  (${s.note})` : ""}\n`);
}
for (const s of skipped) print(`skip  ${s.what}: ${s.why}`, "warning");

if (!apply) {
  print(`${steps.length} step(s). Nothing moved — stop the service (pm2 stop inemuri), then: npm run instance:init -- --apply`, "info");
  process.exit(0);
}

let done = 0;
for (const s of steps) {
  try {
    s.run();
    done += 1;
  } catch (error) {
    print(`failed: ${rel(s.from)} → ${rel(s.to)}: ${error.message}`, "error");
  }
}
// Тексти, скопійовані до серверів, — прибрати зі старої теки; порожні теки — теж.
for (const src of removeAfter) {
  try { fs.rmSync(src, { force: true }); } catch { /* лишиться — не страшно */ }
}
const pruneEmpty = (dir) => {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  for (const e of fs.readdirSync(dir)) pruneEmpty(path.join(dir, e));
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
};
for (const dir of [LEGACY.messages, LEGACY.servers, path.dirname(LEGACY.servers), legacyBackups, LEGACY.exports]) pruneEmpty(dir);
for (const p of jsonl) pruneEmpty(path.dirname(p) === LEGACY.database ? path.join(LEGACY.database, "__none__") : path.dirname(p));

print(`${done} of ${steps.length} step(s) done.${skipped.length ? ` ${skipped.length} skipped — see above.` : ""} Check: node src/cli.js flow preflight`, done === steps.length ? "success" : "warning");

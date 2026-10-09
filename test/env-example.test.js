import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXAMPLE = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const CONFIG_PATH = fileURLToPath(new URL("../src/config/app.config.js", import.meta.url));

/** `NAME="value"  # comment` → { NAME: "value" } для активних рядків. */
function parseExample(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const quoted = m[2].match(/^"([^"]*)"/);
    out[m[1]] = quoted ? quoted[1] : m[2].split("#")[0].trim();
  }
  return out;
}

// Кожна змінна, яку читає app.config.js, описана в .env.example — і навпаки.
// Інакше новий параметр живе лише в коді, а оператор про нього не знає.
test(".env.example lists exactly the variables app.config.js reads", () => {
  const config = fs.readFileSync(CONFIG_PATH, "utf8");
  const read = new Set([...config.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  const listed = new Set(Object.keys(parseExample(EXAMPLE)));
  assert.deepEqual([...read].filter((v) => !listed.has(v)).sort(), [], "read by app.config.js, missing in .env.example");
  assert.deepEqual([...listed].filter((v) => !read.has(v)).sort(), [], "in .env.example, read by nothing");
});

// Закоментована змінна в копії .env — це перемикач, який оператор «змінив», а
// сервіс не побачив (так доставка TheFlow лишалась вимкненою на VPS).
test(".env.example has no commented-out variables", () => {
  assert.deepEqual(EXAMPLE.match(/^#\s*[A-Z][A-Z0-9_]+=.*$/gm) ?? [], []);
});

// Активні рядки — це дефолти: копія .env.example без змін дає ту саму
// конфігурацію, що й код без .env. Відрізнятися можуть лише заглушки секретів
// і значення, які приклад свідомо задає (production, fallback-провайдер).
test("the values in .env.example are the code's defaults", () => {
  const values = parseExample(EXAMPLE);
  const DELIBERATE = new Set([
    "NODE_ENV", "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "DISCORD_BOT_TOKEN",
    "DISCORD_COMMAND_WHITELIST", "CMC_API_KEY", "LLM_FALLBACK",
  ]);
  const dump = [
    `const c = await import(${JSON.stringify(new URL("file:" + CONFIG_PATH.replace(/\\/g, "/")).href)});`,
    "const out = {};",
    "for (const [k, v] of Object.entries(c)) if (typeof v !== 'function' && !['CONFIG_WARNINGS', 'PKG', 'CATEGORIES'].includes(k)) out[k] = v;",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  // Чисте оточення без змінних конфігу; cwd без .env, тож dotenv нічого не додасть.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(k in values) && k !== "SQLITE_STORAGE"));
  const run = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", dump],
    { cwd: os.tmpdir(), env, encoding: "utf8" }));
  const bare = run(base);
  const withExample = run({ ...base, ...Object.fromEntries(Object.entries(values).filter(([k]) => !DELIBERATE.has(k))) });
  const differs = Object.keys({ ...bare, ...withExample })
    .filter((k) => JSON.stringify(bare[k]) !== JSON.stringify(withExample[k]));
  assert.deepEqual(differs, [], "an active value in .env.example differs from the code's default");
});

// process.env читає лише app.config.js (CLAUDE.md, Code conventions).
test("only app.config.js reads process.env", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && !p.pathname.endsWith("/config/app.config.js")
        && /process\.env\b/.test(fs.readFileSync(p, "utf8"))) offenders.push(p.pathname);
    }
  };
  walk(new URL("../src/", import.meta.url));
  assert.deepEqual(offenders, []);
});

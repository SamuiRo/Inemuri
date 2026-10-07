import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Кожна змінна, яку читає app.config.js, описана в .env.example — і навпаки.
// Інакше новий параметр живе лише в коді, а оператор про нього не знає.
test(".env.example lists exactly the variables app.config.js reads", () => {
  const config = fs.readFileSync(new URL("../src/config/app.config.js", import.meta.url), "utf8");
  const example = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const read = new Set([...config.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  const listed = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  assert.deepEqual([...read].filter((v) => !listed.has(v)).sort(), [], "read by app.config.js, missing in .env.example");
  assert.deepEqual([...listed].filter((v) => !read.has(v)).sort(), [], "in .env.example, read by nothing");
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

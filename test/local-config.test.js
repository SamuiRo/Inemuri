import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { loadLocalConfig } from "../src/config/localConfig.js";

// Семпли лежать поруч зі справжніми конфігами, у instance/config/ (v4.67.0).
const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "instance", "config");

/**
 * Тимчасові теки instance/config і «старого місця» — тест не чіпає жодного
 * справжнього конфігу. `fn` отримує `where` для loadLocalConfig.
 */
function withDirs({ files = {}, legacy = {} }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inemuri-local-config-"));
  const dir = path.join(root, "config");
  const legacyDir = path.join(root, "legacy");
  fs.mkdirSync(dir);
  fs.mkdirSync(legacyDir);
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, "utf8");
    for (const [name, body] of Object.entries(legacy)) fs.writeFileSync(path.join(legacyDir, name), body, "utf8");
    return fn({ dir, legacyDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NAME = "probe";

test("loadLocalConfig — prefers the local file over the sample", () => {
  withDirs({ files: {
    [`${NAME}.json`]: JSON.stringify({ who: "local" }),
    [`${NAME}.sample.json`]: JSON.stringify({ who: "sample" }),
  } }, (where) => {
    const sink = [];
    assert.deepEqual(loadLocalConfig(NAME, { who: "fallback" }, sink, where), { who: "local" });
    assert.deepEqual(sink, [], "звичайний шлях не має попереджати");
  });
});

test("loadLocalConfig — falls back to the sample, loudly", () => {
  withDirs({ files: { [`${NAME}.sample.json`]: JSON.stringify({ who: "sample" }) } }, (where) => {
    const sink = [];
    assert.deepEqual(loadLocalConfig(NAME, { who: "fallback" }, sink, where), { who: "sample" });
    assert.equal(sink.length, 1);
    assert.match(sink[0], /not found/);
  });
});

test("loadLocalConfig — a file still in the old place is read, with a warning to move it", () => {
  // Сервер, на який прийшов v4.67.0, але ще не `npm run instance:init`, не
  // має стартувати на семплах.
  withDirs({
    files: { "cron.sample.json": JSON.stringify({ who: "sample" }) },
    legacy: { "cronjob.config.json": JSON.stringify({ who: "old" }) },
  }, (where) => {
    const sink = [];
    assert.deepEqual(loadLocalConfig("cron", null, sink, { ...where, legacyName: "cronjob.config" }), { who: "old" });
    assert.match(sink[0], /old place.*instance:init/);
  });
  withDirs({
    files: { [`${NAME}.json`]: JSON.stringify({ who: "new" }) },
    legacy: { [`${NAME}.json`]: JSON.stringify({ who: "old" }) },
  }, (where) => {
    assert.deepEqual(loadLocalConfig(NAME, null, [], where), { who: "new" }, "новий файл важливіший за старий");
  });
});

test("loadLocalConfig — a fresh clone starts instead of failing to resolve", () => {
  // Регресія: раніше конфіги йшли через `import ... with { type: "json" }`,
  // а самі файли в .gitignore — тож клон падав ще до першого рядка логіки.
  withDirs({}, (where) => {
    const sink = [];
    assert.deepEqual(loadLocalConfig(NAME, { who: "fallback" }, sink, where), { who: "fallback" });
    assert.equal(sink.length, 1);
    assert.match(sink[0], /neither/);
  });
});

test("loadLocalConfig — a broken local file throws, it does not silently become the sample", () => {
  // Тихо підмінити робочий конфіг семплом означає стартувати з чужими
  // призначеннями. Зламаний конфіг має зупинити старт.
  withDirs({ files: {
    [`${NAME}.json`]: "{ not json",
    [`${NAME}.sample.json`]: JSON.stringify({ who: "sample" }),
  } }, (where) => {
    assert.throws(() => loadLocalConfig(NAME, { who: "fallback" }, [], where), /is not valid JSON/);
  });
});

test("loadLocalConfig — a broken sample throws too", () => {
  withDirs({ files: { [`${NAME}.sample.json`]: "{ also not json" } }, (where) => {
    assert.throws(() => loadLocalConfig(NAME, { who: "fallback" }, [], where), /is not valid JSON/);
  });
});

const shipped = (name) => loadLocalConfig(name, null, [], { dir: SAMPLES_DIR, legacyDir: null });

test("the shipped sample configs parse", () => {
  // Вони — фолбек для свіжого клону: якщо семпл битий, клон не стартує.
  for (const name of ["sources.sample", "routing.sample", "triage.sample", "cron.sample"]) {
    const parsed = shipped(name);
    assert.ok(parsed && typeof parsed === "object", `${name}.json має парситись`);
  }
});

test("routing.sample carries no real channel ids", () => {
  const sample = shipped("routing.sample");
  const ids = Object.values(sample.unsorted_destinations ?? {}).flat();
  assert.ok(ids.length > 0, "семпл має показувати форму");
  for (const id of ids) {
    assert.match(String(id), /1234567890|123456789012345678/, `плейсхолдер, не живий id: ${id}`);
  }
});

test("shipped samples are named exactly as the loader asks — case included", () => {
  // Windows і macOS регістр у іменах файлів ігнорують, Linux — ні. VPS Linux,
  // тож розбіжність на кшталт `Sources.sample.json` проти `sources.sample.json`
  // тут проходила б непомітно, а на проді фолбек свіжого клону не знайшов би
  // файл і система стартувала б з порожнім списком джерел.
  const present = new Set(fs.readdirSync(SAMPLES_DIR));
  for (const name of ["sources", "routing", "triage", "cron"]) {
    assert.ok(
      present.has(`${name}.sample.json`),
      `${name}.sample.json відсутній (є: ${[...present].filter((f) => /sample/i.test(f)).join(", ")})`,
    );
  }
});

test("flag(): true/1/yes/on and false/0/no/off in any case; anything else warns and keeps the default", async () => {
  const { flag } = await import("../src/config/app.config.js");
  const sink = [];
  for (const v of ["true", "True", " TRUE ", "1", "yes", "on"]) assert.equal(flag("X", v, false, sink), true);
  for (const v of ["false", "FALSE", "0", "no", "Off"]) assert.equal(flag("X", v, true, sink), false);
  assert.equal(flag("X", undefined, true, sink), true);
  assert.equal(flag("X", "", false, sink), false);
  assert.deepEqual(sink, []);
  assert.equal(flag("FLOW_DELIVERY_ENABLED", "enabled", false, sink), false);
  assert.match(sink[0], /FLOW_DELIVERY_ENABLED="enabled" is not true\/false — using false/);
});

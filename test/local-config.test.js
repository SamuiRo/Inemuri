import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadLocalConfig } from "../src/config/localConfig.js";

const CONFIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config");

/** Тимчасові файли з унікальним префіксом, щоб не зачепити реальні конфіги. */
function withFiles(files, fn) {
  const written = [];
  try {
    for (const [name, body] of Object.entries(files)) {
      const file = path.join(CONFIG_DIR, name);
      fs.writeFileSync(file, body, "utf8");
      written.push(file);
    }
    return fn();
  } finally {
    for (const file of written) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

const NAME = "__probe.local-config.test";

test("loadLocalConfig — prefers the local file over the sample", () => {
  withFiles({
    [`${NAME}.json`]: JSON.stringify({ who: "local" }),
    [`${NAME}.sample.json`]: JSON.stringify({ who: "sample" }),
  }, () => {
    const sink = [];
    assert.deepEqual(loadLocalConfig(NAME, { who: "fallback" }, sink), { who: "local" });
    assert.deepEqual(sink, [], "звичайний шлях не має попереджати");
  });
});

test("loadLocalConfig — falls back to the sample, loudly", () => {
  withFiles({ [`${NAME}.sample.json`]: JSON.stringify({ who: "sample" }) }, () => {
    const sink = [];
    assert.deepEqual(loadLocalConfig(NAME, { who: "fallback" }, sink), { who: "sample" });
    assert.equal(sink.length, 1);
    assert.match(sink[0], /not found/);
  });
});

test("loadLocalConfig — a fresh clone starts instead of failing to resolve", () => {
  // Регресія: раніше конфіги йшли через `import ... with { type: "json" }`,
  // а самі файли в .gitignore — тож клон падав ще до першого рядка логіки.
  const sink = [];
  assert.deepEqual(loadLocalConfig(NAME, { who: "fallback" }, sink), { who: "fallback" });
  assert.equal(sink.length, 1);
  assert.match(sink[0], /neither/);
});

test("loadLocalConfig — a broken local file throws, it does not silently become the sample", () => {
  // Тихо підмінити робочий конфіг семплом означає стартувати з чужими
  // призначеннями. Зламаний конфіг має зупинити старт.
  withFiles({
    [`${NAME}.json`]: "{ not json",
    [`${NAME}.sample.json`]: JSON.stringify({ who: "sample" }),
  }, () => {
    assert.throws(
      () => loadLocalConfig(NAME, { who: "fallback" }, []),
      /is not valid JSON/,
    );
  });
});

test("loadLocalConfig — a broken sample throws too", () => {
  withFiles({ [`${NAME}.sample.json`]: "{ also not json" }, () => {
    assert.throws(() => loadLocalConfig(NAME, { who: "fallback" }, []), /is not valid JSON/);
  });
});

test("the shipped sample configs parse", () => {
  // Вони — фолбек для свіжого клону: якщо семпл битий, клон не стартує.
  for (const name of ["sources.sample", "routing.sample", "cronjob.config.sample"]) {
    const parsed = loadLocalConfig(name, null, []);
    assert.ok(parsed && typeof parsed === "object", `${name}.json має парситись`);
  }
});

test("routing.sample carries no real channel ids", () => {
  const sample = loadLocalConfig("routing.sample", null, []);
  const ids = Object.values(sample.unsorted_destinations ?? {}).flat();
  assert.ok(ids.length > 0, "семпл має показувати форму");
  for (const id of ids) {
    assert.match(String(id), /1234567890|123456789012345678/, `плейсхолдер, не живий id: ${id}`);
  }
});

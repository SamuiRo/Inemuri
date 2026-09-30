/**
 * `npm test` — ганяє `node --test` на одноразовій базі, а не на робочій.
 *
 * Частина наборів (EnrichWorker, ProviderQuota, VisionCache) працює з
 * SQLite по-справжньому. До v4.43.1 вони відкривали database/pot.sqlite, і
 * тест EnrichWorker через `Post.claimPending()` забирав СПРАВЖНІ pending-пости
 * пілота, записуючи в них фейкові вердикти. Тепер кожен прогін:
 *
 *   1. створює тимчасову теку в os.tmpdir();
 *   2. піднімає в ній порожню базу тим самим шляхом, що й свіжа установка —
 *      scripts/bootstrap-schema.js, потім scripts/migrate.js;
 *   3. запускає тести з SQLITE_STORAGE на неї (див. app.config.js);
 *   4. прибирає теку.
 *
 * Аргументи передаються далі в `node --test`, напр.
 * `npm test -- test/enrich-worker.test.js`.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inemuri-test-"));
const env = {
  ...process.env,
  SQLITE_STORAGE: path.join(dir, "test.sqlite"),
  // Під development sync() перестворює таблиці; bootstrap і migrate самі це
  // відмовляються робити, тож задаємо явно.
  NODE_ENV: "production",
};

function run(args, label) {
  const res = spawnSync(process.execPath, args, { env, stdio: label ? "pipe" : "inherit" });
  if (res.status !== 0) {
    if (label) {
      process.stderr.write(`[run-tests] ${label} failed\n`);
      process.stderr.write(res.stdout ?? "");
      process.stderr.write(res.stderr ?? "");
    }
    return res.status ?? 1;
  }
  return 0;
}

let code;
try {
  code =
    run(["scripts/bootstrap-schema.js"], "db bootstrap") ||
    run(["scripts/migrate.js"], "db migrate");

  if (code === 0) {
    const files = process.argv.slice(2);
    code = run([
      "--test",
      "--test-concurrency=1",
      ...(files.length ? files : ["test/*.test.js"]),
    ]);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(code);

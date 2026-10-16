import { SQLITE_STORAGE, SQLITE_PROTECTED_STORAGES } from "../../src/config/app.config.js";

/**
 * Запобіжник для наборів, що пишуть у SQLite: вони мають бігти лише на
 * одноразовій базі, яку готує scripts/run-tests.js (`npm test`). Прямий
 * `node --test test/x.test.js` відкрив би робочу instance/database/pot.sqlite
 * (чи стару database/pot.sqlite) — саме так тест EnrichWorker колись
 * переписав вердикти пілота.
 */
export function assertTestDatabase() {
  if (SQLITE_PROTECTED_STORAGES.includes(SQLITE_STORAGE)) {
    throw new Error(
      `Refusing to run a database test against the working database (${SQLITE_STORAGE}). ` +
        "Run it through `npm test` (or `npm test -- <file>`), which uses a throwaway database.",
    );
  }
}

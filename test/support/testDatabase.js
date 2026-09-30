import { SQLITE_STORAGE, SQLITE_DEFAULT_STORAGE } from "../../src/config/app.config.js";

/**
 * Запобіжник для наборів, що пишуть у SQLite: вони мають бігти лише на
 * одноразовій базі, яку готує scripts/run-tests.js (`npm test`). Прямий
 * `node --test test/x.test.js` відкрив би робочу database/pot.sqlite — саме
 * так тест EnrichWorker колись переписав вердикти пілота.
 */
export function assertTestDatabase() {
  if (SQLITE_STORAGE === SQLITE_DEFAULT_STORAGE) {
    throw new Error(
      "Refusing to run a database test against database/pot.sqlite. " +
        "Run it through `npm test` (or `npm test -- <file>`), which uses a throwaway database.",
    );
  }
}

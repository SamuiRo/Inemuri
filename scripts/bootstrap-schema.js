/**
 * Створює відсутні таблиці в порожній базі.
 *
 * Потрібен тому, що **міграції самі підняти базу з нуля не можуть**:
 * `sources` і `source_states` з'явилися до системи міграцій і створюються
 * `database.sync()` під час старту застосунку, а не міграцією. Тому
 * `npm run migrate` на порожньому файлі падає на `describeTable("sources")`
 * у міграції 002.
 *
 * Це не обхід і не заміна міграціям: порядок для свіжої установки —
 *
 *   npm run db:bootstrap   # sync() створює таблиці з моделей
 *   npm run migrate        # застосовує все, чого sync() не знає (індекси,
 *                          # backfill, ALTER-и, ледгер schema_migrations)
 *
 * На вже наповненій базі bootstrap — no-op: `sync()` без `force`/`alter`
 * створює лише те, чого немає, і нічого не переписує. Саме тому його
 * безпечно тримати в CI, де база щоразу порожня.
 *
 * ВАЖЛИВО: під `NODE_ENV=development` database.sync() використовує
 * `force: true` і перестворює таблиці. Скрипт це блокує, як і migrate.js.
 */

import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { NODE_ENV } from "../src/config/app.config.js";
import { print } from "../src/shared/utils.js";
// Реєструє всі моделі на спільному інстансі sequelize — без цього
// sync() не має чого створювати.
import "../src/module/teapot/models/index.js";

if (NODE_ENV === "development") {
  print("Refusing to run under NODE_ENV=development (sync uses force: true)", "error");
  process.exit(1);
}

try {
  await database.connect();

  const qi = database.sequelize.getQueryInterface();
  const before = (await qi.showAllTables()).map(String);

  await database.sync();

  const after = (await qi.showAllTables()).map(String);
  const created = after.filter((t) => !before.includes(t));

  if (created.length === 0) {
    print(`Schema already present (${after.length} tables) — nothing to do`, "info");
  } else {
    print(`Created ${created.length} table(s): ${created.join(", ")}`, "success");
  }
  process.exit(0);
} catch (error) {
  print(`Bootstrap failed: ${error.message}`, "error");
  console.error(error);
  process.exit(1);
}

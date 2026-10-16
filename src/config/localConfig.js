import fs from "fs";
import path from "path";

import { instanceLayout, DEFAULT_INSTANCE_DIR, LEGACY } from "./instance.js";

/**
 * Читає конфіг конкретного розгортання з instance/config/<name>.json.
 *
 * Такі файли в .gitignore: у кожного розгортання свої канали, ключі й
 * призначення. Але раніше вони імпортувалися статично
 * (`import ... with { type: "json" }`), а отже **свіжий клон не стартував
 * узагалі** — module resolution падав ще до першого рядка логіки. Звідси
 * фолбек на `<name>.sample.json`, який у репозиторії є завжди — поруч, у
 * тій самій instance/config/, щоб було видно, що заповнювати.
 *
 * Порядок: instance/config/<name>.json → старе місце (src/config, до
 * v4.67.0; з попередженням «npm run instance:init») → семпл.
 *
 * Різниця між "немає" і "зламаний" тут навмисна:
 *   - файлу немає         -> беремо sample, гучно попереджаємо;
 *   - файл є, але битий   -> КИДАЄМО помилку.
 *
 * Друге — бо тихо підмінити робочий конфіг семплом означає запустити систему
 * з чужими призначеннями. Зламаний конфіг має зупинити старт, а не тихо
 * змінити поведінку.
 *
 * @param {string} name      Базове імʼя без розширення ("sources", "routing").
 * @param {object} fallback  Якщо немає ні файлу, ні семпла.
 * @param {string[]} [sink]  Куди складати попередження (CONFIG_WARNINGS).
 * @param {{ dir?: string, legacyDir?: string|null, legacyName?: string }} [where]
 *   dir — instance/config; legacyDir — старе місце (null — не шукати);
 *   legacyName — ім'я там, якщо інше (cron ← cronjob.config).
 */
export function loadLocalConfig(name, fallback, sink = [], where = {}) {
  const dir = where.dir ?? instanceLayout(DEFAULT_INSTANCE_DIR).config;
  const legacyDir = where.legacyDir === undefined ? LEGACY.config : where.legacyDir;
  const local = path.join(dir, `${name}.json`);
  const sample = path.join(dir, `${name}.sample.json`);

  if (fs.existsSync(local)) {
    return parseOrThrow(local, name);
  }

  if (legacyDir) {
    const old = path.join(legacyDir, `${where.legacyName ?? name}.json`);
    if (fs.existsSync(old)) {
      sink.push(
        `${name}.json is in the old place (${old}) — run "npm run instance:init" to move it to instance/config/.`,
      );
      return parseOrThrow(old, name);
    }
  }

  if (fs.existsSync(sample)) {
    sink.push(
      `${name}.json not found — falling back to ${name}.sample.json. ` +
        `Copy it and fill in your own values.`,
    );
    return parseOrThrow(sample, name);
  }

  sink.push(`neither ${name}.json nor ${name}.sample.json exists — using built-in defaults`);
  return fallback;
}

function parseOrThrow(file, name) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path.basename(file)}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path.basename(file)} is not valid JSON: ${error.message}. ` +
        `Fix it or remove it to fall back to ${name}.sample.json.`,
    );
  }
}

export default loadLocalConfig;

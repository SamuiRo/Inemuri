import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Читає конфіг конкретного розгортання з src/config/<name>.json.
 *
 * Такі файли в .gitignore: у кожного розгортання свої канали, ключі й
 * призначення. Але раніше вони імпортувалися статично
 * (`import ... with { type: "json" }`), а отже **свіжий клон не стартував
 * узагалі** — module resolution падав ще до першого рядка логіки. Звідси
 * фолбек на `<name>.sample.json`, який у репозиторії є завжди.
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
 */
export function loadLocalConfig(name, fallback, sink = []) {
  const local = path.join(CONFIG_DIR, `${name}.json`);
  const sample = path.join(CONFIG_DIR, `${name}.sample.json`);

  if (fs.existsSync(local)) {
    return parseOrThrow(local, name);
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

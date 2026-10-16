import fs from "fs/promises";
import path from "path";
import {
  DISCORD_PROVISION_DIR, DISCORD_LEGACY_SERVERS_DIR, DISCORD_LEGACY_MESSAGES_DIR,
} from "../../../../config/app.config.js";

/**
 * Конфіги серверів: instance/provision/<name>/server.json, а поруч у тій
 * самій теці — тексти й картинки, на які він посилається ("file": "rules.md").
 * Один сервер — одна тека: переносити й правити його цілком.
 *
 * До v4.67.0 конфіг лежав у src/config/discordapp/servers/<name>.json, а
 * тексти — у messages/ (посилання "<name>/rules.md"). Такий сервер ще
 * читається, поки його не перенесе `npm run instance:init`.
 *
 * Читаються на кожну команду, не на старті: правка конфігу діє одразу, без
 * рестарту, — саме так зручно ітерувати «змінив → plan → apply».
 * Теки й файли `*.sample` — приклади, не конфіги.
 */

// Лише прості імена: ім'я приходить з опції команди і не повинно вивести за теку.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SERVER_FILE = "server.json";

async function entries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Де лежить конфіг: тека instance/provision/<name>/ або старий servers/<name>.json. */
async function locate(name) {
  const folder = path.join(DISCORD_PROVISION_DIR, name);
  const file = path.join(folder, SERVER_FILE);
  try {
    await fs.access(file);
    return { file, baseDir: folder, shown: `provision/${name}/${SERVER_FILE}` };
  } catch {
    // далі — старе місце
  }
  const legacy = path.join(DISCORD_LEGACY_SERVERS_DIR, `${name}.json`);
  try {
    await fs.access(legacy);
    return { file: legacy, baseDir: DISCORD_LEGACY_MESSAGES_DIR, shown: `servers/${name}.json (old place — npm run instance:init)` };
  } catch {
    return null;
  }
}

export async function listServerConfigs() {
  const names = new Set();
  for (const e of await entries(DISCORD_PROVISION_DIR)) {
    if (!e.isDirectory() || e.name.endsWith(".sample") || !NAME_RE.test(e.name)) continue;
    try {
      await fs.access(path.join(DISCORD_PROVISION_DIR, e.name, SERVER_FILE));
      names.add(e.name);
    } catch {
      // тека без server.json — не сервер
    }
  }
  for (const e of await entries(DISCORD_LEGACY_SERVERS_DIR)) {
    if (e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".sample.json")) names.add(e.name.slice(0, -".json".length));
  }
  return [...names].sort();
}

/**
 * @returns {Promise<{ name: string, file: string, raw: object, baseDir: string }>}
 *   file — як показувати оператору; baseDir — звідки читати тексти й картинки.
 * @throws {Error} Людський текст: файлу немає або він не JSON.
 */
export async function loadServerConfig(name) {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid config name.`);
  const where = await locate(name);
  if (!where) {
    throw new Error(`There is no \`provision/${name}/${SERVER_FILE}\`. Configs: ${(await listServerConfigs()).join(", ") || "none yet"}.`);
  }
  let text;
  try {
    text = await fs.readFile(where.file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read \`${where.shown}\`: ${error.message}`);
  }
  try {
    return { name, file: where.shown, raw: JSON.parse(text), baseDir: where.baseDir };
  } catch (error) {
    throw new Error(`\`${where.shown}\` is not valid JSON: ${error.message}`);
  }
}

/**
 * Конфіг для сервера: названий явно, або єдиний, чий guildId збігається.
 * @throws {Error} Людський текст, якщо конфіг не знайдено або вибір неоднозначний.
 */
export async function resolveServerConfig(guildId, name = null) {
  if (name) {
    const config = await loadServerConfig(name);
    if (String(config.raw.guildId) !== guildId) {
      throw new Error(`\`${config.file}\` is for server ${config.raw.guildId}, not this one.`);
    }
    return config;
  }

  const matches = [];
  const broken = [];
  for (const candidate of await listServerConfigs()) {
    try {
      const config = await loadServerConfig(candidate);
      if (String(config.raw.guildId) === guildId) matches.push(config);
    } catch (error) {
      // Зламаний файл міг бути саме конфігом цього сервера — про це треба сказати.
      broken.push(error.message);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Several configs are for this server (${matches.map((c) => c.name).join(", ")}) — pick one with \`server:\`.`);
  }
  throw new Error(
    `No config for this server (id ${guildId}). Copy \`instance/provision/example.sample/\` ` +
      "to `instance/provision/<name>/` and set the guildId in its server.json." +
      (broken.length ? `\nCould not read: ${broken.join(" ")}` : ""),
  );
}

/** Шлях усередині теки сервера; вихід за неї — помилка. */
function inside(baseDir, file) {
  const fullPath = path.resolve(baseDir, file);
  if (!fullPath.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`${file} is outside the server's folder`);
  }
  return fullPath;
}

/**
 * Двійковий файл (аватар персони) з теки сервера.
 * @throws {Error} Людський текст: файлу немає.
 */
export async function loadMessageAsset(file, baseDir) {
  const fullPath = inside(baseDir, file);
  try {
    return await fs.readFile(fullPath);
  } catch {
    throw new Error(`there is no \`${file}\` next to the server config`);
  }
}

/**
 * Текст повідомлення з теки сервера. Шлях уже перевірив schema.js; тут —
 * ще раз, що він не вийшов за теку.
 * @throws {Error} Людський текст: файлу немає.
 */
export async function loadMessageBody(file, baseDir) {
  const fullPath = inside(baseDir, file);
  try {
    // Кінці рядків — як у Discord; BOM з Windows-редакторів — геть.
    return (await fs.readFile(fullPath, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
  } catch {
    throw new Error(`there is no \`${file}\` next to the server config`);
  }
}

import fs from "fs/promises";
import path from "path";
import { DISCORD_MESSAGES_DIR, DISCORD_SERVERS_DIR } from "../../../../config/app.config.js";

/**
 * Конфіги серверів: src/config/discordapp/servers/<name>.json.
 *
 * Читаються на кожну команду, не на старті: правка конфігу діє одразу, без
 * рестарту, — саме так зручно ітерувати «змінив → plan → apply».
 * `*.sample.json` — приклади, не конфіги.
 */

// Лише прості імена: ім'я приходить з опції команди і не повинно вивести за теку.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export async function listServerConfigs() {
  let files;
  try {
    files = await fs.readdir(DISCORD_SERVERS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json") && !file.endsWith(".sample.json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/**
 * @returns {Promise<{ name: string, file: string, raw: object }>}
 * @throws {Error} Людський текст: файлу немає або він не JSON.
 */
export async function loadServerConfig(name) {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid config name.`);
  const file = `${name}.json`;
  let text;
  try {
    text = await fs.readFile(path.join(DISCORD_SERVERS_DIR, file), "utf8");
  } catch {
    throw new Error(`There is no \`servers/${file}\`. Configs: ${(await listServerConfigs()).join(", ") || "none yet"}.`);
  }
  try {
    return { name, file, raw: JSON.parse(text) };
  } catch (error) {
    throw new Error(`\`servers/${file}\` is not valid JSON: ${error.message}`);
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
      throw new Error(`\`servers/${config.file}\` is for server ${config.raw.guildId}, not this one.`);
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
    `No config for this server (id ${guildId}). Copy \`src/config/discordapp/servers/example.sample.json\` ` +
      "to `<name>.json` and set its guildId." +
      (broken.length ? `\nCould not read: ${broken.join(" ")}` : ""),
  );
}

/**
 * Текст повідомлення з src/config/discordapp/messages/. Шлях уже перевірив
 * schema.js; тут — ще раз, що він не вийшов за теку.
 * @throws {Error} Людський текст: файлу немає.
 */
export async function loadMessageBody(file) {
  const fullPath = path.resolve(DISCORD_MESSAGES_DIR, file);
  if (!fullPath.startsWith(path.resolve(DISCORD_MESSAGES_DIR) + path.sep)) {
    throw new Error(`${file} is outside the messages folder`);
  }
  try {
    // Кінці рядків — як у Discord; BOM з Windows-редакторів — геть.
    return (await fs.readFile(fullPath, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd();
  } catch {
    throw new Error(`there is no \`messages/${file}\``);
  }
}

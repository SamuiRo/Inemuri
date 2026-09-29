/**
 * customId компонентів (кнопок, меню) — `<prefix>:<action>:<arg>:<arg>...`.
 *
 * Компоненти без стану (docs/DISCORDAPP.md D11): усе, що потрібно обробнику,
 * закодовано в самому id, тож кнопка працює після будь-якого рестарту і без
 * таблиці за нею. `prefix` вибирає обробник у CommandRegistry.
 */

const SEPARATOR = ":";
// Ліміт Discord на довжину custom_id.
const MAX_LENGTH = 100;

/**
 * @param {string} prefix
 * @param {string} action
 * @param {...(string|number)} args
 * @returns {string}
 */
export function buildCustomId(prefix, action, ...args) {
  const parts = [prefix, action, ...args].map(String);
  if (parts.some((part) => part === "" || part.includes(SEPARATOR))) {
    throw new Error(`customId parts must be non-empty and free of "${SEPARATOR}": ${parts.join(" | ")}`);
  }
  const id = parts.join(SEPARATOR);
  if (id.length > MAX_LENGTH) {
    throw new Error(`customId is ${id.length} chars, Discord allows ${MAX_LENGTH}: ${id}`);
  }
  return id;
}

/**
 * @param {string} customId
 * @returns {{ prefix: string, action: (string|null), args: string[] }}
 */
export function parseCustomId(customId) {
  const [prefix, action = null, ...args] = String(customId).split(SEPARATOR);
  return { prefix, action, args };
}

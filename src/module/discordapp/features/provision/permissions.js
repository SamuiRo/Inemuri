import { PermissionFlagsBits } from "discord.js";

/**
 * Дозволи Discord як імена (`"ViewChannel"`) ↔ біти (BigInt). Конфіг пише
 * імена, Discord і порівняння працюють з бітами.
 */

export const PERMISSION_NAMES = Object.keys(PermissionFlagsBits);

/** Невідомі імена зі списку — для валідатора. */
export function unknownPermissions(names) {
  return names.filter((name) => !(name in PermissionFlagsBits));
}

/** ["ViewChannel", "SendMessages"] → BigInt. Невідомі імена ігноруються (їх ловить валідатор). */
export function toBits(names = []) {
  return names.reduce((bits, name) => bits | (PermissionFlagsBits[name] ?? 0n), 0n);
}

/** BigInt → імена встановлених бітів, у порядку PermissionFlagsBits. */
export function bitNames(bits) {
  return PERMISSION_NAMES.filter((name) => (bits & PermissionFlagsBits[name]) !== 0n);
}

/**
 * Різниця двох наборів бітів як `+Name −Name`. Для читабельного плану.
 * @returns {string}
 */
export function describeBitsChange(from, to) {
  const added = bitNames(to & ~from).map((name) => `+${name}`);
  const removed = bitNames(from & ~to).map((name) => `−${name}`);
  return [...added, ...removed].join(" ") || "no change";
}

/** Що бот дає собі в кожному приватному каналі (docs/DISCORDAPP.md, модель прав). */
export const BOT_CHANNEL_ALLOW = toBits([
  "ViewChannel",
  "ReadMessageHistory",
  "SendMessages",
  "EmbedLinks",
  "AttachFiles",
]);

/** Що бачать ролі архіву в архівній категорії. */
export const ARCHIVE_ROLE_ALLOW = toBits(["ViewChannel", "ReadMessageHistory"]);

export const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;

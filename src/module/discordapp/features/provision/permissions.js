import { PermissionFlagsBits } from "discord.js";

/**
 * Дозволи Discord як імена (`"ViewChannel"`) ↔ біти (BigInt). Конфіг пише
 * імена, Discord і порівняння працюють з бітами.
 */

export const PERMISSION_NAMES = Object.keys(PermissionFlagsBits);

// Застарілі аліаси з тим самим бітом, що й актуальне ім'я. У конфігу вони
// приймаються, але в текст плану не потрапляють — інакше біт друкувався б двічі.
const DEPRECATED_ALIASES = new Set(["ManageEmojisAndStickers"]);
const DISPLAY_NAMES = PERMISSION_NAMES.filter((name) => !DEPRECATED_ALIASES.has(name));

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
  return DISPLAY_NAMES.filter((name) => (bits & PermissionFlagsBits[name]) !== 0n);
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

/**
 * Дозволи, з якими роль не можна видавати кнопкою (docs/DISCORDAPP.md D10):
 * одна опечатка в конфігу не повинна перетворитись на «натисни — отримай
 * адмінку».
 */
export const DANGEROUS_PERMISSIONS = toBits([
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "ManageWebhooks",
  "ManageGuildExpressions",
  "ManageEvents",
  "ManageThreads",
  "ManageMessages",
  "ManageNicknames",
  "BanMembers",
  "KickMembers",
  "ModerateMembers",
  "MentionEveryone",
  "ViewAuditLog",
]);

/** Небезпечні дозволи з набору, іменами. Порожньо — роль можна видавати кнопкою. */
export function dangerousIn(bits) {
  return bitNames(bits & DANGEROUS_PERMISSIONS);
}

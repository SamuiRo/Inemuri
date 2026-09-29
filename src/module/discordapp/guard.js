/**
 * Хто може запускати що і де — чиста функція, без Discord.
 *
 * Порядок перевірок має значення: спершу «де» (сервер), потім «хто». Відмова
 * за сервером не повинна розкривати, що команда адмінська.
 *
 * @param {{ admin?: boolean, userId: string, guildId: (string|null) }} request
 * @param {{ whitelist: string[], guildIds: string[] }} policy
 *   whitelist — адміни (DISCORD_COMMAND_WHITELIST); порожній = нікого (D7).
 *   guildIds  — сервери, які обслуговуємо (DISCORD_GUILD_IDS); порожній = усі (D8).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkAccess({ admin = false, userId, guildId }, { whitelist, guildIds }) {
  if (!guildId) {
    return { ok: false, reason: "Commands work only inside a server." };
  }
  if (guildIds.length > 0 && !guildIds.includes(guildId)) {
    return { ok: false, reason: "This server is not managed by Inemuri." };
  }
  if (admin && !whitelist.includes(userId)) {
    return { ok: false, reason: "You don't have permission to use this." };
  }
  return { ok: true };
}

/** Чи обслуговує discordapp цей сервер (D8). */
export function isServedGuild(guildId, guildIds) {
  return guildIds.length === 0 || guildIds.includes(guildId);
}

import { OverwriteType, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import { channelKind } from "../../channelKinds.js";

/**
 * Поточний стан сервера як прості дані для planner.js. Єдине місце провіжну,
 * що читає Discord; усе нижче — чисті функції над цим знімком.
 *
 * Кожен виклик читає сервер наново (REST), а не з кешу: applier знімає стан
 * між фазами, і створене щойно має бути видно.
 *
 * @param {import("discord.js").Guild} guild
 * @param {object[]} [state]  Рядки discord_resources: повідомлення з них
 *   перевіряються на існування (по запиту на кожне — їх одиниці).
 */
export async function readGuild(guild, state = []) {
  const [roles, channels, me] = await Promise.all([
    guild.roles.fetch(undefined, { force: true }),
    guild.channels.fetch(undefined, { force: true }),
    guild.members.fetchMe({ force: true }),
  ]);

  const messages = await existingMessages(channels, state);

  return {
    guildId: guild.id,
    name: guild.name,
    community: guild.features.includes("COMMUNITY"),
    everyoneId: guild.roles.everyone.id,
    bot: {
      userId: me.id,
      // Роль інтеграції бота; її створює Discord при запрошенні.
      roleId: me.roles.botRole?.id ?? null,
      highestPosition: me.roles.highest.position,
      admin: me.permissions.has(PermissionFlagsBits.Administrator),
    },
    roles: [...roles.values()]
      .filter((role) => role.id !== guild.id)
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.colors?.primaryColor ?? 0,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.bitfield,
        position: role.position,
        // Ролі інтеграцій (боти, буст) Discord не дає редагувати й видавати.
        managed: role.managed || role.tags?.premiumSubscriberRole === true,
      })),
    channels: [...channels.values()]
      .filter((channel) => channel && channelKind(channel.type) && !channel.isThread())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        kind: channelKind(channel.type),
        parentId: channel.parentId ?? null,
        position: channel.rawPosition,
        topic: channel.topic ?? null,
        nsfw: Boolean(channel.nsfw),
        slowmode: channel.rateLimitPerUser ?? 0,
        overwrites: [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type === OverwriteType.Member ? "member" : "role",
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield,
        })),
      })),
    messages,
  };
}

/** Керовані повідомлення, які ще є в Discord: [{ id, channelId }]. */
async function existingMessages(channels, state) {
  const found = [];
  for (const row of state.filter((r) => r.kind === "message" && r.parent_id)) {
    const channel = channels.get(row.parent_id);
    if (!channel?.messages) continue;
    try {
      await channel.messages.fetch({ message: row.discord_id, force: true });
      found.push({ id: row.discord_id, channelId: row.parent_id });
    } catch (error) {
      // Лише «такого повідомлення немає» означає, що його видалили вручну, —
      // тоді planner запропонує опублікувати знову. Мережевий збій чи брак
      // прав виглядав би так само, і повтор apply дав би дублікат.
      if (error.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
    }
  }
  return found;
}

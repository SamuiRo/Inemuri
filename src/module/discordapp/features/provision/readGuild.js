import { OverwriteType, PermissionFlagsBits } from "discord.js";
import { channelKind } from "../../channelKinds.js";

/**
 * Поточний стан сервера як прості дані для planner.js. Єдине місце провіжну,
 * що читає Discord; усе нижче — чисті функції над цим знімком.
 *
 * Кожен виклик читає сервер наново (REST), а не з кешу: applier знімає стан
 * між фазами, і створене щойно має бути видно.
 *
 * @param {import("discord.js").Guild} guild
 */
export async function readGuild(guild) {
  const [roles, channels, me] = await Promise.all([
    guild.roles.fetch(undefined, { force: true }),
    guild.channels.fetch(undefined, { force: true }),
    guild.members.fetchMe({ force: true }),
  ]);

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
  };
}

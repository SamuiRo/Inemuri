import { resolveServerConfig } from "./configStore.js";
import { validateServerConfig } from "./schema.js";
import { readGuild } from "./readGuild.js";
import { applyBlockers, planProvision } from "./planner.js";
import { DiscordResource } from "../../../teapot/models/index.js";

/**
 * Збирає все для плану: конфіг → валідація → поточний сервер і стан → план.
 * Оболонка над чистими функціями; команди і applier беруть план звідси.
 *
 * @param {import("discord.js").Guild} guild
 * @param {string|null} configName  Явне ім'я конфігу або null — знайти за guildId.
 * @returns {Promise<{ config, errors: string[] } | { config, errors: [], desired, current, plan, blockers: string[] }>}
 */
export async function preparePlan(guild, configName = null) {
  const config = await resolveServerConfig(guild.id, configName);
  const { errors, desired } = validateServerConfig(config.raw);
  if (errors.length) return { config, errors };

  const current = await readGuild(guild);
  const state = await DiscordResource.forGuild(guild.id);
  const plan = planProvision(desired, current, state);
  return { config, errors: [], desired, current, plan, blockers: applyBlockers(current) };
}

/** Помилки валідації конфігу → текст. */
export function formatConfigErrors(config, errors) {
  return [
    `**\`servers/${config.file}\` has ${errors.length} problem(s)** — nothing was read from the server:`,
    ...errors.map((error) => `✖ ${error}`),
  ].join("\n");
}

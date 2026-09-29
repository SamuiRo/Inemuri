import { loadMessageBody, resolveServerConfig } from "./configStore.js";
import { bodyProblem } from "./messages.js";
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
 * @param {{ loadState?: (guildId: string) => Promise<object[]> }} [options]
 *   Звідки брати стан; за замовчуванням — таблиця discord_resources.
 * @returns {Promise<{ config, errors: string[] } | { config, errors: [], desired, current, plan, blockers: string[] }>}
 */
export async function preparePlan(guild, configName = null, { loadState = (id) => DiscordResource.forGuild(id) } = {}) {
  const config = await resolveServerConfig(guild.id, configName);
  const { errors, desired } = validateServerConfig(config.raw);
  if (errors.length) return { config, errors };
  const bodyErrors = await attachBodies(desired);
  if (bodyErrors.length) return { config, errors: bodyErrors };

  const state = await loadState(guild.id);
  const current = await readGuild(guild, state);
  const plan = planProvision(desired, current, state);
  return { config, errors: [], desired, current, plan, blockers: applyBlockers(current) };
}

/**
 * Тексти повідомлень з .md-файлів → `message.body`. schema.js чиста й файлів
 * не читає, тож це робиться тут; ліміти Discord перевіряються одразу, щоб не
 * впасти посеред apply.
 * @returns {Promise<string[]>} Помилки.
 */
async function attachBodies(desired) {
  const errors = [];
  for (const message of desired.messages.filter((m) => m.kind === "text")) {
    try {
      message.body = await loadMessageBody(message.file);
    } catch (error) {
      errors.push(`message "${message.key}": ${error.message}`);
      continue;
    }
    const problem = bodyProblem(message);
    if (problem) errors.push(`message "${message.key}": ${problem}`);
  }
  return errors;
}

/** Помилки валідації конфігу → текст. */
export function formatConfigErrors(config, errors) {
  return [
    `**\`servers/${config.file}\` has ${errors.length} problem(s)** — nothing was read from the server:`,
    ...errors.map((error) => `✖ ${error}`),
  ].join("\n");
}

// Сервери, на яких саме йде apply.
const applying = new Set();

/**
 * Один apply на сервер за раз. Два паралельні apply бачили б той самий план
 * і обидва створили б ті самі канали.
 */
export async function withGuildLock(guildId, fn) {
  if (applying.has(guildId)) {
    return "⏳ An apply is already running on this server — wait for it to finish.";
  }
  applying.add(guildId);
  try {
    return await fn();
  } finally {
    applying.delete(guildId);
  }
}

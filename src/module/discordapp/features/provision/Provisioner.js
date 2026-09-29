import fs from "fs/promises";
import path from "path";
import { loadMessageBody, resolveServerConfig } from "./configStore.js";
import { exportConfig } from "./exporter.js";
import { DISCORD_EXPORT_DIR } from "../../../../config/app.config.js";
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

// Скільки пропущеного перелічувати у відповіді, решту — числом.
const SKIPPED_SHOWN = 10;

/**
 * Сервер → конфіг (exporter.js), записаний у exports/. У теку конфігів
 * нічого не пишеться: експорт — чернетка, яку людина переглядає й копіює сама,
 * а не новий конфіг, що одразу почав би діяти.
 *
 * @returns {Promise<{ fileName: string, data: Buffer, summary: string }>}
 */
export async function exportServer(guild, { loadState = (id) => DiscordResource.forGuild(id) } = {}) {
  const state = await loadState(guild.id);
  const current = await readGuild(guild, state);
  const { config, skipped } = exportConfig(current, state);
  const slug = guild.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
  const fileName = `config-${slug}.json`;
  const data = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");

  await fs.mkdir(DISCORD_EXPORT_DIR, { recursive: true });
  await fs.writeFile(path.join(DISCORD_EXPORT_DIR, fileName), data);
  return { fileName, data, summary: describeExport(config, skipped, fileName) };
}

/** Текст відповіді на експорт. Чиста функція. */
export function describeExport(config, skipped, fileName) {
  const channels = config.channels.length + config.categories.reduce((n, c) => n + c.channels.length, 0);
  const lines = [
    `📤 Exported ${config.roles.length} roles, ${config.categories.length} categories, ${channels} channels` +
      `${config.automod ? `, ${config.automod.length} AutoMod rules` : ""} → \`exports/${fileName}\`.`,
    "Review it, copy it to `src/config/discordapp/servers/<name>.json`, then `/provision plan` — " +
      "it should only adopt, plus the bot's own access to private channels. Messages are not exported.",
  ];
  if (skipped.length) {
    lines.push("", `Left out (the config format cannot express these):`);
    lines.push(...skipped.slice(0, SKIPPED_SHOWN).map((item) => `- ${item}`));
    if (skipped.length > SKIPPED_SHOWN) lines.push(`- …and ${skipped.length - SKIPPED_SHOWN} more`);
  }
  return lines.join("\n");
}

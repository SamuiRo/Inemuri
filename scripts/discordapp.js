/**
 * discordapp з термінала — те саме, що slash-команди, без Discord-клієнта.
 *
 *   node scripts/discordapp.js check <guildId> [config]         лише читання
 *   node scripts/discordapp.js apply <guildId> [config] [--yes]  провіжн
 *
 * check показує те, що інакше з'ясовується методом спроб:
 *   - під ким бот залогінений, чи він на сервері, чи Community сервер;
 *   - де роль бота і яких прав із потрібних бракує (docs/DISCORDAPP.md § Setup);
 *   - чи зареєстровані slash-команди;
 *   - чи працює Message Content intent (без нього експорт порожній);
 *   - план провіжну для конфігу сервера, якщо конфіг є.
 *
 * apply без --yes лише показує план; з --yes — застосовує, як кнопка «Apply».
 *
 * Відкриває власну gateway-сесію тим самим токеном, але не слухає interactions
 * — працюючому сервісу вона не заважає.
 */

import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { DISCORD_BOT_TOKEN } from "../src/config/app.config.js";
import database from "../src/module/teapot/sqlite/sqlite_db.js";
import { DiscordResource } from "../src/module/teapot/models/index.js";
import { preparePlan, formatConfigErrors } from "../src/module/discordapp/features/provision/Provisioner.js";
import { formatPlan } from "../src/module/discordapp/features/provision/formatPlan.js";
import { actionableOps } from "../src/module/discordapp/features/provision/planner.js";
import { applyProvision, formatApplyLog } from "../src/module/discordapp/features/provision/applier.js";
import { bitNames } from "../src/module/discordapp/features/provision/permissions.js";
import { channelKind } from "../src/module/discordapp/channelKinds.js";

// Права для звичайної роботи — ті самі, що в посиланні-запрошенні.
const NEEDED = ["ViewChannel", "SendMessages", "EmbedLinks", "AttachFiles", "ReadMessageHistory", "ManageRoles", "ManageThreads"];

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const [action, guildId, configName = null] = args.filter((arg) => arg !== "--yes");
if (!["check", "apply"].includes(action) || !guildId) {
  console.error("Usage: node scripts/discordapp.js check|apply <guildId> [config] [--yes]");
  process.exit(1);
}
if (!DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN is not set in .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ready = new Promise((resolve) => client.once("clientReady", resolve));

try {
  await client.login(DISCORD_BOT_TOKEN);
  await ready;
  console.log(`Bot: ${client.user.tag} (application ${client.application.id})`);

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    console.log(`✖ The bot is not in server ${guildId}. Invite it — docs/DISCORDAPP.md § Setup.`);
    process.exit(1);
  }
  console.log(`Server: ${guild.name} — ${guild.features.includes("COMMUNITY") ? "Community" : "not Community"}`);

  if (action === "check") {
    await checkBot(guild);
    await checkCommands(guild);
    await checkMessageContent(guild);
    await showPlan(guild, loadStateOrEmpty);
  } else {
    await apply(guild);
  }
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.destroy();
  await database.sequelize.close().catch(() => {});
}

// ── check ──────────────────────────────────────────────────────────────────

async function checkBot(guild) {
  const me = await guild.members.fetchMe();
  const roles = await guild.roles.fetch();
  const top = [...roles.values()].sort((a, b) => b.position - a.position);
  const rank = top.findIndex((role) => role.id === me.roles.highest.id) + 1;
  console.log(`\nBot's highest role: @${me.roles.highest.name} — ${rank} of ${top.length} from the top`);
  const above = top.slice(0, rank - 1).filter((role) => !role.managed).map((role) => `@${role.name}`);
  if (above.length) console.log(`  Roles above it (the bot cannot manage these): ${above.join(", ")}`);

  const has = me.permissions;
  if (has.has(PermissionFlagsBits.Administrator)) {
    console.log("  Administrator: yes — fine for apply; take it away afterwards");
  } else {
    const missing = NEEDED.filter((name) => !has.has(PermissionFlagsBits[name]));
    console.log(missing.length ? `  ✖ Missing: ${missing.join(", ")}` : "  ✓ Has every permission needed for normal operation");
    console.log("  Administrator: no — apply will ask for it");
  }
  console.log(`  Server-wide permissions: ${bitNames(has.bitfield).join(", ") || "none"}`);
}

async function checkCommands(guild) {
  const commands = await client.application.commands.fetch({ guildId: guild.id }).catch((error) => error);
  if (commands instanceof Error) {
    console.log(`\n✖ Cannot read slash commands here (${commands.message}) — re-invite with the applications.commands scope`);
    return;
  }
  const names = [...commands.values()].map((command) => `/${command.name}`);
  console.log(`\nSlash commands registered here: ${names.join(", ") || "none — start the service with this server in DISCORD_GUILD_IDS"}`);
}

/**
 * Без Message Content intent Discord віддає чужі повідомлення з порожнім
 * текстом. Перевіряємо на останніх повідомленнях першого каналу, де вони є.
 */
async function checkMessageContent(guild) {
  const me = await guild.members.fetchMe();
  const channels = [...(await guild.channels.fetch()).values()]
    .filter((channel) => channel && ["text", "announcement"].includes(channelKind(channel.type)))
    .filter((channel) => channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));

  for (const channel of channels) {
    const messages = [...(await channel.messages.fetch({ limit: 20 })).values()]
      .filter((message) => !message.author.bot && !message.system);
    if (!messages.length) continue;
    const withText = messages.filter((m) => m.content || m.attachments.size || m.embeds.length).length;
    console.log(withText
      ? `\n✓ Message Content works (#${channel.name}: ${withText}/${messages.length} messages have content)`
      : `\n✖ #${channel.name}: ${messages.length} messages, all empty — enable Message Content Intent in the Developer Portal`);
    return;
  }
  console.log("\nMessage Content: no human messages to check with yet — post one and run again");
}

// ── plan / apply ───────────────────────────────────────────────────────────

async function showPlan(guild, loadState) {
  let prepared;
  try {
    prepared = await preparePlan(guild, configName, { loadState });
  } catch (error) {
    console.log(`\nProvisioning: ${error.message}`);
    return null;
  }
  console.log("");
  console.log(prepared.errors.length
    ? formatConfigErrors(prepared.config, prepared.errors)
    : formatPlan(prepared.plan, { configName: prepared.config.file, blockers: prepared.blockers }));
  return prepared;
}

async function apply(guild) {
  // Для apply стан обов'язковий: без нього архівування й відновлення не знали
  // б, що кероване, а що ні.
  const prepared = await showPlan(guild, (id) => DiscordResource.forGuild(id));
  if (!prepared || prepared.errors.length) return fail("Nothing applied.");
  const { plan, blockers, desired } = prepared;
  if (plan.errors.length || blockers.length) return fail("Nothing applied — fix the above first.");
  if (!actionableOps(plan).length) return;
  if (!confirmed) {
    console.log("\nNothing applied. Re-run with --yes to apply this plan.");
    return;
  }

  console.log("");
  const log = await applyProvision({ guild, desired, onPhase: (phase) => console.log(`… ${phase}`) });
  console.log(`\n${formatApplyLog(log, { guildName: guild.name })}`);
  if (log.some((entry) => !entry.ok)) process.exitCode = 1;
}

function fail(message) {
  console.log(`\n${message}`);
  process.exitCode = 1;
}

/**
 * Стан з бази, а якщо таблиці ще немає (не було `npm run migrate`) — порожній:
 * план тоді показує все як нове або прийняте за назвою. check базу не змінює.
 */
async function loadStateOrEmpty(id) {
  try {
    return await DiscordResource.forGuild(id);
  } catch {
    console.log("\n(discord_resources is not readable — run `npm run migrate`; planning as if nothing is managed yet)");
    return [];
  }
}

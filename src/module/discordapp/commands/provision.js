import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from "discord.js";
import { formatConfigErrors, preparePlan, withGuildLock } from "../features/provision/Provisioner.js";
import { formatPlan } from "../features/provision/formatPlan.js";
import { actionableOps, planFingerprint } from "../features/provision/planner.js";
import { applyProvision, formatApplyLog } from "../features/provision/applier.js";
import { buildCustomId, parseCustomId } from "../customId.js";
import { throttledProgress } from "../progress.js";
import { textReply } from "../reply.js";

const PREFIX = "provision";

/**
 * /provision — сервер як код (docs/DISCORDAPP.md, «Feature: provisioning»).
 *
 *   plan  — показує, що зміниться; нічого не змінює.
 *   apply — показує план і кнопку «Apply»; змінює сервер лише після неї.
 */
export default {
  data: new SlashCommandBuilder()
    .setName("provision")
    .setDescription("Shape this server from its config file")
    .addSubcommand((sub) => sub
      .setName("plan")
      .setDescription("Show what applying the config would change — changes nothing")
      .addStringOption(serverOption))
    .addSubcommand((sub) => sub
      .setName("apply")
      .setDescription("Show the plan with a confirm button that applies it")
      .addStringOption(serverOption)),
  admin: true,

  async execute(interaction) {
    const prepared = await preparePlan(interaction.guild, interaction.options.getString("server"));
    if (prepared.errors.length) {
      return textReply(formatConfigErrors(prepared.config, prepared.errors), "config-errors.md");
    }

    const { plan, blockers, config } = prepared;
    const text = formatPlan(plan, { configName: config.file, blockers });
    const reply = textReply(text, "provision-plan.md");
    if (interaction.options.getSubcommand() === "plan") return reply;

    // apply: кнопка лише тоді, коли застосовувати є що і нічого не заважає.
    if (plan.errors.length || blockers.length || !actionableOps(plan).length) return reply;
    return { ...asPayload(reply), components: [confirmRow(config.name, planFingerprint(plan))] };
  },
};

/**
 * Кнопки під планом. customId несе ім'я конфігу і відбиток плану (D11):
 * натискання перевіряє, що застосовується саме показаний план.
 */
export const confirmComponent = {
  prefix: PREFIX,
  admin: true,
  update: true,

  async execute(interaction) {
    const { action, args } = parseCustomId(interaction.customId);
    if (action !== "apply") return "Cancelled — nothing was changed.";
    const [configName, fingerprint] = args;

    return withGuildLock(interaction.guildId, async () => {
      const prepared = await preparePlan(interaction.guild, configName);
      if (prepared.errors.length) {
        return textReply(formatConfigErrors(prepared.config, prepared.errors), "config-errors.md");
      }
      const { plan, blockers, desired, config } = prepared;
      if (plan.errors.length || blockers.length) {
        return textReply(formatPlan(plan, { configName: config.file, blockers }), "provision-plan.md");
      }
      if (planFingerprint(plan) !== fingerprint) {
        return "⚠️ The server or the config changed since this plan was shown, so nothing was applied. " +
          "Run `/provision apply` again to see the current plan.";
      }

      const progress = throttledProgress(interaction);
      const log = await applyProvision({
        guild: interaction.guild,
        desired,
        onPhase: (phase) => progress.report(`⏳ Applying \`${config.file}\`: ${phase}…`),
      });
      await progress.settle();
      return textReply(formatApplyLog(log, { guildName: interaction.guild.name }), "provision-result.md");
    });
  },
};

function confirmRow(configName, fingerprint) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(PREFIX, "apply", configName, fingerprint))
      .setLabel("Apply")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildCustomId(PREFIX, "cancel"))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function asPayload(reply) {
  return typeof reply === "string" ? { content: reply } : reply;
}

function serverOption(option) {
  return option
    .setName("server")
    .setDescription("Config name in src/config/discordapp/servers/ (default: the one for this server)");
}

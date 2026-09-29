import { SlashCommandBuilder } from "discord.js";
import { formatConfigErrors, preparePlan } from "../features/provision/Provisioner.js";
import { formatPlan } from "../features/provision/formatPlan.js";
import { textReply } from "../reply.js";

/**
 * /provision — сервер як код (docs/DISCORDAPP.md, «Feature: provisioning»).
 *
 *   plan  — показує, що зміниться; нічого не змінює.
 */
export default {
  data: new SlashCommandBuilder()
    .setName("provision")
    .setDescription("Shape this server from its config file")
    .addSubcommand((sub) => sub
      .setName("plan")
      .setDescription("Show what applying the config would change — changes nothing")
      .addStringOption(serverOption)),
  admin: true,

  async execute(interaction) {
    const configName = interaction.options.getString("server");
    const prepared = await preparePlan(interaction.guild, configName);
    if (prepared.errors.length) {
      return textReply(formatConfigErrors(prepared.config, prepared.errors), "config-errors.md");
    }

    const text = formatPlan(prepared.plan, { configName: prepared.config.file, blockers: prepared.blockers });
    return textReply(text, "provision-plan.md");
  },
};

function serverOption(option) {
  return option
    .setName("server")
    .setDescription("Config name in src/config/discordapp/servers/ (default: the one for this server)");
}

import { SlashCommandBuilder } from "discord.js";
import { describeResult, exportChats, prepareAttachments } from "../features/export/ChatExporter.js";
import { isServedGuild } from "../guard.js";
import { DISCORD_UPLOAD_LIMIT_MB } from "../../../config/app.config.js";

/**
 * /export-chats — останні N повідомлень з кожного каналу й треду, до яких
 * бот має доступ, одним файлом (docs/DISCORDAPP.md, «Feature: /export-chats»).
 */
export default {
  data: new SlashCommandBuilder()
    .setName("export-chats")
    .setDescription("Export the latest messages of every channel the bot can read")
    .addIntegerOption((option) => option
      .setName("limit")
      .setDescription("Messages per channel, 1–100")
      .setMinValue(1)
      .setMaxValue(100)
      .setRequired(true))
    .addStringOption((option) => option
      .setName("format")
      .setDescription("File format (default: md)")
      .addChoices(
        { name: "Markdown", value: "md" },
        { name: "JSON", value: "json" },
        { name: "Both", value: "both" },
      ))
    .addStringOption((option) => option
      .setName("scope")
      .setDescription("This server or every managed server (default: this)")
      .addChoices(
        { name: "This server", value: "this" },
        { name: "All managed servers", value: "all" },
      )),
  admin: true,

  async execute(interaction, { guildIds }) {
    const limit = interaction.options.getInteger("limit", true);
    const format = interaction.options.getString("format") ?? "md";
    const scope = interaction.options.getString("scope") ?? "this";

    const guilds = scope === "all"
      ? [...interaction.client.guilds.cache.values()].filter((guild) => isServedGuild(guild.id, guildIds))
      : [interaction.guild];
    const label = scope === "all" ? "all" : interaction.guild.name;

    // Проміжного прогресу немає навмисно: Discord сам показує «думає…» на
    // відкладеній відповіді, а кожне оновлення — ще один запит.
    const { snapshot, files } = await exportChats({ guilds, limit, format, label });

    const { attachments, tooLarge } = prepareAttachments(files, DISCORD_UPLOAD_LIMIT_MB * 1024 * 1024);
    return {
      content: describeResult(snapshot, { saved: files.map((file) => file.name), tooLarge }),
      files: attachments.map((file) => ({ attachment: file.data, name: file.name })),
    };
  },
};

import { SlashCommandBuilder } from "discord.js";
import { describeResult, exportCaption, exportChats, exportDeliveryMessage } from "../features/export/ChatExporter.js";
import { isServedGuild } from "../guard.js";
import { DISCORD_EXPORT_TELEGRAM_CHAT } from "../../../config/app.config.js";

/**
 * /export-chats — останні N повідомлень з кожного каналу й треду, до яких
 * бот має доступ, одним файлом (docs/DISCORDAPP.md, «Feature: /export-chats»).
 *
 * Файл пишеться на диск і, якщо задано DISCORD_EXPORT_TELEGRAM_CHAT,
 * надсилається в Telegram. У Discord — лише коротка відповідь: чужі
 * повідомлення з усього сервера не мають лежати вкладенням у Discord.
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

  async execute(interaction, { eventBus, guildIds }) {
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

    const telegram = DISCORD_EXPORT_TELEGRAM_CHAT;
    if (telegram) {
      eventBus.emitMessageReceived(exportDeliveryMessage(files, { chat: telegram, label, summary: exportCaption(snapshot) }));
    }
    return describeResult(snapshot, { saved: files.map((file) => file.name), telegram });
  },
};

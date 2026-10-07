import { SlashCommandBuilder } from "discord.js";

/**
 * /daily — ручний запуск щоденного звіту.
 *
 * Звіт будує і відправляє ядро (CronScheduler.runJob) тим самим шляхом, що й
 * за розкладом: EventBus → MessageRouter → призначення з cronjob.config.json.
 * Команда лише питає шину й каже, чи вдалося (DISCORDAPP.md D1).
 */
export default {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Generate and send the daily crypto report now"),
  admin: true,

  async execute(interaction, { eventBus }) {
    const sent = await eventBus.request("cron.run", { id: "dailyinfo", triggeredBy: interaction.user.tag });
    return sent ? "✅ Daily report generated and sent." : "❌ Failed to generate the daily report. Check the logs.";
  },
};

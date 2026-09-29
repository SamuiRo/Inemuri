import { SlashCommandBuilder } from "discord.js";
import { daily } from "../../../config/cronjobs.js";

/**
 * /daily — ручний запуск щоденного звіту.
 *
 * Звіт іде тим самим шляхом, що й за розкладом: у EventBus, звідти —
 * MessageRouter і призначення з cronjob.config.json. Команда лише каже,
 * чи вдалося його зібрати.
 */
export default {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Generate and send the daily crypto report now"),
  admin: true,

  async execute(interaction, { eventBus }) {
    const messageData = await daily.handler();
    if (!messageData) {
      return "❌ Failed to generate the daily report. Check the logs.";
    }

    eventBus.emitMessageReceived({
      ...messageData,
      metadata: {
        ...messageData.metadata,
        source: "discord-command",
        commandName: "daily",
        triggeredBy: interaction.user.tag,
        timestamp: new Date().toISOString(),
      },
    });

    return "✅ Daily report generated and sent.";
  },
};

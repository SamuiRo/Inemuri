import { SlashCommandBuilder } from "discord.js";
import { CATEGORIES, FLOW_SEARCH } from "../../../config/app.config.js";
import { textReply } from "../reply.js";

// Discord дозволяє до 25 варіантів вибору; таксономія менша.
const choices = (obj) => Object.keys(obj ?? {}).slice(0, 25).map((k) => ({ name: k, value: k }));

/**
 * /search — пошук по корпусу TheFlow (ROADMAP §9.1).
 *
 * discordapp не імпортує ядро (DISCORDAPP.md D1): команда лише надсилає
 * запит "theflow.search" через EventBus, а відповідає HistorySearch, який
 * реєструє inemuri.js. Відповідь, як і все в discordapp, ephemeral (D5).
 *
 * Адмінська (D7): корпус — це вміст каналів, на які підписаний оператор.
 */
export default {
  data: new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search the TheFlow history")
    .addStringOption((o) => o.setName("query").setDescription("Words to find, or a question for semantic").setRequired(true))
    .addStringOption((o) => o.setName("mode").setDescription("keyword (default, no AI) or semantic (one embedding call)")
      .addChoices({ name: "keyword", value: "keyword" }, { name: "semantic", value: "semantic" }))
    .addStringOption((o) => o.setName("topic").setDescription("Only this topic").addChoices(...choices(CATEGORIES.topics)))
    .addStringOption((o) => o.setName("signal").setDescription("Only this signal").addChoices(...choices(CATEGORIES.signals)))
    .addIntegerOption((o) => o.setName("days").setDescription("Only the last N days").setMinValue(1).setMaxValue(3650))
    .addIntegerOption((o) => o.setName("limit").setDescription("Results, up to 25 (default 10)").setMinValue(1).setMaxValue(25)),
  admin: true,

  async execute(interaction, { eventBus }) {
    const opt = interaction.options;
    const res = await eventBus.request("theflow.search", {
      query: opt.getString("query"),
      mode: opt.getString("mode") ?? "keyword",
      topic: opt.getString("topic"),
      signal: opt.getString("signal"),
      days: opt.getInteger("days"),
      limit: opt.getInteger("limit"),
    }, { timeoutMs: FLOW_SEARCH.requestTimeoutMs });
    return textReply(res.text, "search.md");
  },
};

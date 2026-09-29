import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { checkAccess } from "./guard.js";
import { parseCustomId } from "./customId.js";
import { print } from "../../shared/utils.js";

// Ліміт Discord на content повідомлення.
const MAX_CONTENT = 2000;

/**
 * Результат обробника → payload для editReply. Чиста функція.
 *
 * Обробник повертає рядок, об'єкт payload або нічого — і не думає про
 * ephemeral: відповідь уже відкладена як ephemeral, а editReply цього не змінює.
 *
 * @param {(string|object|undefined|null)} result
 * @returns {object}
 */
export function toReply(result) {
  if (result == null) return { content: "✅ Done." };
  if (typeof result === "string") {
    return {
      content: result.length > MAX_CONTENT ? `${result.slice(0, MAX_CONTENT - 1)}…` : result,
    };
  }
  return result;
}

/**
 * CommandRegistry — маршрутизація slash-команд і компонентів до обробників.
 *
 * Уся «обв'язка» interaction живе тут, в одному місці:
 *  - перевірка доступу (guard.js) до запуску обробника;
 *  - відповідь завжди ephemeral (docs/DISCORDAPP.md D5): deferReply з прапорцем
 *    ставиться ДО обробника, тож обробник не може написати в канал публічно;
 *  - помилка обробника — ephemeral-повідомлення і лог, не падіння процесу.
 *
 * Команда:    { data: SlashCommandBuilder, admin?: boolean, execute(interaction, ctx) }
 * Компонент:  { prefix: string,           admin?: boolean, execute(interaction, ctx) }
 */
class CommandRegistry {
  /**
   * @param {object} options
   * @param {object[]} options.commands
   * @param {object[]} [options.components]
   * @param {{ whitelist: string[], guildIds: string[] }} options.policy
   * @param {object} [options.ctx]  Спільні залежності обробників (eventBus, ...).
   */
  constructor({ commands, components = [], policy, ctx = {} }) {
    this.commands = indexBy(commands, (command) => command.data.name, "command");
    this.components = indexBy(components, (component) => component.prefix, "component prefix");
    this.policy = policy;
    this.ctx = ctx;
  }

  /**
   * JSON-визначення для реєстрації в Discord. Адмінські команди приховані від
   * усіх, хто не має Administrator (D7) — це ставиться тут, а не в кожній
   * команді, щоб не можна було забути.
   */
  definitions() {
    return [...this.commands.values()].map((command) => {
      const json = command.data.toJSON();
      if (command.admin) {
        json.default_member_permissions = String(PermissionFlagsBits.Administrator);
      }
      return json;
    });
  }

  /** Обробник для interaction або null. */
  resolve(interaction) {
    if (interaction.isChatInputCommand()) {
      return this.commands.get(interaction.commandName) ?? null;
    }
    if (interaction.isMessageComponent()) {
      return this.components.get(parseCustomId(interaction.customId).prefix) ?? null;
    }
    return null;
  }

  async dispatch(interaction) {
    if (!interaction.isRepliable()) return;
    const label = describe(interaction);

    try {
      const handler = this.resolve(interaction);
      if (!handler) {
        await interaction.reply({ content: "❌ Unknown command.", flags: MessageFlags.Ephemeral });
        return;
      }

      const access = checkAccess(
        { admin: handler.admin, userId: interaction.user.id, guildId: interaction.guildId },
        this.policy,
      );
      if (!access.ok) {
        print(`[DISCORDAPP] ${interaction.user.tag} refused ${label}: ${access.reason}`, "warning");
        await interaction.reply({ content: `❌ ${access.reason}`, flags: MessageFlags.Ephemeral });
        return;
      }

      print(`[DISCORDAPP] ${label} by ${interaction.user.tag}`);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const result = await handler.execute(interaction, this.ctx);
        await interaction.editReply(toReply(result));
      } catch (error) {
        print(`[DISCORDAPP] ${label} failed: ${error.message}`, "error");
        console.error(error);
        await interaction.editReply({ content: `❌ ${error.message}` });
      }
    } catch (error) {
      // Сюди потрапляє те, що зламалось у самій відповіді: протермінований
      // токен interaction, втрачений доступ до каналу. Відповісти вже нікуди.
      print(`[DISCORDAPP] Could not answer ${label}: ${error.message}`, "error");
    }
  }
}

function indexBy(items, keyOf, what) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (map.has(key)) throw new Error(`Duplicate discordapp ${what}: ${key}`);
    map.set(key, item);
  }
  return map;
}

function describe(interaction) {
  if (interaction.isChatInputCommand()) return `/${interaction.commandName}`;
  if (interaction.isMessageComponent()) return `[${interaction.customId}]`;
  return `interaction ${interaction.type}`;
}

export default CommandRegistry;

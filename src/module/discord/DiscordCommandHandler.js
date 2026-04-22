import { REST, Routes, SlashCommandBuilder } from "discord.js";
import {
  DISCORD_BOT_TOKEN,
  DISCORD_COMMAND_WHITELIST,
} from "../../config/app.config.js";
import { print } from "../../shared/utils.js";

class DiscordCommandHandler {
  constructor(eventBus, discordClient, commands) {
    this.eventBus = eventBus;
    this.discordClient = discordClient;
    this.commands = commands;
    this.whitelist = DISCORD_COMMAND_WHITELIST;
  }

  /**
   * Реєструє slash commands в Discord
   */
  async registerCommands() {
    try {
      const client = this.discordClient.getClient();
      const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

      // Конвертуємо наші команди в Discord slash commands
      const slashCommands = this.commands.map((cmd) => {
        const builder = new SlashCommandBuilder()
          .setName(cmd.name)
          .setDescription(cmd.description);

        // Додаємо параметри якщо є
        if (cmd.options) {
          cmd.options.forEach((option) => {
            if (option.type === "string") {
              builder.addStringOption((opt) =>
                opt
                  .setName(option.name)
                  .setDescription(option.description)
                  .setRequired(option.required || false),
              );
            }
          });
        }

        return builder.toJSON();
      });

      print(`Registering ${slashCommands.length} Discord slash commands...`);

      // Реєструємо команди глобально
      await rest.put(Routes.applicationCommands(client.user.id), {
        body: slashCommands,
      });

      print("Discord commands registered successfully", "success");
    } catch (error) {
      print(`Failed to register Discord commands: ${error.message}`, "error");
      throw error;
    }
  }

  /**
   * Перевіряє чи користувач в whitelist
   */
  isUserAllowed(userId) {
    if (!this.whitelist || this.whitelist.length === 0) {
      print(
        "Warning: Command whitelist is empty, allowing all users",
        "warning",
      );
      return true;
    }
    return this.whitelist.includes(userId);
  }

  /**
   * Ініціалізує обробник команд
   */
  async initialize() {
    try {
      const client = this.discordClient.getClient();

      // Реєструємо slash commands
      await this.registerCommands();

      // Обробляємо interactionCreate події
      client.on("interactionCreate", async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const userId = interaction.user.id;
        const commandName = interaction.commandName;

        // Перевіряємо whitelist
        if (!this.isUserAllowed(userId)) {
          await interaction.reply({
            content: "❌ You don't have permission to use this command.",
            ephemeral: true,
          });
          print(
            `User ${interaction.user.tag} (${userId}) tried to use command /${commandName} but is not in whitelist`,
            "warning",
          );
          return;
        }

        // Знаходимо відповідну команду
        const command = this.commands.find((cmd) => cmd.name === commandName);

        if (!command) {
          await interaction.reply({
            content: "❌ Command not found.",
            ephemeral: true,
          });
          return;
        }

        try {
          print(`Executing command /${commandName} by ${interaction.user.tag}`);

          // Відразу відповідаємо що команда в процесі
          await interaction.deferReply({ ephemeral: true });

          // Виконуємо handler команди, передаємо eventBus
          const result = await command.handler(interaction, this.eventBus);

          // Відправляємо результат
          if (result && result.success) {
            await interaction.editReply({
              content: result.message || "✅ Command executed successfully",
            });
          } else if (result && !result.success) {
            await interaction.editReply({
              content: result.message || "❌ Command failed",
            });
          } else {
            await interaction.editReply({
              content: "✅ Command executed successfully",
            });
          }
        } catch (error) {
          print(
            `Error executing command /${commandName}: ${error.message}`,
            "error",
          );
          console.error(error);

          await interaction.editReply({
            content: `❌ Error executing command: ${error.message}`,
          });
        }
      });

      print("Discord command handler initialized", "success");
    } catch (error) {
      print(
        `Failed to initialize Discord command handler: ${error.message}`,
        "error",
      );
      throw error;
    }
  }

  /**
   * Видаляє всі зареєстровані команди (для cleanup)
   */
  async cleanup() {
    try {
      const client = this.discordClient.getClient();
      const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

      await rest.put(Routes.applicationCommands(client.user.id), {
        body: [],
      });

      print("Discord commands unregistered");
    } catch (error) {
      print(`Failed to cleanup Discord commands: ${error.message}`, "error");
    }
  }
}

export default DiscordCommandHandler;
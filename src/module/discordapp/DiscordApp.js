import { Events } from "discord.js";
import CommandRegistry from "./CommandRegistry.js";
import { isServedGuild } from "./guard.js";
import { COMMANDS, COMPONENTS } from "./commands/index.js";
import { print } from "../../shared/utils.js";

// Повтор невдалого логіну: від 30 с, подвоюючи, до 10 хв.
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/**
 * DiscordApp — керування Discord-серверами в складі Inemuri
 * (docs/DISCORDAPP.md).
 *
 * Межа модуля (D1): з рештою Inemuri говорить лише через EventBus, який
 * отримують обробники в ctx. Ядро discordapp не імпортує.
 *
 * Старт ніколи не зупиняє процес (D3): невдалий логін — попередження і
 * повтор у фоні, доставка тим часом працює через REST.
 */
class DiscordApp {
  /**
   * @param {object} options
   * @param {import("../eventbus/EventBus.js").default} options.eventBus
   * @param {import("../discord/DiscordGateway.js").default} options.gateway
   * @param {{ enabled: boolean, hasToken: boolean, whitelist: string[], guildIds: string[] }} options.config
   */
  constructor({ eventBus, gateway, config }) {
    this.gateway = gateway;
    this.config = config;
    this.registry = new CommandRegistry({
      commands: COMMANDS,
      components: COMPONENTS,
      policy: { whitelist: config.whitelist, guildIds: config.guildIds },
      ctx: { eventBus },
    });

    this.listening = false;
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
  }

  async start() {
    if (!this.config.enabled) {
      print("discordapp disabled (DISCORD_APP_ENABLED=false)", "warning");
      return;
    }
    if (!this.config.hasToken) {
      print("discordapp inactive (no DISCORD_BOT_TOKEN)", "warning");
      return;
    }
    if (this.config.whitelist.length === 0) {
      print("discordapp: DISCORD_COMMAND_WHITELIST is empty — admin commands are refused for everyone", "warning");
    }
    await this._connect();
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    // Команди навмисно НЕ знімаються (D6): інакше вони зникали б на кожен
    // рестарт pm2 і перереєстровувались, витрачаючи rate limit.
    await this.gateway.disconnect();
    this.listening = false;
  }

  // ── Підключення ──────────────────────────────────────────────────────────

  async _connect() {
    try {
      const client = await this.gateway.connect();
      this._listen(client);
      await this._registerCommands(client);
      this.retryDelay = RETRY_MIN_MS;
      print("discordapp started", "success");
    } catch (error) {
      // Невалідний токен повтор не вилікує — лише засмітить лог.
      if (error.code === "TokenInvalid") {
        print("discordapp: DISCORD_BOT_TOKEN is invalid — not retrying", "error");
        return;
      }
      print(
        `discordapp failed to start: ${error.message} — retrying in ${this.retryDelay / 1000}s`,
        "warning",
      );
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    this.retryTimer = setTimeout(() => this._connect(), this.retryDelay);
    // Таймер повтору не повинен тримати процес живим при зупинці.
    this.retryTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  /** Слухачі подій — один раз на клієнт, навіть якщо реєстрацію повторили. */
  _listen(client) {
    if (this.listening) return;
    this.listening = true;

    client.on(Events.InteractionCreate, (interaction) => this.registry.dispatch(interaction));

    // Бота додали на новий сервер — команди там мають з'явитися без рестарту.
    client.on(Events.GuildCreate, (guild) => {
      if (!isServedGuild(guild.id, this.config.guildIds)) {
        print(`discordapp: joined ${guild.name} (${guild.id}), which is not in DISCORD_GUILD_IDS — ignoring it`, "warning");
        return;
      }
      this._registerIn(client, guild.id).catch(() => {});
    });
  }

  // ── Реєстрація команд ────────────────────────────────────────────────────

  /**
   * Команди реєструються на кожен сервер окремо, глобальних немає (D6).
   * Глобальні, що лишились від старої реєстрації, прибираються — інакше в
   * клієнті кожна команда була б двічі.
   */
  async _registerCommands(client) {
    const global = await client.application.commands.fetch();
    if (global.size > 0) {
      await client.application.commands.set([]);
      print(`discordapp: removed ${global.size} stale global command(s)`);
    }

    for (const guildId of this._targetGuilds(client)) {
      // Помилка на одному сервері (нема scope applications.commands) не
      // зупиняє решту — _registerIn її логує.
      await this._registerIn(client, guildId).catch(() => {});
    }
  }

  async _registerIn(client, guildId) {
    const name = client.guilds.cache.get(guildId)?.name ?? guildId;
    try {
      await client.application.commands.set(this.registry.definitions(), guildId);
      print(`discordapp: ${this.registry.commands.size} command(s) registered in ${name}`, "success");
    } catch (error) {
      print(`discordapp: could not register commands in ${name}: ${error.message}`, "error");
      throw error;
    }
  }

  _targetGuilds(client) {
    const joined = [...client.guilds.cache.keys()];
    if (this.config.guildIds.length === 0) return joined;

    for (const guildId of this.config.guildIds) {
      if (!joined.includes(guildId)) {
        print(`discordapp: DISCORD_GUILD_IDS lists ${guildId}, but the bot is not in that server`, "warning");
      }
    }
    return this.config.guildIds.filter((guildId) => joined.includes(guildId));
  }
}

export default DiscordApp;

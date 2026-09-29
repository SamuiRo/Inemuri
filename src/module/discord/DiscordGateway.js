import { Client, GatewayIntentBits } from "discord.js";
import { DISCORD_BOT_TOKEN } from "../../config/app.config.js";
import { print } from "../../shared/utils.js";

/**
 * DiscordGateway — gateway-сесія Discord (discord.js Client).
 *
 * Належить лише discordapp (docs/DISCORDAPP.md D2): через неї приходять
 * slash-команди, кнопки й події серверів. Доставка сюди не ходить — вона
 * працює через DiscordRest і не залежить від того, чи ця сесія жива.
 *
 * Після першого успішного логіну discord.js сам перепідключається при
 * обривах. Невдалий перший логін кидає помилку, а повтор — справа
 * DiscordApp.
 */
class DiscordGateway {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected) return this.client;

    // Лише Guilds: interactions приходять і без інших intents, а кеш
    // серверів і каналів потрібен для реєстрації команд. Решту intents
    // додавати під конкретну фічу, а не про запас.
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    // Постійний обробник, не once: EventEmitter без слухача "error" кидає
    // виняток і валить увесь процес — разом із пересиланням.
    client.on("error", (error) => {
      print(`[DISCORDAPP] Gateway error: ${error.message}`, "error");
    });

    try {
      const ready = new Promise((resolve) => client.once("clientReady", resolve));
      await client.login(DISCORD_BOT_TOKEN);
      await ready;
    } catch (error) {
      // Недолога сесія не має висіти: наступна спроба створить новий Client.
      await client.destroy().catch(() => {});
      throw error;
    }

    this.client = client;
    this.isConnected = true;
    print(`Discord gateway connected as ${client.user.tag}`, "success");
    return client;
  }

  async disconnect() {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
    this.isConnected = false;
    print("Discord gateway disconnected");
  }
}

const discordGateway = new DiscordGateway();
export default discordGateway;

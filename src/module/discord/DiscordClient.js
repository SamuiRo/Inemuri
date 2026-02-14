import { Client, GatewayIntentBits } from "discord.js";
import { DISCORD_BOT_TOKEN } from "../../config/app.config.js";
import { print } from "../../shared/utils.js";

class DiscordClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.readyPromise = null;
  }

  async connect() {
    if (this.isConnected) {
      print("Discord client already connected", "warning");
      return this.client;
    }

    try {
      // print("Connecting to Discord...");

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          // GatewayIntentBits.MessageContent,
        ],
      });

      // Створюємо promise який резолвиться коли бот ready
      this.readyPromise = new Promise((resolve, reject) => {
        this.client.once("ready", () => {
          this.isConnected = true;
          print(
            `Discord client connected as ${this.client.user.tag}`,
            "success",
          );
          resolve(this.client);
        });

        this.client.once("error", (error) => {
          print(`Discord client error: ${error.message}`, "error");
          reject(error);
        });
      });

      await this.client.login(DISCORD_BOT_TOKEN);
      await this.readyPromise;

      return this.client;
    } catch (error) {
      print(`Failed to connect to Discord: ${error.message}`, "error");
      console.error(error);
      this.isConnected = false;
      throw error;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.destroy();
      this.isConnected = false;
      this.client = null;
      print("Discord client disconnected");
    }
  }

  getClient() {
    if (!this.isConnected || !this.client) {
      throw new Error("Discord client is not connected. Call connect() first.");
    }
    return this.client;
  }
}

const discordClient = new DiscordClient();
export default discordClient;

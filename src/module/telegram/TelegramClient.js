import os from "os";
import { TelegramClient as MTProtoClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { askText, askSecret } from "../../shared/prompt.js";

import {
  TELEGRAM_SESSION,
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  PKG,
  TELEGRAM_CONNECTION_RETRIES,
} from "../../config/app.config.js";
import { print, printStack } from "../../shared/utils.js";

class TelegramClient {
  constructor() {
    this.string_session = new StringSession(TELEGRAM_SESSION);
    this.client = null;
    this.isConnected = false;
    this.client_options = {
      deviceModel: `${PKG.name}@${os.hostname()}`,
      systemVersion: os.version() || "Inemuri Unknown Node",
      appVersion: PKG.version,
      useWSS: true, // not sure if it works in node at all
      testServers: false, // this one should be the default for node env, but who knows for sure :)
      connectionRetries: TELEGRAM_CONNECTION_RETRIES,
    };
  }

  async connect() {
    if (this.isConnected) {
      print("Telegram client already connected", "warning");
      return this.client;
    }

    try {
      print("Connecting to Telegram...");

      this.client = new MTProtoClient(
        this.string_session,
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH,
        this.client_options,
      );

      await this.client.start({
        phoneNumber: async () => askText("Phone number: "),
        // askSecret, не askText: раніше 2FA-пароль друкувався в термінал
        // відкритим текстом і лишався в історії сесії.
        password:    async () => askSecret("Password (if enabled): "),
        phoneCode:   async () => askText("Verification code: "),
        onError: (error) => {
          print(`Authentication error: ${error.message}`, "error");
          printStack(error);
        },
      });

      this.isConnected = true;
      print("Telegram client connected successfully", "success");

      // Зберігаємо сесію для наступних запусків
      const sessionString = this.client.session.save();
      if (sessionString !== TELEGRAM_SESSION) {
        print("New session string generated. Save it to .env:", "warning");
        // Інтерактивний крок авторизації: рядок сесії треба показати
        // оператору, щоб він зберіг його у .env. Це не лог.
        // eslint-disable-next-line no-console
        console.log(sessionString);
      }

      return this.client;
    } catch (error) {
      print(`Failed to connect to Telegram: ${error.message}`, "error");
      printStack(error);
      throw error;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
      print("Telegram client disconnected");
    }
  }

  getClient() {
    if (!this.isConnected || !this.client) {
      throw new Error(
        "Telegram client is not connected. Call connect() first.",
      );
    }
    return this.client;
  }
}

const telegramClient = new TelegramClient();
export default telegramClient;

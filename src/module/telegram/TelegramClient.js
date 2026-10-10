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

/**
 * Клієнт MTProto з параметрами пристрою Inemuri. Спільний для сервісу й
 * `cli telegram login`, щоб сесія входу була тим самим «пристроєм».
 * @param {string} [session] рядок сесії; порожній — новий вхід
 */
export function createMTProtoClient(session = "") {
  return new MTProtoClient(new StringSession(session ?? ""), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
    deviceModel: `${PKG.name}@${os.hostname()}`,
    systemVersion: os.version() || "Inemuri Unknown Node",
    appVersion: PKG.version,
    useWSS: true, // not sure if it works in node at all
    testServers: false, // this one should be the default for node env, but who knows for sure :)
    connectionRetries: TELEGRAM_CONNECTION_RETRIES,
  });
}

class TelegramClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    if (this.isConnected) {
      print("Telegram client already connected", "warning");
      return this.client;
    }

    try {
      // Без сесії вхід інтерактивний; під pm2 stdin немає, і сервіс чекав би
      // код вічно. Вхід — окремою командою, вона ж каже, куди пішов код.
      if (!TELEGRAM_SESSION && !process.stdin.isTTY) {
        throw new Error("TELEGRAM_SESSION is empty and there is no terminal to log in: run `node src/cli.js telegram login` and put the session in .env");
      }

      print("Connecting to Telegram...");

      this.client = createMTProtoClient(TELEGRAM_SESSION);

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

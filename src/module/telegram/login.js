import QRCode from "qrcode";
import { Api } from "telegram";

import { createMTProtoClient } from "./TelegramClient.js";
import { describeSentCode, readCodeAnswer } from "./loginCode.js";
import { askText, askSecret } from "../../shared/prompt.js";
import { TELEGRAM_API_ID, TELEGRAM_API_HASH } from "../../config/app.config.js";
import { print } from "../../shared/utils.js";

/**
 * Вхід у Telegram окремо від сервісу: `node src/cli.js telegram login`.
 *
 * Два шляхи:
 *  - QR (типово): Telegram на телефоні → Налаштування → Пристрої →
 *    «Підключити пристрій». Код не потрібен узагалі, тож не залежить від
 *    того, куди і чи надсилає його Telegram.
 *  - телефон (`--phone`): auth.SendCode напряму, щоб сказати, КУДИ пішов код
 *    (describeSentCode), з повтором іншим способом (`resend`) і переходом на
 *    QR (`qr`). gramjs у client.start() цю інформацію відкидає.
 *
 * @param {{ phone?: boolean }} options
 * @returns {Promise<{ session: string, user: object }>}
 */
export async function telegramLogin({ phone = false } = {}) {
  if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH are not set (my.telegram.org → API development tools)");
  }
  const credentials = { apiId: TELEGRAM_API_ID, apiHash: TELEGRAM_API_HASH };
  const client = createMTProtoClient("");
  try {
    await client.connect();
    const user = phone ? await phoneLogin(client, credentials) : await qrLogin(client, credentials);
    return { session: client.session.save(), user };
  } finally {
    await client.disconnect().catch(() => {});
    // gramjs лишає таймери оновлення — без destroy процес не завершиться.
    await client.destroy?.().catch(() => {});
  }
}

const askPassword = async (hint) => askSecret(`2FA password${hint ? ` (hint: ${hint})` : ""}: `);

// Невірний пароль — спитати ще раз; будь-що інше — зупинитися.
const passwordParams = {
  password: askPassword,
  onError: async (error) => {
    print(`Telegram: ${error.errorMessage ?? error.message}`, "error");
    return error.errorMessage !== "PASSWORD_HASH_INVALID";
  },
};

async function qrLogin(client, credentials) {
  print("Telegram on your phone → Settings → Devices → Link Desktop Device, and scan this code.", "system");
  print("It is renewed every 30 s until scanned; Ctrl+C to stop.", "info");
  return client.signInUserWithQrCode(credentials, {
    qrCode: async ({ token }) => {
      const url = `tg://login?token=${Buffer.from(token).toString("base64url")}`;
      process.stdout.write(`\n${await QRCode.toString(url, { type: "terminal", small: true })}\n`);
    },
    ...passwordParams,
  });
}

async function phoneLogin(client, credentials) {
  const phoneNumber = (await askText("Phone number, international format (+380…): ")).replace(/[\s()-]/g, "");
  if (!phoneNumber) throw new Error("No phone number");

  let sent = await sendCode(client, credentials, phoneNumber);
  for (;;) {
    const d = describeSentCode(sent);
    if (d.success) return sent.authorization?.user ?? null;

    print(`Code sent ${d.hint}.`, d.expectCode ? "info" : "warning");
    if (d.next) print(`Not arriving? Type "resend" to get it by ${d.next}${d.timeout ? ` (after ${d.timeout} s)` : ""}.`, "info");
    if (!d.expectCode && !d.next) print(`Type "qr" to log in by QR code instead.`, "warning");

    const answer = readCodeAnswer(await askText(`Code${d.next ? " / resend" : ""} / qr: `));
    if (answer.action === "empty") continue;
    if (answer.action === "qr") return qrLogin(client, credentials);
    if (answer.action === "resend") {
      if (!d.next) { print("Telegram offers no other way for this login.", "warning"); continue; }
      sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber, phoneCodeHash: sent.phoneCodeHash }));
      continue;
    }

    try {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash: sent.phoneCodeHash, phoneCode: answer.code }));
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error("No Telegram account on this number — create it in an official app first");
      }
      return result.user;
    } catch (error) {
      switch (error.errorMessage) {
        case "SESSION_PASSWORD_NEEDED":
          return client.signInWithPassword(credentials, passwordParams);
        case "PHONE_CODE_INVALID":
          print("Wrong code, try again.", "warning");
          continue;
        case "PHONE_CODE_EXPIRED":
          // Telegram гасить код, якщо його переслали в будь-який чат.
          print("The code expired (it also expires when forwarded or shared in any chat). Type \"resend\".", "warning");
          continue;
        default:
          throw error;
      }
    }
  }
}

async function sendCode(client, { apiId, apiHash }, phoneNumber) {
  try {
    return await client.invoke(new Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings: new Api.CodeSettings({}) }));
  } catch (error) {
    if (error.errorMessage === "AUTH_RESTART") return sendCode(client, { apiId, apiHash }, phoneNumber);
    if (error.errorMessage === "PHONE_NUMBER_INVALID") throw new Error("Telegram: invalid phone number (use +country code)");
    if (error.seconds) throw new Error(`Telegram: too many attempts, wait ${error.seconds} s (FLOOD_WAIT)`);
    if (error.errorMessage === "API_ID_PUBLISHED_FLOOD") throw new Error("Telegram refuses this api_id (published/abused) — create your own at my.telegram.org");
    throw error;
  }
}

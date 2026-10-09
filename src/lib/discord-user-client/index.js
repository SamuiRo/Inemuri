/**
 * discord-user-client — мінімальний клієнт Discord для user-акаунта, лише
 * читання: gateway (MESSAGE_CREATE, сервери й канали з READY) і REST
 * (історія каналу). Без кешу об'єктів — пам'ять не залежить від розміру
 * акаунта. Див. README.md поруч.
 *
 * Модуль самодостатній: імпортує лише власні файли, node: і `ws`
 * (test/discord-user-client.test.js це перевіряє) — щоб його можна було
 * винести в окремий пакет без змін.
 */

export { GatewayClient } from "./GatewayClient.js";
export { RestClient } from "./RestClient.js";
export { resolveClientIdentity, FALLBACK_CHROME_MAJOR } from "./ClientIdentity.js";
export { ZlibStream } from "./ZlibStream.js";
export {
  OP, API_VERSION, CAPABILITIES, AUTO_SUBSCRIBE_MAX_MEMBERS,
  closeAction, decide, guildSummary, readySummary, guildsToSubscribe,
} from "./protocol.js";
export { messagesPath, parseRateLimit } from "./rest.js";

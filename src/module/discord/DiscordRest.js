import { REST, Routes } from "discord.js";
import { DISCORD_BOT_TOKEN } from "../../config/app.config.js";

/**
 * Перетворює payload у стилі discord.js на тіло REST-запиту.
 *
 * Чиста функція: доставка і discordapp будують повідомлення звичними
 * EmbedBuilder / AttachmentBuilder, а REST приймає сирий JSON і окремо файли.
 * Приймає і білдери, і вже готові об'єкти.
 *
 * @param {string|{ content?: string, embeds?: object[], files?: object[], components?: object[] }} payload
 * @returns {{ body: object, files?: { name: string, data: Buffer }[] }}
 */
export function toRestPayload(payload) {
  if (typeof payload === "string") return { body: { content: payload } };

  const { files, ...rest } = payload ?? {};
  const body = {};
  if (rest.content != null) body.content = rest.content;
  if (rest.embeds) body.embeds = rest.embeds.map(toJSON);
  if (rest.components) body.components = rest.components.map(toJSON);
  if (rest.allowed_mentions) body.allowed_mentions = rest.allowed_mentions;

  if (!files?.length) return { body };
  return {
    body,
    // AttachmentBuilder тримає дані в `.attachment`; сирий файл — у `.data`.
    files: files.map((file) => ({ name: file.name, data: file.attachment ?? file.data })),
  };
}

function toJSON(item) {
  return typeof item?.toJSON === "function" ? item.toJSON() : item;
}

/**
 * DiscordRest — REST-клієнт Discord без gateway-сесії.
 *
 * Доставка ходить тільки сюди (docs/DISCORDAPP.md D2): надсилання й
 * редагування — це HTTP-запити, постійне WebSocket-з'єднання для них не
 * потрібне. Тому пересилання працює, навіть коли discordapp не залогінився або
 * вимкнений. Черги rate limit обробляє сам @discordjs/rest.
 *
 * Повертає сирі об'єкти API (`{ id, channel_id, ... }`), не класи discord.js.
 */
class DiscordRest {
  constructor(token) {
    this.rest = new REST({ version: "10" });
    this.isConfigured = Boolean(token);
    if (token) this.rest.setToken(token);
  }

  async sendMessage(channelId, payload) {
    return this.rest.post(Routes.channelMessages(channelId), toRestPayload(payload));
  }

  async editMessage(channelId, messageId, payload) {
    return this.rest.patch(Routes.channelMessage(channelId, messageId), toRestPayload(payload));
  }

  /** Останні повідомлення каналу, від нових до старих. limit ≤ 100 (сторінка API). */
  async fetchMessages(channelId, { limit = 50 } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.rest.get(Routes.channelMessages(channelId), { query });
  }

  async deleteMessage(channelId, messageId) {
    return this.rest.delete(Routes.channelMessage(channelId, messageId));
  }
}

const discordRest = new DiscordRest(DISCORD_BOT_TOKEN);
export default discordRest;

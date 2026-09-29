import { ChannelType } from "discord.js";

/**
 * Перетворення об'єктів discord.js на прості дані експорту. Чисті функції:
 * читають лише властивості, нічого не запитують, тож тестуються на підробках.
 *
 * Знімок, який з цього збирається (collector.js), — і є JSON-експорт:
 *
 *   { exportedAt, limit, guilds: [{ id, name, channels: [ExportChannel] }] }
 *
 *   ExportChannel = { id, name, kind, position, category, parentId, topic,
 *                     skipped, truncatedThreads, messages: [ExportMessage] }
 */

/** Тип каналу Discord → вид у експорті, або null, якщо каналу там не місце. */
const KIND_BY_TYPE = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.PublicThread]: "thread",
  [ChannelType.PrivateThread]: "private-thread",
  [ChannelType.AnnouncementThread]: "thread",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
  [ChannelType.GuildCategory]: "category",
};

export function channelKind(type) {
  return KIND_BY_TYPE[type] ?? null;
}

/** Чи бувають у каналі цього виду власні повідомлення. */
export function holdsMessages(kind) {
  return ["text", "announcement", "voice", "stage", "thread", "private-thread"].includes(kind);
}

/** Чи бувають у каналі цього виду треди. */
export function holdsThreads(kind) {
  return ["text", "announcement", "forum", "media"].includes(kind);
}

/**
 * @param {object} channel  GuildChannel або ThreadChannel.
 * @returns {object} ExportChannel без messages / skipped.
 */
export function toChannelRecord(channel) {
  const isThread = channel.isThread?.() ?? false;
  const category = isThread ? channel.parent?.parent : channel.parent;
  return {
    id: channel.id,
    name: channel.name,
    kind: channelKind(channel.type),
    position: channel.rawPosition ?? channel.position ?? 0,
    category: category ? { id: category.id, name: category.name, position: category.rawPosition ?? 0 } : null,
    parentId: isThread ? channel.parentId : null,
    topic: channel.topic ?? null,
    skipped: null,
    messages: [],
  };
}

/**
 * @param {object} message  discord.js Message.
 * @returns {object} ExportMessage.
 */
export function toMessageRecord(message) {
  const author = message.author ?? {};
  return {
    id: message.id,
    createdAt: toIso(message.createdAt ?? message.createdTimestamp),
    editedAt: message.editedAt ? toIso(message.editedAt) : null,
    author: {
      id: author.id ?? null,
      name: author.globalName ?? author.username ?? "unknown",
      bot: Boolean(author.bot),
    },
    system: Boolean(message.system),
    content: message.content ?? "",
    replyTo: message.reference?.messageId ?? null,
    attachments: values(message.attachments).map((file) => ({
      name: file.name,
      url: file.url,
      size: file.size ?? null,
      contentType: file.contentType ?? null,
    })),
    embeds: values(message.embeds).map((embed) => ({
      title: embed.title ?? null,
      description: embed.description ?? null,
      url: embed.url ?? null,
    })),
    stickers: values(message.stickers).map((sticker) => sticker.name),
    reactions: values(message.reactions?.cache ?? message.reactions).map((reaction) => ({
      emoji: reaction.emoji?.name ?? String(reaction.emoji ?? "?"),
      count: reaction.count ?? 0,
    })),
    pinned: Boolean(message.pinned),
  };
}

/**
 * Евристика: чи не вимкнений у боті Message Content intent. Без нього Discord
 * віддає порожні content, embeds і attachments для чужих повідомлень — і
 * експорт виходить формально успішним, але пустим. Системні повідомлення й
 * повідомлення ботів не рахуються: у них порожній текст буває законно.
 *
 * @param {object} snapshot
 * @returns {boolean}
 */
export function looksLikeMissingContentIntent(snapshot) {
  let human = 0;
  let empty = 0;
  for (const guild of snapshot.guilds) {
    for (const channel of guild.channels) {
      for (const message of channel.messages) {
        if (message.system || message.author.bot) continue;
        human += 1;
        const hasBody = message.content || message.attachments.length || message.embeds.length || message.stickers.length;
        if (!hasBody) empty += 1;
      }
    }
  }
  // 0.8, а не 1: повідомлення зі згадкою бота Discord віддає з текстом і без
  // intent, тож кілька непорожніх трапляються і при вимкненому.
  return human >= 5 && empty / human >= 0.8;
}

/** Collection (discord.js), Map, масив або нічого → масив значень. */
function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  return [...collection.values()];
}

function toIso(date) {
  if (date == null) return null;
  return new Date(date).toISOString();
}

import { ChannelType } from "discord.js";

/**
 * Типи каналів Discord ↔ «види», якими оперують експорт і провіжн. Вид —
 * коротке стабільне ім'я для конфігів і файлів, замість числа ChannelType.
 */

const KIND_BY_TYPE = {
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
  [ChannelType.PublicThread]: "thread",
  [ChannelType.PrivateThread]: "private-thread",
  [ChannelType.AnnouncementThread]: "thread",
};

const TYPE_BY_KIND = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  announcement: ChannelType.GuildAnnouncement,
  voice: ChannelType.GuildVoice,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
};

/** ChannelType → вид, або null, якщо такий канал нам нецікавий (DM тощо). */
export function channelKind(type) {
  return KIND_BY_TYPE[type] ?? null;
}

/** Вид → ChannelType для створення каналу. */
export function channelType(kind) {
  return TYPE_BY_KIND[kind];
}

/** Види, які провіжн уміє створювати (категорія — окремо, не в channels). */
export const PROVISIONABLE_KINDS = ["text", "announcement", "voice", "stage", "forum"];

/** Види з текстовими назвами: Discord приводить їх до нижнього регістру й дефісів. */
export function hasTextName(kind) {
  return ["text", "announcement", "forum", "media"].includes(kind);
}

/** Чи бувають у каналі цього виду власні повідомлення. */
export function holdsMessages(kind) {
  return ["text", "announcement", "voice", "stage", "thread", "private-thread"].includes(kind);
}

/** Чи бувають у каналі цього виду треди. */
export function holdsThreads(kind) {
  return ["text", "announcement", "forum", "media"].includes(kind);
}

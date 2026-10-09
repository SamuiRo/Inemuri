/**
 * Повідомлення Discord для джерела platform "discord" (docs/DISCORD_SOURCE.md).
 *
 * Чисті функції: ні мережі, ні бази, ні конфігу. normalizeMessage працює в
 * дочірньому процесі (об'єкт бібліотеки → plain-об'єкт для IPC), решта — у
 * батьківському (plain-об'єкт → messageData, який розуміють і FlowIngest, і
 * класичне пересилання).
 */

const URL_RE = /^https?:\/\//i;
const MEDIA_CONTENT_TYPE = /^(image|video)\//i;

const nonEmpty = (s) => typeof s === "string" && s.trim() !== "";

/**
 * Об'єкт повідомлення бібліотеки → plain-об'єкт, що переживає IPC (JSON).
 * Лише поля, без класів бібліотеки: батько не має знати, хто транспорт, —
 * власний клієнт (CloakCord NEXT_STEPS, крок 3) віддасть той самий об'єкт.
 * `message.member` не чіпаємо: це кеш учасників, саме він і давав витік у CloakCord.
 */
export function normalizeMessage(m) {
  const attachments = m.attachments?.values ? [...m.attachments.values()] : (m.attachments ?? []);
  return {
    id: String(m.id),
    channelId: String(m.channelId),
    guildId: m.guildId ? String(m.guildId) : null,
    authorId: m.author?.id ? String(m.author.id) : null,
    authorName: m.author?.username ?? null,
    content: m.content ?? "",
    embeds: (m.embeds ?? []).map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
      fields: (e.fields ?? []).map((f) => ({ name: String(f.name ?? ""), value: String(f.value ?? "") })),
      imageUrl: e.image?.url ?? null,
    })),
    attachments: attachments.map((a) => ({
      url: a.url ?? null,
      contentType: a.contentType ?? null,
      name: a.name ?? null,
    })),
    createdAt: Number.isFinite(m.createdTimestamp) ? m.createdTimestamp : null,
  };
}

/**
 * Сирий MESSAGE_CREATE з gateway (власний клієнт, src/lib/discord-user-client)
 * → той самий plain-об'єкт, що й normalizeMessage з об'єкта бібліотеки:
 * батьківському процесу байдуже, який транспорт працює.
 */
export function fromRawMessage(raw) {
  const created = Date.parse(raw?.timestamp ?? "");
  return {
    id: String(raw.id),
    channelId: String(raw.channel_id),
    guildId: raw.guild_id ? String(raw.guild_id) : null,
    authorId: raw.author?.id ? String(raw.author.id) : null,
    authorName: raw.author?.username ?? null,
    content: raw.content ?? "",
    embeds: (raw.embeds ?? []).map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
      fields: (e.fields ?? []).map((f) => ({ name: String(f.name ?? ""), value: String(f.value ?? "") })),
      imageUrl: e.image?.url ?? null,
    })),
    attachments: (raw.attachments ?? []).map((a) => ({
      url: a.url ?? null,
      contentType: a.content_type ?? null,
      name: a.filename ?? null,
    })),
    createdAt: Number.isFinite(created) ? created : null,
  };
}

/** Текст embed: заголовок, опис, поля (назва й значення). */
export function embedText(embed) {
  const fields = (embed?.fields ?? []).flatMap((f) => [f.name, f.value]);
  return [embed?.title, embed?.description, ...fields].filter(nonEmpty).join("\n");
}

/**
 * Увесь текст повідомлення: content і текст embed-ів. Боти й канали анонсів
 * часто шлють порожній content, а все — в embed; CloakCord дивився лише в
 * content і такі пости не бачив (CloakCord ISSUES O6).
 */
export function messageText(message) {
  return [message.content, ...(message.embeds ?? []).map(embedText)].filter(nonEmpty).join("\n\n");
}

/**
 * URL медіа: вкладення-картинки й відео (за contentType), потім картинки
 * embed-ів. Без повторів. Інші файли (документи, архіви) не беруться.
 */
export function mediaUrlsOf(message) {
  const fromAttachments = (message.attachments ?? [])
    .filter((a) => URL_RE.test(a.url ?? "") && MEDIA_CONTENT_TYPE.test(a.contentType ?? ""))
    .map((a) => a.url);
  const fromEmbeds = (message.embeds ?? []).map((e) => e.imageUrl).filter((u) => URL_RE.test(u ?? ""));
  return [...new Set([...fromAttachments, ...fromEmbeds])];
}

/** Посилання на повідомлення в клієнті Discord. */
export function messageLink(message) {
  return `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`;
}

/**
 * Plain-повідомлення → messageData. Текст Discord — уже Markdown, тож `text`
 * і `rawText` однакові; entities немає (вони — формат Telegram).
 */
export function toDiscordMessageData(message) {
  const text = messageText(message);
  return {
    platform: "discord",
    channelId: message.channelId,
    messageId: message.id,
    externalId: message.id,
    externalUrl: messageLink(message),
    title: null,
    author: message.authorName ?? null,
    timestamp: message.createdAt != null ? new Date(message.createdAt) : new Date(),
    // TheFlow: тіло (тут — увесь текст, заголовка в Discord немає).
    body: text,
    mediaUrls: mediaUrlsOf(message),
    // Класичне пересилання.
    rawText: text,
    text,
    entities: [],
  };
}

/**
 * Чи пересилати повідомлення класичним шляхом.
 *
 * Текст є — вирішує фільтр джерела (`check`, MessageFilter.checkMessageFast).
 * Тексту нема, лише медіа — пересилається, якщо в джерела немає ключових слів:
 * порожній фільтр означає «усе» (так було в CloakCord, ISSUES F9), а картинка
 * без тексту ключового слова не містить ніколи.
 *
 * @param {{ text: string, hasMedia: boolean, filter: object|null, check: (text: string) => boolean }} input
 */
export function passesClassic({ text, hasMedia, filter, check }) {
  if (nonEmpty(text)) return check(text);
  return hasMedia && !filter?.keywords;
}

/**
 * Форматери експорту. Чисті функції: знімок (snapshot.js) → рядок.
 *
 * Markdown — основний формат: для читання і для аналізу LLM, тому
 * компактний — один рядок на повідомлення, без URL вкладень (вони підписані й
 * протухають). JSON — повний знімок з id і посиланнями, для скриптів.
 */

const EMBED_PREVIEW = 200;

const ICON = {
  text: "#",
  announcement: "📢 #",
  voice: "🔊 ",
  stage: "🎙 ",
  forum: "💬 ",
  media: "🖼 ",
  thread: "🧵 ",
  "private-thread": "🔒🧵 ",
};

/**
 * Підсумок знімка — для заголовка файлу і для відповіді команди.
 * @returns {{ guilds: number, channels: number, messages: number,
 *   skipped: { guild: string, channel: string, reason: string }[],
 *   truncatedThreads: { guild: string, channel: string }[] }}
 */
export function summarize(snapshot) {
  const result = { guilds: snapshot.guilds.length, channels: 0, messages: 0, skipped: [], truncatedThreads: [] };
  for (const guild of snapshot.guilds) {
    for (const channel of guild.channels) {
      if (channel.skipped) {
        result.skipped.push({ guild: guild.name, channel: channel.name, reason: channel.skipped });
        continue;
      }
      result.channels += 1;
      result.messages += channel.messages.length;
      if (channel.truncatedThreads) result.truncatedThreads.push({ guild: guild.name, channel: channel.name });
    }
  }
  return result;
}

export function formatJson(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function formatMarkdown(snapshot) {
  const lines = [];
  for (const guild of snapshot.guilds) {
    const stats = summarize({ guilds: [guild] });
    lines.push(`# ${guild.name}`, "");
    lines.push(
      `> Exported ${formatTime(snapshot.exportedAt)} UTC · last ${snapshot.limit} messages per channel · ` +
        `${stats.channels} channels · ${stats.messages} messages` +
        (stats.skipped.length ? ` · ${stats.skipped.length} skipped` : ""),
      "",
    );

    for (const group of groupByCategory(guild.channels)) {
      lines.push(`## ${group.category ? `📁 ${group.category.name}` : "No category"}`, "");
      for (const channel of group.channels) {
        writeChannel(lines, channel, "###");
        for (const thread of channel.threads) writeChannel(lines, thread, "####");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ── Структура ──────────────────────────────────────────────────────────────

/**
 * Канали → групи за категоріями в порядку сервера; треди — під своїм
 * батьківським каналом. Тред, чийого батька в знімку немає, стає окремим
 * каналом своєї категорії, а не губиться.
 */
export function groupByCategory(channels) {
  const topLevel = channels.filter((channel) => !channel.parentId || !channels.some((c) => c.id === channel.parentId));
  const threadsOf = (id) => channels.filter((channel) => channel.parentId === id).sort(byPosition);

  const groups = new Map();
  for (const channel of topLevel) {
    const key = channel.category?.id ?? null;
    if (!groups.has(key)) groups.set(key, { category: channel.category, channels: [] });
    groups.get(key).channels.push({ ...channel, threads: threadsOf(channel.id) });
  }

  return [...groups.values()]
    .sort((a, b) => (a.category?.position ?? -1) - (b.category?.position ?? -1))
    .map((group) => ({ ...group, channels: group.channels.sort(byPosition) }));
}

function byPosition(a, b) {
  return a.position - b.position || a.name.localeCompare(b.name);
}

// ── Канал і повідомлення ───────────────────────────────────────────────────

function writeChannel(lines, channel, heading) {
  lines.push(`${heading} ${ICON[channel.kind] ?? ""}${channel.name}`);
  if (channel.topic) lines.push(`> ${oneLine(channel.topic)}`);
  lines.push("");

  if (channel.skipped) {
    lines.push(`_skipped: ${channel.skipped}_`, "");
    return;
  }
  if (channel.truncatedThreads) {
    lines.push("_older archived threads not exported_", "");
  }
  // Форум і медіа-канал власних повідомлень не мають — лише треди нижче.
  if (channel.kind === "forum" || channel.kind === "media") return;

  if (channel.messages.length === 0) {
    lines.push("_no messages_", "");
    return;
  }

  const byId = new Map(channel.messages.map((message) => [message.id, message]));
  for (const message of channel.messages) lines.push(...formatMessage(message, byId));
  lines.push("");
}

/**
 * Одне повідомлення → рядки. Відповідь показує автора оригіналу, якщо той є
 * в експорті; інакше — що це відповідь на старіше повідомлення.
 */
export function formatMessage(message, byId = new Map()) {
  let who = authorLabel(message.author);
  if (message.replyTo) {
    const target = byId.get(message.replyTo);
    who += target ? ` ↪ ${authorLabel(target.author)}` : " ↪ earlier message";
  }

  const [first = "", ...rest] = message.content.split("\n");
  const body = first || (message.system ? "_(system message)_" : "");
  const flags = `${message.pinned ? "📌 " : ""}`;
  const edited = message.editedAt ? " _(edited)_" : "";

  const lines = [`[${formatTime(message.createdAt)}] ${flags}${who}: ${body}${edited}`];
  for (const line of rest) lines.push(`    ${line}`);
  for (const file of message.attachments) lines.push(`    📎 ${file.name}${file.size ? ` (${formatSize(file.size)})` : ""}`);
  for (const embed of message.embeds) {
    const text = [embed.title, embed.description].filter(Boolean).join(" — ");
    if (text) lines.push(`    🔗 ${truncate(oneLine(text), EMBED_PREVIEW)}`);
  }
  for (const sticker of message.stickers) lines.push(`    🏷 sticker: ${sticker}`);
  if (message.reactions.length) {
    lines.push(`    reactions: ${message.reactions.map((r) => `${r.emoji} ${r.count}`).join(" · ")}`);
  }
  return lines;
}

// ── Дрібниці ───────────────────────────────────────────────────────────────

function authorLabel(author) {
  return author.bot ? `${author.name} [bot]` : author.name;
}

/** ISO → `2026-09-29 14:02` (UTC). */
export function formatTime(iso) {
  return iso ? iso.slice(0, 16).replace("T", " ") : "????-??-?? ??:??";
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function oneLine(text) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

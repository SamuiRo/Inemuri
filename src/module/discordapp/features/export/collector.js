import { PermissionFlagsBits } from "discord.js";
import { toChannelRecord, toMessageRecord } from "./snapshot.js";
import { channelKind, holdsMessages, holdsThreads } from "../../channelKinds.js";
import {
  DISCORD_EXPORT_ARCHIVED_THREADS,
  DISCORD_EXPORT_CONCURRENCY,
} from "../../../../config/app.config.js";

const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/**
 * Збирає знімок одного сервера: канали, треди й останні `limit` повідомлень
 * у кожному. Єдине місце експорту, яке ходить у Discord; усе, що з
 * отриманим робиться далі, — чисті функції (snapshot.js, format.js).
 *
 * Канал, який бот не може читати, не зникає, а позначається `skipped` — у
 * звіті видно, чого в експорті немає.
 *
 * @param {import("discord.js").Guild} guild
 * @param {{ limit: number, onProgress?: (done: number, total: number) => void }} options
 * @returns {Promise<{ id: string, name: string, channels: object[] }>}
 */
export async function collectGuild(guild, { limit, onProgress = () => {} }) {
  const me = await guild.members.fetchMe();
  const channels = [...(await guild.channels.fetch()).values()]
    .filter((channel) => channel && channelKind(channel.type) && channelKind(channel.type) !== "category");
  const { threads, truncated } = await collectThreads(guild, channels, me);

  const entries = [...channels, ...threads].map((channel) => ({
    channel,
    record: { ...toChannelRecord(channel), truncatedThreads: truncated.has(channel.id) },
  }));

  let done = 0;
  await forEachLimit(entries, DISCORD_EXPORT_CONCURRENCY, async ({ channel, record }) => {
    await fillMessages(channel, record, me, limit);
    done += 1;
    onProgress(done, entries.length);
  });

  return { id: guild.id, name: guild.name, channels: entries.map(({ record }) => record) };
}

async function fillMessages(channel, record, me, limit) {
  if (!canRead(channel, me)) {
    record.skipped = "no access";
    return;
  }
  if (!holdsMessages(record.kind)) return;

  try {
    const fetched = await channel.messages.fetch({ limit, cache: false });
    record.messages = [...fetched.values()]
      .map(toMessageRecord)
      // API віддає від нових до старих; експорт читається хронологічно.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (error) {
    record.skipped = `error: ${error.message}`;
  }
}

/**
 * Активні треди сервера (один запит) плюс архівні — по сторінці на кожен
 * канал, де треди бувають. Приватні архівні лише там, де бот має
 * ManageThreads: без нього Discord їх не віддає.
 */
async function collectThreads(guild, channels, me) {
  const byId = new Map();
  const truncated = new Set();

  const active = await guild.channels.fetchActiveThreads(false);
  for (const thread of active.threads.values()) byId.set(thread.id, thread);

  const parents = channels.filter((channel) => holdsThreads(channelKind(channel.type)) && canRead(channel, me));
  await forEachLimit(parents, DISCORD_EXPORT_CONCURRENCY, async (parent) => {
    const types = ["public"];
    if (parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageThreads)) types.push("private");

    for (const type of types) {
      try {
        const archived = await parent.threads.fetchArchived(
          { type, fetchAll: type === "private", limit: DISCORD_EXPORT_ARCHIVED_THREADS },
          false,
        );
        for (const thread of archived.threads.values()) byId.set(thread.id, thread);
        if (archived.hasMore) truncated.add(parent.id);
      } catch {
        // Немає доступу до архіву цього каналу — активні треди все одно є.
      }
    }
  });

  return { threads: [...byId.values()], truncated };
}

function canRead(channel, me) {
  return channel.permissionsFor(me)?.has(READ) ?? false;
}

/** Виконує fn для кожного елемента, не більше `limit` одночасно. */
async function forEachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

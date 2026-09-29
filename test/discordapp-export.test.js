import test from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";

import { channelKind, holdsMessages, holdsThreads } from "../src/module/discordapp/channelKinds.js";
import {
  looksLikeMissingContentIntent,
  toChannelRecord,
  toMessageRecord,
} from "../src/module/discordapp/features/export/snapshot.js";
import {
  formatJson,
  formatMarkdown,
  formatMessage,
  groupByCategory,
  summarize,
} from "../src/module/discordapp/features/export/format.js";
import {
  describeResult,
  exportFileName,
  exportCaption,
  exportDeliveryMessage,
} from "../src/module/discordapp/features/export/ChatExporter.js";
import { collectGuild } from "../src/module/discordapp/features/export/collector.js";

// ── Фабрики простих даних ──────────────────────────────────────────────────

function msg(id, overrides = {}) {
  return {
    id,
    createdAt: `2026-09-29T14:0${id}:00.000Z`,
    editedAt: null,
    author: { id: "u1", name: "Alice", bot: false },
    system: false,
    content: `message ${id}`,
    replyTo: null,
    attachments: [],
    embeds: [],
    stickers: [],
    reactions: [],
    pinned: false,
    ...overrides,
  };
}

function chan(id, overrides = {}) {
  return {
    id, name: id, kind: "text", position: 0, category: null, parentId: null,
    topic: null, skipped: null, truncatedThreads: false, messages: [], ...overrides,
  };
}

const INFO = { id: "cat-info", name: "INFO", position: 0 };
const CHAT = { id: "cat-chat", name: "CHAT", position: 1 };

// ── snapshot.js ────────────────────────────────────────────────────────────

test("channelKind / holdsMessages / holdsThreads", () => {
  assert.equal(channelKind(ChannelType.GuildText), "text");
  assert.equal(channelKind(ChannelType.GuildForum), "forum");
  assert.equal(channelKind(ChannelType.DM), null);
  assert.equal(holdsMessages("voice"), true, "текстовий чат голосового каналу теж експортується");
  assert.equal(holdsMessages("forum"), false, "у форумі повідомлення лише в тредах");
  assert.equal(holdsThreads("forum"), true);
  assert.equal(holdsThreads("voice"), false);
});

test("toMessageRecord — reads a discord.js-shaped message", () => {
  const record = toMessageRecord({
    id: "m1",
    createdAt: new Date("2026-09-29T14:02:00Z"),
    editedAt: new Date("2026-09-29T14:05:00Z"),
    author: { id: "u1", username: "alice", globalName: "Alice", bot: false },
    content: "hi",
    reference: { messageId: "m0" },
    attachments: new Map([["a1", { name: "a.png", url: "https://cdn/a.png", size: 2048, contentType: "image/png" }]]),
    embeds: [{ title: "T", description: "D", url: null }],
    stickers: new Map(),
    reactions: { cache: new Map([["r", { emoji: { name: "👍" }, count: 3 }]]) },
    pinned: true,
    system: false,
  });
  assert.equal(record.createdAt, "2026-09-29T14:02:00.000Z");
  assert.equal(record.author.name, "Alice", "globalName має перевагу над username");
  assert.equal(record.replyTo, "m0");
  assert.deepEqual(record.attachments[0], { name: "a.png", url: "https://cdn/a.png", size: 2048, contentType: "image/png" });
  assert.deepEqual(record.reactions, [{ emoji: "👍", count: 3 }]);
  assert.equal(record.pinned, true);
});

test("toChannelRecord — a thread takes its category from the parent channel", () => {
  const category = { id: "cat", name: "CAT", rawPosition: 2 };
  const record = toChannelRecord({
    id: "t1", name: "thread", type: ChannelType.PublicThread, rawPosition: 0,
    isThread: () => true, parentId: "c1", parent: { id: "c1", parent: category },
  });
  assert.equal(record.kind, "thread");
  assert.equal(record.parentId, "c1");
  assert.deepEqual(record.category, { id: "cat", name: "CAT", position: 2 });
});

test("looksLikeMissingContentIntent — fires only when human messages are nearly all empty", () => {
  const empty = Array.from({ length: 6 }, (_, i) => msg(String(i), { content: "" }));
  const withBots = [...empty.slice(0, 5), msg("9", { content: "", author: { id: "b", name: "Bot", bot: true } })];
  assert.equal(looksLikeMissingContentIntent({ guilds: [{ channels: [chan("c", { messages: empty })] }] }), true);
  assert.equal(looksLikeMissingContentIntent({ guilds: [{ channels: [chan("c", { messages: [msg("1"), ...empty] })] }] }), true);
  assert.equal(
    looksLikeMissingContentIntent({ guilds: [{ channels: [chan("c", { messages: [msg("1"), msg("2"), ...empty.slice(0, 4)] })] }] }),
    false,
  );
  assert.equal(looksLikeMissingContentIntent({ guilds: [{ channels: [chan("c", { messages: withBots.slice(0, 4) })] }] }), false,
    "замало повідомлень, щоб робити висновок");
});

// ── format.js ──────────────────────────────────────────────────────────────

test("groupByCategory — categories in server order, threads under their parent, orphans kept", () => {
  const channels = [
    chan("general", { category: CHAT, position: 1 }),
    chan("rules", { category: INFO, position: 0 }),
    chan("news", { category: CHAT, position: 0 }),
    chan("lobby", { position: 0 }),
    chan("t-help", { kind: "thread", parentId: "general", category: CHAT }),
    chan("t-orphan", { kind: "thread", parentId: "hidden", category: CHAT, position: 5 }),
  ];
  const groups = groupByCategory(channels);
  assert.deepEqual(groups.map((g) => g.category?.name ?? null), [null, "INFO", "CHAT"]);
  assert.deepEqual(groups[2].channels.map((c) => c.name), ["news", "general", "t-orphan"]);
  assert.deepEqual(groups[2].channels[1].threads.map((t) => t.name), ["t-help"]);
});

test("formatMessage — reply, multi-line, attachment, embed, reactions, edited, bot", () => {
  const original = msg("1");
  const reply = msg("2", {
    author: { id: "b", name: "Helper", bot: true },
    content: "line one\nline two",
    replyTo: "1",
    editedAt: "2026-09-29T15:00:00.000Z",
    attachments: [{ name: "log.txt", size: 1536 }],
    embeds: [{ title: "Title", description: "Desc" }],
    reactions: [{ emoji: "🔥", count: 2 }],
  });
  const lines = formatMessage(reply, new Map([["1", original]]));
  assert.deepEqual(lines, [
    "[2026-09-29 14:02] Helper [bot] ↪ Alice: line one _(edited)_",
    "    line two",
    "    📎 log.txt (1.5 KB)",
    "    🔗 Title — Desc",
    "    reactions: 🔥 2",
  ]);
  assert.match(formatMessage(msg("3", { replyTo: "gone" }))[0], /↪ earlier message:/);
});

test("formatMarkdown — headers, skipped, empty, forum with threads", () => {
  const snapshot = {
    exportedAt: "2026-09-29T14:10:00.000Z",
    limit: 50,
    guilds: [{
      id: "g", name: "My Server",
      channels: [
        chan("rules", { category: INFO, messages: [msg("1")], topic: "Read\nthis" }),
        chan("staff", { category: INFO, position: 1, skipped: "no access" }),
        chan("quiet", { category: CHAT }),
        chan("ideas", { kind: "forum", category: CHAT, position: 1, truncatedThreads: true }),
        chan("idea-1", { kind: "thread", parentId: "ideas", category: CHAT, messages: [msg("2")] }),
      ],
    }],
  };
  const md = formatMarkdown(snapshot);
  assert.match(md, /^# My Server\n/);
  assert.match(md, /> Exported 2026-09-29 14:10 UTC · last 50 messages per channel · 4 channels · 2 messages · 1 skipped/);
  assert.match(md, /## 📁 INFO\n\n### #rules\n> Read this\n\n\[2026-09-29 14:01\] Alice: message 1/);
  assert.match(md, /### #staff\n\n_skipped: no access_/);
  assert.match(md, /### #quiet\n\n_no messages_/);
  assert.match(md, /### 💬 ideas\n\n_older archived threads not exported_\n\n#### 🧵 idea-1\n\n\[2026-09-29 14:02\] Alice: message 2/);
});

test("summarize and formatJson", () => {
  const snapshot = { exportedAt: "x", limit: 1, guilds: [{ name: "S", channels: [chan("a", { messages: [msg("1")] }), chan("b", { skipped: "no access" })] }] };
  const stats = summarize(snapshot);
  assert.equal(stats.channels, 1);
  assert.equal(stats.messages, 1);
  assert.deepEqual(stats.skipped, [{ guild: "S", channel: "b", reason: "no access" }]);
  assert.deepEqual(JSON.parse(formatJson(snapshot)), snapshot);
});

// ── ChatExporter.js ────────────────────────────────────────────────────────

test("exportFileName — slug and UTC stamp", () => {
  const date = new Date("2026-09-29T14:02:33Z");
  assert.equal(exportFileName("My Server!", date, "md"), "export-my-server-20260929-1402.md");
  assert.equal(exportFileName("Сервер №1", date, "json"), "export-сервер-1-20260929-1402.json");
  assert.equal(exportFileName("🔥🔥", date, "md"), "export-server-20260929-1402.md");
});

test("exportDeliveryMessage — files go to Telegram through the normal delivery path", () => {
  const files = [{ name: "export-x.md", data: Buffer.from("# x") }, { name: "export-x.json", data: Buffer.from("{}") }];
  const message = exportDeliveryMessage(files, { chat: "@me", label: "My Server", summary: "2 messages" });
  assert.deepEqual(message.source.destinations, { telegram: ["@me"] }, "лише Telegram — не Discord");
  assert.equal(message.source.name, "Inemuri export · My Server");
  assert.deepEqual(message.downloadedMedia.map((m) => [m.type, m.filename, m.mimeType]), [
    ["document", "export-x.md", "text/markdown"],
    ["document", "export-x.json", "application/json"],
  ]);
  assert.equal(message.text, "2 messages");
});

test("describeResult — counts, saved files, skipped list, intent warning", () => {
  const empty = Array.from({ length: 6 }, (_, i) => msg(String(i), { content: "" }));
  const snapshot = { guilds: [{ name: "S", channels: [chan("a", { messages: empty }), chan("b", { skipped: "no access" })] }] };
  const text = describeResult(snapshot, { saved: ["export.md"], telegram: null });
  assert.match(text, /Exported \*\*6\*\* messages from \*\*1\*\* channels\./);
  assert.match(text, /`exports\/export\.md`/);
  assert.match(text, /Message Content Intent/);
  assert.match(text, /- #b — no access/);
  assert.match(text, /DISCORD_EXPORT_TELEGRAM_CHAT/);
  assert.match(describeResult(snapshot, { saved: ["export.md"], telegram: "@me" }), /Sent to Telegram \(@me\)/);
  assert.equal(exportCaption(snapshot), "6 messages · 1 channels · 1 skipped");
});

// ── collector.js на підробленому сервері ───────────────────────────────────

function fakeChannel({ id, type, readable = true, messages = [], parent = null, archived = [], hasMore = false }) {
  return {
    id, name: id, type, rawPosition: 0, parent, parentId: parent?.id ?? null, topic: null,
    isThread: () => [ChannelType.PublicThread, ChannelType.PrivateThread].includes(type),
    permissionsFor: () => ({ has: () => readable }),
    messages: {
      fetch: async ({ limit }) => new Map(messages.slice(0, limit).map((m) => [m.id, m])),
    },
    threads: { fetchArchived: async () => ({ threads: new Map(archived.map((t) => [t.id, t])), hasMore }) },
  };
}

function discordMessage(id, minute) {
  return { id, createdAt: new Date(`2026-09-29T14:${minute}:00Z`), author: { id: "u", username: "u" }, content: id };
}

test("collectGuild — chronological messages, skipped channels, archived threads", async () => {
  const general = fakeChannel({
    id: "general", type: ChannelType.GuildText,
    // Як з API: від нових до старих.
    messages: [discordMessage("m3", "03"), discordMessage("m2", "02"), discordMessage("m1", "01")],
    hasMore: true,
  });
  const archivedThread = fakeChannel({ id: "old-thread", type: ChannelType.PublicThread, parent: general, messages: [discordMessage("t1", "05")] });
  general.threads.fetchArchived = async () => ({ threads: new Map([["old-thread", archivedThread]]), hasMore: true });
  const staff = fakeChannel({ id: "staff", type: ChannelType.GuildText, readable: false });
  const category = fakeChannel({ id: "cat", type: ChannelType.GuildCategory });

  const guild = {
    id: "g", name: "Guild",
    members: { fetchMe: async () => ({ id: "me" }) },
    channels: {
      fetch: async () => new Map([["general", general], ["staff", staff], ["cat", category]]),
      fetchActiveThreads: async () => ({ threads: new Map() }),
    },
  };

  const result = await collectGuild(guild, { limit: 2 });
  const byId = Object.fromEntries(result.channels.map((c) => [c.id, c]));

  assert.deepEqual(Object.keys(byId).sort(), ["general", "old-thread", "staff"], "категорія — не канал експорту");
  assert.deepEqual(byId.general.messages.map((m) => m.id), ["m2", "m3"], "limit, потім хронологія");
  assert.equal(byId.general.truncatedThreads, true);
  assert.equal(byId.staff.skipped, "no access");
  assert.deepEqual(byId["old-thread"].messages.map((m) => m.id), ["t1"]);
});

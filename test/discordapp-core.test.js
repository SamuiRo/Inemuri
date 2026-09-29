import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { checkAccess, isServedGuild } from "../src/module/discordapp/guard.js";
import { buildCustomId, parseCustomId } from "../src/module/discordapp/customId.js";
import CommandRegistry, { toReply } from "../src/module/discordapp/CommandRegistry.js";
import { toRestPayload } from "../src/module/discord/DiscordRest.js";

// ── guard ──────────────────────────────────────────────────────────────────

const POLICY = { whitelist: ["admin-1"], guildIds: ["g-1"] };

test("checkAccess — admin in a served guild passes", () => {
  assert.deepEqual(checkAccess({ admin: true, userId: "admin-1", guildId: "g-1" }, POLICY), { ok: true });
});

test("checkAccess — admin command refused for a user outside the whitelist", () => {
  const result = checkAccess({ admin: true, userId: "someone", guildId: "g-1" }, POLICY);
  assert.equal(result.ok, false);
});

test("checkAccess — empty whitelist refuses admin commands (fail closed, D7)", () => {
  const result = checkAccess({ admin: true, userId: "anyone", guildId: "g-1" }, { whitelist: [], guildIds: [] });
  assert.equal(result.ok, false);
});

test("checkAccess — non-admin handlers are open to everyone in a served guild", () => {
  assert.equal(checkAccess({ userId: "someone", guildId: "g-1" }, POLICY).ok, true);
});

test("checkAccess — unserved guild is refused before the admin check", () => {
  const result = checkAccess({ admin: true, userId: "someone", guildId: "g-2" }, POLICY);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not managed/, "відмова за сервером не має казати, що команда адмінська");
});

test("checkAccess — DMs are refused", () => {
  assert.equal(checkAccess({ userId: "admin-1", guildId: null }, POLICY).ok, false);
});

test("isServedGuild — empty allowlist serves every guild (D8)", () => {
  assert.equal(isServedGuild("any", []), true);
  assert.equal(isServedGuild("g-2", ["g-1"]), false);
});

// ── customId ───────────────────────────────────────────────────────────────

test("customId — round-trips prefix, action and args", () => {
  const id = buildCustomId("roles", "toggle", "topics", 123);
  assert.equal(id, "roles:toggle:topics:123");
  assert.deepEqual(parseCustomId(id), { prefix: "roles", action: "toggle", args: ["topics", "123"] });
});

test("customId — refuses separators inside parts and ids over 100 chars", () => {
  assert.throws(() => buildCustomId("roles", "a:b"));
  assert.throws(() => buildCustomId("roles", ""));
  assert.throws(() => buildCustomId("roles", "x", "y".repeat(100)));
});

// ── toReply ────────────────────────────────────────────────────────────────

test("toReply — string, nothing, and payload objects", () => {
  assert.deepEqual(toReply("hi"), { content: "hi" });
  assert.deepEqual(toReply(undefined), { content: "✅ Done." });
  const payload = { content: "x", files: [] };
  assert.equal(toReply(payload), payload);
  assert.equal(toReply("a".repeat(3000)).content.length, 2000);
});

// ── CommandRegistry ────────────────────────────────────────────────────────

/** Мінімальна підробка interaction: записує всі відповіді. */
function fakeInteraction({ commandName = null, customId = null, userId = "admin-1", guildId = "g-1" } = {}) {
  const calls = [];
  return {
    calls,
    commandName,
    customId,
    guildId,
    type: 2,
    user: { id: userId, tag: `user#${userId}` },
    isRepliable: () => true,
    isChatInputCommand: () => commandName != null,
    isMessageComponent: () => customId != null,
    reply: async (payload) => calls.push(["reply", payload]),
    deferReply: async (payload) => calls.push(["deferReply", payload]),
    editReply: async (payload) => calls.push(["editReply", payload]),
  };
}

function command(name, execute, admin = true) {
  return { data: new SlashCommandBuilder().setName(name).setDescription(name), admin, execute };
}

test("CommandRegistry — defers as ephemeral before the handler runs (D5)", async () => {
  const seen = [];
  const registry = new CommandRegistry({
    commands: [command("ping", async (interaction) => { seen.push([...interaction.calls]); return "pong"; })],
    policy: POLICY,
  });
  const interaction = fakeInteraction({ commandName: "ping" });
  await registry.dispatch(interaction);

  assert.deepEqual(seen[0], [["deferReply", { flags: MessageFlags.Ephemeral }]], "обробник стартує вже після ephemeral defer");
  assert.deepEqual(interaction.calls.at(-1), ["editReply", { content: "pong" }]);
});

test("CommandRegistry — refused access replies ephemeral and never runs the handler", async () => {
  let ran = false;
  const registry = new CommandRegistry({
    commands: [command("ping", async () => { ran = true; })],
    policy: POLICY,
  });
  const interaction = fakeInteraction({ commandName: "ping", userId: "someone" });
  await registry.dispatch(interaction);

  assert.equal(ran, false);
  assert.equal(interaction.calls.length, 1);
  assert.equal(interaction.calls[0][0], "reply");
  assert.equal(interaction.calls[0][1].flags, MessageFlags.Ephemeral);
});

test("CommandRegistry — a throwing handler becomes an ephemeral error, not a crash", async () => {
  const registry = new CommandRegistry({
    commands: [command("boom", async () => { throw new Error("kaput"); })],
    policy: POLICY,
  });
  const interaction = fakeInteraction({ commandName: "boom" });
  await registry.dispatch(interaction);
  assert.deepEqual(interaction.calls.at(-1), ["editReply", { content: "❌ kaput" }]);
});

test("CommandRegistry — components are routed by customId prefix", async () => {
  const registry = new CommandRegistry({
    commands: [],
    components: [{ prefix: "roles", execute: async (interaction) => parseCustomId(interaction.customId).args.join(",") }],
    policy: POLICY,
  });
  const interaction = fakeInteraction({ customId: "roles:toggle:topics:42", userId: "someone" });
  await registry.dispatch(interaction);
  assert.deepEqual(interaction.calls.at(-1), ["editReply", { content: "topics,42" }]);
});

test("CommandRegistry — an update component edits its own message and clears its buttons", async () => {
  const registry = new CommandRegistry({
    commands: [],
    components: [{ prefix: "confirm", update: true, execute: async () => "done" }],
    policy: POLICY,
  });
  const interaction = fakeInteraction({ customId: "confirm:yes" });
  interaction.deferUpdate = async () => interaction.calls.push(["deferUpdate"]);
  await registry.dispatch(interaction);
  assert.deepEqual(interaction.calls, [["deferUpdate"], ["editReply", { components: [], attachments: [], content: "done" }]]);
});

test("CommandRegistry — unknown command gets an ephemeral answer", async () => {
  const registry = new CommandRegistry({ commands: [], policy: POLICY });
  const interaction = fakeInteraction({ commandName: "gone" });
  await registry.dispatch(interaction);
  assert.equal(interaction.calls[0][1].flags, MessageFlags.Ephemeral);
});

test("CommandRegistry — admin commands are hidden behind Administrator in definitions", () => {
  const registry = new CommandRegistry({
    commands: [command("admin-cmd", async () => {}), command("open-cmd", async () => {}, false)],
    policy: POLICY,
  });
  const [adminDef, openDef] = registry.definitions();
  assert.equal(adminDef.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(openDef.default_member_permissions ?? null, null);
});

test("CommandRegistry — duplicate command names are refused at construction", () => {
  assert.throws(() => new CommandRegistry({
    commands: [command("dup", async () => {}), command("dup", async () => {})],
    policy: POLICY,
  }));
});

// ── toRestPayload ──────────────────────────────────────────────────────────

test("toRestPayload — builders become raw JSON and files", () => {
  const data = Buffer.from("png");
  const { body, files } = toRestPayload({
    embeds: [new EmbedBuilder().setDescription("hi").setImage("attachment://a.png")],
    files: [new AttachmentBuilder(data, { name: "a.png" })],
  });
  assert.deepEqual(body.embeds, [{ description: "hi", image: { url: "attachment://a.png" } }]);
  assert.deepEqual(files, [{ name: "a.png", data }]);
});

test("toRestPayload — a string is plain content, no files key", () => {
  assert.deepEqual(toRestPayload("hello"), { body: { content: "hello" } });
});

// ── DiscordDestination через REST ──────────────────────────────────────────

test("DiscordDestination — sends through REST with embed and attachment, no gateway", async () => {
  const { default: DiscordDestinationAdapter } = await import("../src/destinations/discord/DiscordDestination.js");
  const adapter = new DiscordDestinationAdapter({ emit() {} });
  const sent = [];
  adapter.rest = {
    isConfigured: true,
    sendMessage: async (channelId, payload) => {
      sent.push([channelId, toRestPayload(payload)]);
      return { id: "m-1", channel_id: channelId };
    },
  };
  await adapter.connect();

  const message = await adapter.sendMessage("c-1", {
    source: { name: "Source" },
    text: "hello",
    downloadedMedia: [{ type: "photo", data: Buffer.from("jpg"), mimeType: "image/jpeg" }],
  });

  const [channelId, { body, files }] = sent[0];
  assert.equal(channelId, "c-1");
  assert.equal(body.embeds[0].description, "hello");
  assert.equal(body.embeds[0].image.url, `attachment://${files[0].name}`);
  assert.deepEqual(adapter.describeSent(message, "c-1").message_id, "m-1");
});

test("DiscordDestination — connect() fails loudly without a token", async () => {
  const { default: DiscordDestinationAdapter } = await import("../src/destinations/discord/DiscordDestination.js");
  const adapter = new DiscordDestinationAdapter({ emit() {} });
  adapter.rest = { isConfigured: false };
  await assert.rejects(adapter.connect(), /DISCORD_BOT_TOKEN/);
});

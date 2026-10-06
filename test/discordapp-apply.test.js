import test from "node:test";
import assert from "node:assert/strict";
import { AutoModerationRuleTriggerType as Trigger, OverwriteType, PermissionFlagsBits as P } from "discord.js";

import { validateServerConfig } from "../src/module/discordapp/features/provision/schema.js";
import { actionableOps, planProvision } from "../src/module/discordapp/features/provision/planner.js";
import { formatPlan } from "../src/module/discordapp/features/provision/formatPlan.js";
import { applyProvision, formatApplyLog, permissionEdit, roleFields } from "../src/module/discordapp/features/provision/applier.js";
import { channelKind } from "../src/module/discordapp/channelKinds.js";

const GUILD = "111111111111111111";
const BOT_ROLE = "r-bot";

/**
 * Discord-сервер у пам'яті: рівно ті виклики, які робить applier, і знімок
 * у форматі readGuild. Поведінка Discord, від якої залежить applier,
 * відтворена: нова роль з'являється внизу, канал без overwrites синхронізується
 * з категорією, lockPermissions копіює права категорії.
 */
class FakeGuild {
  constructor({ community = false } = {}) {
    this.id = GUILD;
    this.name = "Fake";
    this.community = community;
    this.nextId = 1;
    this.roleList = [{ id: BOT_ROLE, name: "Inemuri", color: 0, hoist: false, mentionable: false, permissions: 0n, position: 50, managed: true }];
    this.channelList = [];
    this.messageList = [];
    this.automodList = [];
    this.specialChannelIds = [];
    // Правила, які Discord не дає редагувати (створені ним самим).
    this.lockedRules = new Set();
    this.calls = [];

    this.autoModerationRules = {
      create: async (options) => {
        this.calls.push("automod.create");
        const rule = { id: `a${this.nextId++}`, ...this.toRule(options) };
        this.automodList.push(rule);
        return rule;
      },
      edit: async (id, options) => {
        this.calls.push("automod.edit");
        if (this.lockedRules.has(id)) throw Object.assign(new Error("404: Not Found"), { status: 404 });
        const rule = this.automodList.find((r) => r.id === id);
        Object.assign(rule, this.toRule({ triggerType: rule.triggerType, ...options }));
      },
    };

    this.roles = {
      create: async (options) => {
        this.calls.push("role.create");
        for (const role of this.roleList) role.position += 1;
        const role = { id: `r${this.nextId++}`, color: 0, hoist: false, mentionable: false, permissions: 0n, managed: false, position: 1 };
        this.applyRole(role, options);
        this.roleList.push(role);
        return role;
      },
      edit: async (id, options) => {
        this.calls.push("role.edit");
        this.applyRole(this.roleList.find((r) => r.id === id), options);
      },
      setPositions: async (list) => {
        this.calls.push("role.setPositions");
        for (const { role, position } of list) this.roleList.find((r) => r.id === role).position = position;
      },
    };

    this.channels = {
      create: async (options) => {
        this.calls.push("channel.create");
        const siblings = this.channelList.filter((c) => c.parentId === (options.parent ?? null));
        const channel = {
          id: `c${this.nextId++}`, kind: channelKind(options.type), parentId: options.parent ?? null,
          position: siblings.length, topic: null, nsfw: false, slowmode: 0, overwrites: [],
        };
        this.applyChannel(channel, { ...options, lockPermissions: !options.permissionOverwrites && Boolean(options.parent) });
        this.channelList.push(channel);
        return channel;
      },
      edit: async (id, options) => {
        this.calls.push("channel.edit");
        this.applyChannel(this.channelList.find((c) => c.id === id), options);
      },
      setPositions: async (list) => {
        this.calls.push("channel.setPositions");
        for (const { channel, position } of list) this.channelList.find((c) => c.id === channel).position = position;
      },
      // Як у discord.js: канал з кешу вміє надсилати й редагувати повідомлення.
      cache: { get: (id) => this.channelList.some((c) => c.id === id) && this.textChannel(id) },
    };
  }

  textChannel(channelId) {
    this.webhookList ??= [];
    const hookApi = (hook) => ({
      ...hook,
      send: async (payload) => {
        this.calls.push("webhook.send");
        const message = { id: `m${this.nextId++}`, channelId, payload, webhookId: hook.id };
        this.messageList.push(message);
        return message;
      },
      editMessage: async (id, payload) => {
        this.calls.push("webhook.edit");
        const message = this.messageList.find((m) => m.id === id);
        // Як Discord: вебхук не бачить чужих повідомлень — 10008.
        if (message.webhookId !== hook.id) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        message.payload = payload;
      },
    });
    this.botId ??= "bot-user";
    return {
      client: { user: { id: this.botId } },
      fetchWebhooks: async () => this.webhookList.filter((h) => h.channelId === channelId).map(hookApi),
      createWebhook: async ({ name, avatar }) => {
        this.calls.push("webhook.create");
        const hook = { id: `w${this.nextId++}`, channelId, name, avatar, token: "t", owner: { id: this.botId } };
        this.webhookList.push(hook);
        return hookApi(hook);
      },
      send: async (payload) => {
        this.calls.push("message.send");
        const message = { id: `m${this.nextId++}`, channelId, payload, webhookId: null, authorId: this.botId };
        this.messageList.push(message);
        return message;
      },
      messages: {
        edit: async (id, payload) => {
          this.calls.push("message.edit");
          const message = this.messageList.find((m) => m.id === id);
          // Як Discord: чуже повідомлення бот не править — 50005.
          if (message.webhookId || message.authorId !== this.botId) {
            throw Object.assign(new Error("Cannot edit a message authored by another user"), { code: 50005 });
          }
          message.payload = payload;
        },
      },
    };
  }

  applyRole(role, { name, colors, hoist, mentionable, permissions }) {
    if (name !== undefined) role.name = name;
    if (colors) role.color = colors.primaryColor;
    if (hoist !== undefined) role.hoist = hoist;
    if (mentionable !== undefined) role.mentionable = mentionable;
    if (permissions !== undefined) role.permissions = permissions;
  }

  applyChannel(channel, options) {
    if (options.name !== undefined) channel.name = options.name;
    if (options.type !== undefined) channel.kind = channelKind(options.type);
    if (options.parent !== undefined) channel.parentId = options.parent;
    if (options.topic !== undefined) channel.topic = options.topic;
    if (options.nsfw !== undefined) channel.nsfw = options.nsfw;
    if (options.rateLimitPerUser !== undefined) channel.slowmode = options.rateLimitPerUser;
    if (options.permissionOverwrites) {
      channel.overwrites = options.permissionOverwrites.map(({ id, type, allow, deny }) => ({
        id, type: type === OverwriteType.Member ? "member" : "role", allow, deny,
      }));
    } else if (options.lockPermissions && channel.parentId) {
      channel.overwrites = structuredClone(this.channelList.find((c) => c.id === channel.parentId).overwrites);
    }
  }

  /** Опції discord.js → правило у форматі readGuild (channel → channelId). */
  toRule({ name, enabled, triggerType, triggerMetadata, actions, exemptRoles, exemptChannels }) {
    return {
      name, enabled, triggerType,
      triggerMetadata: structuredClone(triggerMetadata ?? {}),
      actions: (actions ?? []).map(({ type, metadata = {} }) => ({
        type,
        metadata: { customMessage: metadata.customMessage ?? null, channelId: metadata.channel ?? null, durationSeconds: metadata.durationSeconds ?? null },
      })),
      exemptRoles: [...(exemptRoles ?? [])],
      exemptChannels: [...(exemptChannels ?? [])],
    };
  }

  /** Знімок у форматі readGuild. */
  snapshot() {
    return structuredClone({
      guildId: this.id,
      name: this.name,
      community: this.community,
      everyoneId: this.id,
      bot: { userId: "bot-user", roleId: BOT_ROLE, highestPosition: this.roleList.find((r) => r.id === BOT_ROLE).position, admin: true },
      roles: this.roleList,
      channels: this.channelList,
      messages: this.messageList.map(({ id, channelId, webhookId }) => ({ id, channelId, webhookId: webhookId ?? null })),
      automod: this.automodList,
      specialChannelIds: this.specialChannelIds,
    });
  }

  byName(name) {
    return this.channelList.find((c) => c.name === name);
  }
}

/** Стан у пам'яті з тим самим API, що й DiscordResource. */
function memoryStore() {
  const rows = [];
  const find = (guildId, kind, key) => rows.find((r) => r.guild_id === guildId && r.kind === kind && r.key === key);
  return {
    rows,
    forGuild: async (guildId) => rows.filter((r) => r.guild_id === guildId).map((r) => ({ ...r })),
    remember: async (guildId, kind, key, discordId, extra = {}) => {
      const row = find(guildId, kind, key) ?? rows[rows.push({ guild_id: guildId, kind, key }) - 1];
      Object.assign(row, { discord_id: discordId, archived_at: null, archived_from: null, ...extra });
    },
    markArchived: async (guildId, key, fromKey) => {
      Object.assign(find(guildId, "channel", key), { archived_at: new Date(), archived_from: fromKey ?? null });
    },
    forget: async (guildId, kind, key) => {
      rows.splice(rows.indexOf(find(guildId, kind, key)), 1);
    },
  };
}

/** Бажаний стан; тексти повідомлень — з `bodies` замість файлів (їх читає Provisioner). */
function desiredOf(raw, bodies = {}) {
  const { errors, desired } = validateServerConfig({ guildId: GUILD, ...raw });
  assert.deepEqual(errors, []);
  for (const message of desired.messages) if (message.kind === "text") message.body = bodies[message.file] ?? `text of ${message.file}`;
  return desired;
}

async function apply(guild, desired, store) {
  const log = await applyProvision({ guild, desired, store, read: async (g) => g.snapshot() });
  assert.deepEqual(log.filter((entry) => !entry.ok), [], "усі операції мають пройти");
  return log;
}

async function remaining(guild, desired, store) {
  return actionableOps(planProvision(desired, guild.snapshot(), await store.forGuild(GUILD)));
}

const CONFIG = {
  archive: { key: "archive", name: "ARCHIVE", roles: ["admin"] },
  presets: { staff: { "@everyone": { deny: ["ViewChannel"] }, "role:mod": { allow: ["ViewChannel"] } } },
  roles: [
    { key: "admin", name: "Admin", color: "#ff0000", permissions: ["Administrator"] },
    { key: "mod", name: "Mod", permissions: ["ManageMessages"] },
  ],
  categories: [
    { key: "info", name: "INFO", overwrites: { "@everyone": { deny: ["SendMessages"] } }, channels: [
      { key: "rules", name: "Rules", topic: "Be nice" },
      { key: "faq", name: "faq" },
    ] },
    { key: "staff", name: "STAFF", overwrites: "staff", channels: [{ key: "staff-chat", name: "staff-chat" }] },
  ],
  channels: [{ key: "lobby", name: "Lobby", type: "voice" }],
};

// ── Наскрізні сценарії ─────────────────────────────────────────────────────

test("apply — an empty server ends up exactly as configured, and a second plan is empty", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  const desired = desiredOf(CONFIG);

  await apply(guild, desired, store);

  const admin = guild.roleList.find((r) => r.name === "Admin");
  const mod = guild.roleList.find((r) => r.name === "Mod");
  assert.equal(admin.color, 0xff0000);
  assert.ok(admin.position > mod.position, "порядок ролей — як у конфігу");
  assert.ok(guild.roleList.find((r) => r.id === BOT_ROLE).position > admin.position, "бот лишається найвищим");

  const info = guild.byName("INFO");
  const rules = guild.byName("rules");
  assert.equal(rules.parentId, info.id);
  assert.equal(rules.topic, "Be nice");
  assert.deepEqual(rules.overwrites, info.overwrites, "канал без власних overwrites синхронізований з категорією");
  assert.ok(guild.byName("faq").position > rules.position);

  const staffChat = guild.byName("staff-chat");
  assert.ok(staffChat.overwrites.some((o) => o.id === BOT_ROLE && (o.allow & P.ViewChannel)), "бот бачить приватний канал");
  assert.ok(staffChat.overwrites.some((o) => o.id === mod.id && (o.allow & P.ViewChannel)));

  const archive = guild.byName("ARCHIVE");
  assert.ok(archive.overwrites.some((o) => o.id === GUILD && (o.deny & P.ViewChannel)), "архів приватний");
  assert.equal(guild.byName("Lobby").kind, "voice");

  assert.deepEqual(await remaining(guild, desired, store), [], "другий план порожній — apply ідемпотентний");
  const calls = guild.calls.length;
  await apply(guild, desired, store);
  assert.equal(guild.calls.length, calls, "повторний apply нічого не викликає");
});

test("apply — a channel leaving the config is archived, and restored when it comes back", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  await apply(guild, desiredOf(CONFIG), store);
  const faq = guild.byName("faq");

  const without = structuredClone(CONFIG);
  without.categories[0].channels = without.categories[0].channels.filter((c) => c.key !== "faq");
  const desiredWithout = desiredOf(without);
  await apply(guild, desiredWithout, store);

  const archive = guild.byName("ARCHIVE");
  assert.equal(guild.byName("faq").id, faq.id, "канал той самий — не видалений і не перестворений");
  assert.equal(guild.byName("faq").parentId, archive.id);
  assert.deepEqual(guild.byName("faq").overwrites, archive.overwrites, "права архіву: колишні учасники не бачать");
  assert.equal(store.rows.find((r) => r.key === "faq").archived_from, "info");
  assert.deepEqual(await remaining(guild, desiredWithout, store), []);

  const desired = desiredOf(CONFIG);
  await apply(guild, desired, store);
  assert.equal(guild.byName("faq").id, faq.id);
  assert.equal(guild.byName("faq").parentId, guild.byName("INFO").id);
  assert.deepEqual(guild.byName("faq").overwrites, guild.byName("INFO").overwrites, "права знову від категорії");
  assert.equal(store.rows.find((r) => r.key === "faq").archived_at, null);
  assert.deepEqual(await remaining(guild, desired, store), []);
});

test("apply — existing resources are adopted, not duplicated; unmanaged overwrites survive", async () => {
  const guild = new FakeGuild();
  guild.roleList.push({ id: "r-old", name: "Mod", color: 0, hoist: false, mentionable: false, permissions: 0n, position: 5, managed: false });
  guild.channelList.push({
    id: "c-old", name: "lobby-text", kind: "text", parentId: null, position: 0, topic: null, nsfw: false, slowmode: 0,
    overwrites: [{ id: "member-1", type: "member", allow: P.ViewChannel, deny: 0n }],
  });
  const store = memoryStore();
  const desired = desiredOf({
    archive: { key: "archive", name: "ARCHIVE" },
    roles: [{ key: "mod", name: "Mod", permissions: ["ManageMessages"] }],
    channels: [{ key: "lobby", name: "lobby-text", overwrites: { "@everyone": { deny: ["SendMessages"] } } }],
  });

  await apply(guild, desired, store);
  assert.equal(guild.roleList.filter((r) => r.name === "Mod").length, 1);
  assert.equal(guild.roleList.find((r) => r.id === "r-old").permissions, P.ManageMessages);
  const lobby = guild.channelList.find((c) => c.id === "c-old");
  assert.ok(lobby.overwrites.some((o) => o.id === "member-1"), "ручний overwrite учасника збережено");
  assert.ok(lobby.overwrites.some((o) => o.id === GUILD && o.deny === P.SendMessages));
  assert.deepEqual(await remaining(guild, desired, store), []);
});

test("apply — a full archive rolls over into a second archive category", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  const config = { archive: { key: "archive", name: "ARCHIVE" }, channels: [{ key: "keep", name: "keep" }, { key: "gone", name: "gone" }] };
  await apply(guild, desiredOf(config), store);

  const archive = guild.byName("ARCHIVE");
  for (let i = 0; i < 50; i++) {
    guild.channelList.push({ id: `filler-${i}`, name: `old-${i}`, kind: "text", parentId: archive.id, position: i, topic: null, nsfw: false, slowmode: 0, overwrites: [] });
  }
  const desired = desiredOf({ ...config, channels: [{ key: "keep", name: "keep" }] });
  await apply(guild, desired, store);

  const overflow = guild.byName("ARCHIVE 2");
  assert.ok(overflow, "друга архівна категорія створена");
  assert.equal(guild.byName("gone").parentId, overflow.id);
  assert.equal(store.rows.find((r) => r.kind === "category" && r.key === "archive-2").discord_id, overflow.id);
  assert.deepEqual(await remaining(guild, desired, store), [], "переповнений архів не сприймається як orphaned");
});

test("apply — a failing operation is logged and the rest of the phase still runs", async () => {
  const guild = new FakeGuild();
  const create = guild.channels.create;
  guild.channels.create = async (options) => {
    if (options.name === "broken") throw new Error("Missing Permissions");
    return create(options);
  };
  const log = await applyProvision({
    guild,
    desired: desiredOf({ archive: { key: "archive", name: "ARCHIVE" }, channels: [{ key: "a", name: "broken" }, { key: "b", name: "fine" }] }),
    store: memoryStore(),
    read: async (g) => g.snapshot(),
  });
  assert.ok(log.some((entry) => !entry.ok && entry.text.includes("Missing Permissions")));
  assert.ok(guild.byName("fine"), "незалежний канал створено попри збій сусіда");
  assert.match(formatApplyLog(log, { guildName: "Fake" }), /\*\*1 failed\*\*/);
});

// ── Чисті помічники ────────────────────────────────────────────────────────

test("roleFields — only configured fields are sent", () => {
  assert.deepEqual(roleFields({ name: "A", permissions: null }), { name: "A" });
  assert.deepEqual(roleFields({ name: "A", color: 255, hoist: true, permissions: 0n }), { name: "A", colors: { primaryColor: 255 }, hoist: true, permissions: 0n });
});

test("permissionEdit — explicit, sync on move, strip archive rights at the root, untouched otherwise", () => {
  const context = { everyoneId: GUILD, bot: { id: BOT_ROLE, type: "role" }, roleIds: new Map(), roleNames: new Map() };
  const have = { parentId: "archive", overwrites: [
    { id: GUILD, type: "role", allow: 0n, deny: P.ViewChannel },
    { id: "member-1", type: "member", allow: P.ViewChannel, deny: 0n },
  ] };
  const spec = { overwrites: null };

  assert.deepEqual(permissionEdit({ op: "restore" }, spec, have, "info", context), { lockPermissions: true });
  const atRoot = permissionEdit({ op: "restore" }, spec, have, null, context);
  assert.deepEqual(atRoot.permissionOverwrites.map((o) => o.id), ["member-1"], "архівна заборона знята, ручне лишилось");
  assert.deepEqual(permissionEdit({ op: "update" }, spec, { ...have, parentId: "info" }, "info", context), {});
  const explicit = permissionEdit({ op: "update" }, { overwrites: [{ target: "@everyone", allow: 0n, deny: P.SendMessages }] }, have, "info", context);
  assert.equal(explicit.permissionOverwrites.length, 2);
});

// ── Повідомлення і панелі ──────────────────────────────────────────────────

const WITH_MESSAGES = {
  archive: { key: "archive", name: "ARCHIVE" },
  roles: [{ key: "rust", name: "Rust", permissions: [] }],
  categories: [
    { key: "info", name: "INFO", channels: [{ key: "rules", name: "rules", messages: [
      { key: "rules-main", file: "rules.md", embed: true },
      { key: "topics", rolePanel: { roles: [] } },
    ] }] },
    { key: "rust", name: "RUST", optIn: { role: "rust", panel: "topics" }, channels: [{ key: "rust-chat", name: "rust-chat" }] },
  ],
};

test("apply — messages are posted once, edited in place when the text changes, reposted when deleted", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  const desired = desiredOf(WITH_MESSAGES, { "rules.md": "Be nice @everyone" });
  await apply(guild, desired, store);

  const rules = guild.byName("rules");
  const [text, panel] = guild.messageList;
  assert.equal(text.channelId, rules.id);
  assert.deepEqual(text.payload.embeds, [{ description: "Be nice @everyone" }]);
  assert.deepEqual(text.payload.allowedMentions, { parse: [] }, "@everyone у тексті нікого не пінгує");

  const rust = guild.roleList.find((r) => r.name === "Rust");
  assert.equal(panel.payload.components[0].components[0].custom_id, `roles:t:${rust.id}`, "кнопка несе справжній id ролі");
  assert.ok(guild.byName("RUST").overwrites.some((o) => o.id === rust.id && (o.allow & P.ViewChannel)), "optIn: роль бачить групу");
  assert.ok(guild.byName("RUST").overwrites.some((o) => o.id === GUILD && (o.deny & P.ViewChannel)), "optIn: інші не бачать");
  assert.deepEqual(await remaining(guild, desired, store), []);

  const edited = desiredOf(WITH_MESSAGES, { "rules.md": "Be very nice" });
  await apply(guild, edited, store);
  assert.equal(guild.messageList.length, 2, "правка — не нове повідомлення");
  assert.equal(guild.messageList[0].id, text.id);
  assert.deepEqual(guild.messageList[0].payload.embeds, [{ description: "Be very nice" }]);
  assert.deepEqual(await remaining(guild, edited, store), []);

  guild.messageList.splice(0, 1);
  const again = await remaining(guild, edited, store);
  assert.deepEqual(again.map((op) => `${op.op} ${op.key}`), ["post rules-main"]);
});

const WITH_PERSONA = {
  archive: { key: "archive", name: "ARCHIVE" },
  personas: { sekai: { name: "Sekai" } },
  categories: [
    { key: "info", name: "INFO", channels: [
      { key: "intro", name: "intro", messages: [{ key: "welcome", file: "welcome.md", embed: { color: "#f47c9b" }, as: "sekai" }] },
      { key: "lounge", name: "lounge" },
    ] },
  ],
};

test("apply — a persona posts through its own webhook, edits in place, links become channel mentions", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  const body = "# Hello\nGo to {{#lounge}}\n---\n# Rules\nBe nice";
  const desired = desiredOf(WITH_PERSONA, { "welcome.md": body });
  await apply(guild, desired, store);

  const lounge = guild.byName("lounge");
  const [message] = guild.messageList;
  assert.ok(message.webhookId, "опубліковано вебхуком, не ботом");
  assert.equal(guild.webhookList.length, 1);
  assert.equal(guild.webhookList[0].name, "Sekai");
  assert.deepEqual(message.payload.embeds, [
    { title: "Hello", description: `Go to <#${lounge.id}>`, color: 0xf47c9b },
    { title: "Rules", description: "Be nice", color: 0xf47c9b },
  ]);
  assert.deepEqual(await remaining(guild, desired, store), []);

  const edited = desiredOf(WITH_PERSONA, { "welcome.md": body.replace("Be nice", "Be kind") });
  await apply(guild, edited, store);
  assert.equal(guild.messageList.length, 1, "правка — на місці");
  assert.equal(guild.webhookList.length, 1, "той самий вебхук, не новий");
  assert.equal(guild.messageList[0].payload.embeds[1].description, "Be kind");
  assert.ok(guild.calls.includes("webhook.edit"));

  // Автор змінився на бота — старе повідомлення чуже, тож нове.
  const asBot = structuredClone(WITH_PERSONA);
  delete asBot.categories[0].channels[0].messages[0].as;
  const ops = await remaining(guild, desiredOf(asBot, { "welcome.md": body }), store);
  assert.deepEqual(ops.map((op) => op.op), ["post"]);
  assert.match(ops[0].changes[0], /now posted as the bot/);
});

test("apply — another bot on the same server posts new copies instead of failing on edits it is not allowed", async () => {
  // Регресія: apply продакшн-ботом після тестового. Стан пам'ятав повідомлення
  // тестового бота й планував правку: панелі падали з 50005 (чужий автор),
  // тексти персони — з 10008 (вебхук персони в кожного бота свій).
  const guild = new FakeGuild();
  const store = memoryStore();
  const config = structuredClone(WITH_PERSONA);
  config.roles = [{ key: "topic", name: "Topic", permissions: [] }];
  config.categories[0].channels[0].messages.push({ key: "panel", rolePanel: { roles: ["topic"] } });
  await apply(guild, desiredOf(config, { "welcome.md": "Hello" }), store);
  assert.equal(guild.messageList.length, 2);

  guild.botId = "production-bot";
  const changed = desiredOf(structuredClone(config), { "welcome.md": "Hello again" });
  changed.messages.find((m) => m.key === "panel").panel.text = "Pick a topic";
  const log = await apply(guild, changed, store);

  const reposted = log.filter((entry) => entry.ok && entry.text.includes("posted anew"));
  assert.equal(reposted.length, 2, "both the persona text and the panel are posted again");
  assert.ok(log.every((entry) => entry.ok), "nothing failed");
  assert.equal(guild.messageList.length, 4, "the old copies stay — they are deleted by hand");
  assert.deepEqual(await remaining(guild, changed, store), [], "the new copies are the managed ones now");
});

// ── AutoMod ────────────────────────────────────────────────────────────────

const WITH_AUTOMOD = {
  archive: { key: "archive", name: "ARCHIVE" },
  roles: [{ key: "mod", name: "Mod" }],
  channels: [{ key: "mod-log", name: "mod-log" }],
  automod: [
    { key: "scam", name: "Scam", type: "keyword", keywords: ["*free nitro*"],
      actions: [{ type: "block" }, { type: "alert", channel: "mod-log" }], exempt: { roles: ["mod"] } },
    { key: "mentions", name: "Mentions", type: "mention-spam", limit: 5, actions: [{ type: "block" }] },
  ],
};

test("apply — AutoMod rules are created with real ids and a second plan is empty", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  const desired = desiredOf(WITH_AUTOMOD);
  await apply(guild, desired, store);

  const scam = guild.automodList.find((r) => r.name === "Scam");
  assert.equal(scam.actions.find((a) => a.metadata.channelId).metadata.channelId, guild.byName("mod-log").id);
  assert.deepEqual(scam.exemptRoles, [guild.roleList.find((r) => r.name === "Mod").id]);
  assert.deepEqual(await remaining(guild, desired, store), []);
});

test("apply — a rule Discord will not let the bot edit fails clearly and is not taken over", async () => {
  const guild = new FakeGuild();
  guild.automodList.push({ id: "sys", ...guild.toRule({ name: "Block Mention Spam", enabled: true, triggerType: Trigger.MentionSpam,
    triggerMetadata: { mentionTotalLimit: 20 }, actions: [{ type: 1 }] }) });
  guild.lockedRules.add("sys");
  const store = memoryStore();

  const log = await applyProvision({ guild, desired: desiredOf(WITH_AUTOMOD), store, read: async (g) => g.snapshot() });
  const failure = log.find((entry) => !entry.ok);
  assert.match(failure.text, /does not let the bot edit "Block Mention Spam"/);
  assert.ok(!store.rows.some((r) => r.kind === "automod" && r.discord_id === "sys"), "невдале прийняття не записане в стан");
  assert.ok(guild.automodList.some((r) => r.name === "Scam"), "решта правил створена");
});

test("apply — phases that change nothing do not re-read the server", async () => {
  const guild = new FakeGuild();
  const store = memoryStore();
  const desired = desiredOf(CONFIG);
  await apply(guild, desired, store);

  let reads = 0;
  await applyProvision({ guild, desired, store, read: async (g) => { reads += 1; return g.snapshot(); } });
  assert.equal(reads, 1, "сервер уже як у конфігу — одне читання на весь apply");
});

// ── archiveUnmanaged ───────────────────────────────────────────────────────

function manualChannel(guild, id, name, kind, parentId = null) {
  guild.channelList.push({ id, name, kind, parentId, position: guild.channelList.length, topic: null, nsfw: false, slowmode: 0,
    overwrites: [{ id: "member-1", type: "member", allow: P.ViewChannel, deny: 0n }] });
}

test("apply — archiveUnmanaged moves hand-made channels to the archive and hides empty hand-made categories", async () => {
  const guild = new FakeGuild({ community: true });
  manualChannel(guild, "k-old", "Old stuff", "category");
  manualChannel(guild, "c-random", "random", "text", "k-old");
  manualChannel(guild, "k-sys", "Server", "category");
  manualChannel(guild, "c-rules", "rules", "text", "k-sys");
  manualChannel(guild, "c-top", "chit-chat", "text");
  manualChannel(guild, "c-kept", "general", "text");
  guild.specialChannelIds = ["c-rules"];
  const store = memoryStore();
  const desired = desiredOf({
    archive: { key: "archive", name: "ARCHIVE" },
    archiveUnmanaged: true,
    channels: [{ key: "general", name: "general" }],
  });

  const plan = planProvision(desired, guild.snapshot(), []);
  assert.deepEqual(plan.ops.filter((op) => op.unmanaged).map((op) => `${op.op} ${op.name}`).sort(),
    ["archive chit-chat", "archive random", "hide Old stuff", "keep rules"]);

  await apply(guild, desired, store);
  const archive = guild.byName("ARCHIVE");
  for (const name of ["random", "chit-chat"]) {
    assert.equal(guild.byName(name).parentId, archive.id, `${name} в архіві`);
    assert.deepEqual(guild.byName(name).overwrites, archive.overwrites, `${name} з правами архіву — ручний доступ учасника знято`);
  }
  assert.deepEqual(guild.byName("Old stuff").overwrites, archive.overwrites, "порожня рукотворна категорія прихована, не видалена");
  assert.equal(guild.byName("rules").parentId, "k-sys", "системний канал на місці");
  assert.notDeepEqual(guild.byName("Server").overwrites, archive.overwrites, "категорія з системним каналом лишається видимою");
  assert.equal(guild.byName("general").id, "c-kept", "канал з конфігу прийнято, не заархівовано");
  assert.ok(!store.rows.some((r) => r.key.startsWith("unmanaged:")), "рукотворне в стан не пишеться");

  assert.deepEqual(await remaining(guild, desired, store), [], "другий план порожній");

  const after = planProvision(desired, guild.snapshot(), await store.forGuild(GUILD));
  assert.deepEqual(after.unmanaged.archived.map((c) => c.name).sort(), ["chit-chat", "random"], "заархівоване — окремою групою");
  assert.deepEqual(after.unmanaged.hidden, ["Old stuff"]);
  assert.deepEqual(after.unmanaged.categories, ["Server"], "у «як лежало» — лише те, що справді не чіпали");
  assert.deepEqual(after.unmanaged.channels, []);
  const text = formatPlan(after, { configName: "t.json" });
  assert.match(text, /🗄 in the archive: #(chit-chat|random), #(chit-chat|random)/);
  assert.match(text, /🙈 hidden like the archive: 📁 Old stuff/);
  assert.match(text, /\? categories, left as they are: Server/);
});

test("archiveUnmanaged — off by default: hand-made channels are only reported", () => {
  const guild = new FakeGuild();
  manualChannel(guild, "c-top", "chit-chat", "text");
  const plan = planProvision(desiredOf({ archive: { key: "archive", name: "ARCHIVE" } }), guild.snapshot(), []);
  assert.ok(!plan.ops.some((op) => op.unmanaged));
  assert.deepEqual(plan.unmanaged.channels, ["chit-chat"]);
});

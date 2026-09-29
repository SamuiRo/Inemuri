import test from "node:test";
import assert from "node:assert/strict";
import { OverwriteType, PermissionFlagsBits as P } from "discord.js";

import { validateServerConfig } from "../src/module/discordapp/features/provision/schema.js";
import { actionableOps, planProvision } from "../src/module/discordapp/features/provision/planner.js";
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
    this.calls = [];

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
    remember: async (guildId, kind, key, discordId) => {
      const row = find(guildId, kind, key) ?? rows[rows.push({ guild_id: guildId, kind, key }) - 1];
      Object.assign(row, { discord_id: discordId, archived_at: null, archived_from: null });
    },
    markArchived: async (guildId, key, fromKey) => {
      Object.assign(find(guildId, "channel", key), { archived_at: new Date(), archived_from: fromKey ?? null });
    },
    forget: async (guildId, kind, key) => {
      rows.splice(rows.indexOf(find(guildId, kind, key)), 1);
    },
  };
}

function desiredOf(raw) {
  const { errors, desired } = validateServerConfig({ guildId: GUILD, ...raw });
  assert.deepEqual(errors, []);
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

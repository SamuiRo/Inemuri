import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { PermissionFlagsBits as P } from "discord.js";

import { normalizeChannelName, validateServerConfig } from "../src/module/discordapp/features/provision/schema.js";
import {
  actionableOps,
  applyBlockers,
  channelOrderPositions,
  planFingerprint,
  planProvision,
  roleOrderPositions,
} from "../src/module/discordapp/features/provision/planner.js";
import { finalOverwrites, managedTargetIds, resolveOverwrites } from "../src/module/discordapp/features/provision/overwrites.js";
import { formatPlan } from "../src/module/discordapp/features/provision/formatPlan.js";
import { resolveServerConfig } from "../src/module/discordapp/features/provision/configStore.js";
import { textReply } from "../src/module/discordapp/reply.js";
import { DISCORD_SERVERS_DIR } from "../src/config/app.config.js";

const GUILD = "111111111111111111";
const BOT_ROLE = "900";

/** Мінімальний валідний конфіг; доповнюється в тестах. */
function config(extra = {}) {
  return {
    guildId: GUILD,
    archive: { key: "archive", name: "ARCHIVE", roles: ["admin"] },
    roles: [{ key: "admin", name: "Admin" }],
    ...extra,
  };
}

function desiredOf(raw) {
  const { errors, desired } = validateServerConfig(raw);
  assert.deepEqual(errors, []);
  return desired;
}

/** Порожній сервер: лише роль бота. */
function server({ roles = [], channels = [], community = false, admin = true } = {}) {
  return {
    guildId: GUILD,
    name: "Test",
    community,
    everyoneId: GUILD,
    bot: { userId: "800", roleId: BOT_ROLE, highestPosition: 50, admin },
    roles: [{ id: BOT_ROLE, name: "Inemuri", color: 0, hoist: false, mentionable: false, permissions: 0n, position: 50, managed: true }, ...roles],
    channels,
  };
}

function role(id, name, position, extra = {}) {
  return { id, name, color: 0, hoist: false, mentionable: false, permissions: 0n, position, managed: false, ...extra };
}

function channel(id, name, kind = "text", extra = {}) {
  return { id, name, kind, parentId: null, position: 0, topic: null, nsfw: false, slowmode: 0, overwrites: [], ...extra };
}

/** Архівна категорія, вже налаштована як треба (роль admin = "1"). */
function archiveCategory(id = "a1") {
  return channel(id, "ARCHIVE", "category", {
    overwrites: [
      { id: GUILD, type: "role", allow: 0n, deny: P.ViewChannel },
      { id: "1", type: "role", allow: P.ViewChannel | P.ReadMessageHistory, deny: 0n },
      { id: BOT_ROLE, type: "role", allow: P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.EmbedLinks | P.AttachFiles, deny: 0n },
    ],
  });
}

const opsOf = (plan) => plan.ops.map((op) => `${op.op} ${op.kind} ${op.key}`);

// ── schema ─────────────────────────────────────────────────────────────────

test("schema — the sample config validates", () => {
  const sample = JSON.parse(fs.readFileSync(path.join(DISCORD_SERVERS_DIR, "example.sample.json"), "utf8"));
  sample.guildId = GUILD;
  assert.deepEqual(validateServerConfig(sample).errors, []);
});

test("schema — archive is mandatory", () => {
  const { errors } = validateServerConfig({ guildId: GUILD });
  assert.ok(errors.some((e) => e.startsWith("archive:")));
});

test("schema — typos are loud: unknown fields, permissions, presets, role refs", () => {
  const { errors } = validateServerConfig(config({
    roles: [{ key: "admin", name: "Admin", colour: "#fff", permissions: ["ViewChanel"] }],
    categories: [{
      key: "info", name: "INFO", overwrites: "nope",
      channels: [{ key: "a", name: "a", overwrites: { "role:ghost": { allow: ["ViewChannel"] } } }],
    }],
  }));
  assert.ok(errors.some((e) => e.includes("roles[0].colour: unknown field")));
  assert.ok(errors.some((e) => e.includes("unknown permission(s): ViewChanel")));
  assert.ok(errors.some((e) => e.includes('unknown preset "nope"')));
  assert.ok(errors.some((e) => e.includes('"role:ghost" refers to a role that is not in "roles"')));
});

test("schema — duplicate keys, bad key format, allow∩deny", () => {
  const { errors } = validateServerConfig(config({
    categories: [
      { key: "Info", name: "INFO", channels: [] },
      { key: "dup", name: "A", channels: [{ key: "dup", name: "x", overwrites: { "@everyone": { allow: ["ViewChannel"], deny: ["ViewChannel"] } } }] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes("categories[0].key")));
  assert.ok(errors.some((e) => e.includes('duplicate key "dup"')));
  assert.ok(errors.some((e) => e.includes("both allowed and denied")));
});

test("schema — channel inherits category overwrites, own ones win per target, bot added when private", () => {
  const desired = desiredOf(config({
    roles: [{ key: "admin", name: "Admin" }, { key: "mod", name: "Mod" }],
    presets: { staff: { "@everyone": { deny: ["ViewChannel"] }, "role:mod": { allow: ["ViewChannel"] } } },
    categories: [{
      key: "staff", name: "STAFF", overwrites: "staff",
      channels: [
        { key: "chat", name: "Staff Chat" },
        { key: "log", name: "log", overwrites: { "role:mod": { allow: ["ViewChannel"], deny: ["SendMessages"] } } },
      ],
    }],
  }));
  const [chat, log] = desired.channels;
  assert.equal(chat.name, "staff-chat", "текстові канали Discord зберігає в нижньому регістрі з дефісами");
  assert.deepEqual(chat.overwrites.map((o) => o.target), ["@everyone", "role:mod", "@bot"]);
  assert.equal(log.overwrites.find((o) => o.target === "role:mod").deny, P.SendMessages);
  assert.ok(desired.categories.at(-1).isArchive, "архів — остання категорія");
  assert.deepEqual(desired.categories.at(-1).overwrites.map((o) => o.target), ["@everyone", "role:admin", "@bot"]);
});

test("schema — fields that are not set are not managed", () => {
  const desired = desiredOf(config({ channels: [{ key: "a", name: "a" }] }));
  assert.equal(desired.roles[0].permissions, null);
  assert.equal(desired.roles[0].color, undefined);
  assert.equal(desired.channels[0].overwrites, null);
  assert.equal(desired.channels[0].topic, undefined);
});

test("normalizeChannelName — only text-like names are lowercased", () => {
  assert.equal(normalizeChannelName("Hello World", "text"), "hello-world");
  assert.equal(normalizeChannelName("Hello World", "voice"), "Hello World");
});

// ── planner ────────────────────────────────────────────────────────────────

test("planner — empty server: everything is created, then ordered", () => {
  const desired = desiredOf(config({ categories: [{ key: "info", name: "INFO", channels: [{ key: "rules", name: "rules" }] }] }));
  const plan = planProvision(desired, server(), []);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(opsOf(plan), [
    "create role admin",
    "create category info",
    "create category archive",
    "create channel rules",
    "reorder role roles",
    "reorder channel channels",
  ]);
});

test("planner — existing resources are adopted by name, then only real differences are updates", () => {
  const desired = desiredOf(config({
    roles: [{ key: "admin", name: "Admin", color: "#ff0000" }],
    channels: [{ key: "general", name: "general", topic: "Hi" }],
  }));
  const current = server({
    roles: [role("1", "Admin", 10)],
    channels: [channel("c1", "general", "text", { topic: "Hi" }), channel("a1", "ARCHIVE", "category")],
  });
  const plan = planProvision(desired, current, []);
  const admin = plan.ops.find((op) => op.key === "admin");
  assert.equal(admin.op, "adopt");
  assert.deepEqual(admin.changes, ["color #000000 → #ff0000"]);
  assert.equal(plan.ops.find((op) => op.key === "general").op, "adopt");
  assert.deepEqual(plan.ops.find((op) => op.key === "general").changes, []);
});

test("planner — with state, a rename in the config is an update, not a new channel", () => {
  const desired = desiredOf(config({ channels: [{ key: "general", name: "lobby" }] }));
  const current = server({ roles: [role("1", "Admin", 10)], channels: [channel("c1", "general"), archiveCategory()] });
  const state = [
    { kind: "role", key: "admin", discord_id: "1" },
    { kind: "category", key: "archive", discord_id: "a1" },
    { kind: "channel", key: "general", discord_id: "c1" },
  ];
  const plan = planProvision(desired, current, state);
  assert.deepEqual(actionableOps(plan).map((op) => `${op.op} ${op.key}`), ["update general"]);
  assert.deepEqual(plan.ops[0].changes, ['name "general" → "lobby"']);
});

test("planner — a managed channel removed from the config is archived, never deleted", () => {
  const desired = desiredOf(config());
  const current = server({
    roles: [role("1", "Admin", 10)],
    channels: [channel("k1", "CHAT", "category"), channel("c1", "old", "text", { parentId: "k1" }), channel("a1", "ARCHIVE", "category")],
  });
  const state = [
    { kind: "role", key: "admin", discord_id: "1" },
    { kind: "category", key: "archive", discord_id: "a1" },
    { kind: "category", key: "chat", discord_id: "k1" },
    { kind: "channel", key: "old", discord_id: "c1" },
  ];
  const plan = planProvision(desired, current, state);
  const archive = plan.ops.find((op) => op.op === "archive");
  assert.equal(archive.key, "old");
  assert.equal(archive.parentKey, "chat");
  assert.ok(plan.ops.some((op) => op.op === "orphaned" && op.key === "chat"), "категорія лишається як є");
  assert.ok(!plan.ops.some((op) => op.op === "delete"));
});

test("planner — an archived channel back in the config is restored", () => {
  const desired = desiredOf(config({ channels: [{ key: "old", name: "old" }] }));
  const current = server({
    roles: [role("1", "Admin", 10)],
    channels: [channel("a1", "ARCHIVE", "category"), channel("c1", "old", "text", { parentId: "a1" })],
  });
  const state = [
    { kind: "role", key: "admin", discord_id: "1" },
    { kind: "category", key: "archive", discord_id: "a1" },
    { kind: "channel", key: "old", discord_id: "c1", archived_at: new Date() },
  ];
  const plan = planProvision(desired, current, state);
  const restore = plan.ops.find((op) => op.key === "old");
  assert.equal(restore.op, "restore");
  assert.ok(restore.changes.includes('category "ARCHIVE" → none'));
});

test("planner — a channel deleted on Discord is forgotten from state", () => {
  const plan = planProvision(desiredOf(config()), server({ roles: [role("1", "Admin", 10)] }), [
    { kind: "role", key: "admin", discord_id: "1" },
    { kind: "channel", key: "gone", discord_id: "zzz" },
  ]);
  assert.ok(plan.ops.some((op) => op.op === "forget" && op.key === "gone"));
});

test("planner — unmanaged overwrites are preserved; managed extras are removed", () => {
  const desired = desiredOf(config({
    channels: [{ key: "a", name: "a", overwrites: { "@everyone": { deny: ["SendMessages"] } } }],
  }));
  const current = server({
    roles: [role("1", "Admin", 10), role("2", "Outsider", 5)],
    channels: [channel("c1", "a", "text", {
      overwrites: [
        { id: GUILD, type: "role", allow: 0n, deny: P.SendMessages },
        { id: "1", type: "role", allow: P.ViewChannel, deny: 0n },
        { id: "2", type: "role", allow: P.ViewChannel, deny: 0n },
        { id: "777", type: "member", allow: P.ViewChannel, deny: 0n },
      ],
    })],
  });
  const plan = planProvision(desired, current, []);
  const op = plan.ops.find((o) => o.key === "a");
  assert.deepEqual(op.changes, ["permissions @Admin: removed"], "Admin керується конфігом, Outsider і учасник — ні");

  const resolved = resolveOverwrites(desired.channels[0].overwrites, plan.context).resolved;
  const final = finalOverwrites(resolved, current.channels[0].overwrites, managedTargetIds(plan.context));
  assert.deepEqual(final.map((o) => o.id).sort(), [GUILD, "2", "777"].sort());
});

test("planner — errors: role above the bot, ambiguous names, Community-only channel, wrong server", () => {
  const desired = desiredOf(config({
    roles: [{ key: "admin", name: "Admin" }, { key: "vip", name: "VIP" }],
    channels: [{ key: "news", name: "news", type: "announcement" }, { key: "dup", name: "dup" }],
  }));
  const current = server({
    roles: [role("1", "Admin", 60), role("2", "VIP", 5), role("3", "VIP", 6)],
    channels: [channel("c1", "dup"), channel("c2", "dup")],
  });
  const plan = planProvision(desired, current, []);
  assert.ok(plan.errors.some((e) => e.includes('Role "Admin" is at or above')));
  assert.ok(plan.errors.some((e) => e.includes('2 roles are named "VIP"')));
  assert.ok(plan.errors.some((e) => e.includes("needs a Community server")));
  assert.ok(plan.errors.some((e) => e.includes("2 channels are named #dup")));

  const other = planProvision({ ...desired, guildId: "222222222222222222" }, current, []);
  assert.ok(other.errors[0].includes("not this one"));
});

test("planner — requires: community is skipped on a plain server, kept on a Community one", () => {
  const desired = desiredOf(config({ channels: [{ key: "news", name: "news", type: "announcement", requires: "community" }] }));
  assert.ok(planProvision(desired, server(), []).ops.some((op) => op.op === "skip" && op.key === "news"));
  assert.ok(planProvision(desired, server({ community: true }), []).ops.some((op) => op.op === "create" && op.key === "news"));
});

test("planner — the bot gets its own overwrite in private channels, resolved to its role", () => {
  const desired = desiredOf(config({ channels: [{ key: "s", name: "s", overwrites: { "@everyone": { deny: ["ViewChannel"] } } }] }));
  const plan = planProvision(desired, server(), []);
  const { resolved } = resolveOverwrites(desired.channels[0].overwrites, plan.context);
  assert.deepEqual(resolved.find((o) => o.label === "@bot").id, BOT_ROLE);
});

test("roleOrderPositions — config order within the roles' existing slots", () => {
  const desired = desiredOf(config({ roles: [{ key: "admin", name: "Admin" }, { key: "mod", name: "Mod" }] }));
  const current = server({ roles: [role("1", "Admin", 3), role("2", "Mod", 7), role("9", "Other", 5)] });
  const plan = planProvision(desired, current, []);
  assert.deepEqual(roleOrderPositions(desired, current, plan.context), [{ id: "1", position: 7 }, { id: "2", position: 3 }]);
});

test("channelOrderPositions — channels within a category follow the config", () => {
  const desired = desiredOf(config({ channels: [{ key: "a", name: "a" }, { key: "b", name: "b" }] }));
  const current = server({ roles: [role("1", "Admin", 10)], channels: [channel("cb", "b", "text", { position: 1 }), channel("ca", "a", "text", { position: 4 })] });
  const plan = planProvision(desired, current, []);
  assert.deepEqual(channelOrderPositions(desired, current, plan.context), [{ id: "ca", position: 1 }, { id: "cb", position: 4 }]);
});

test("planFingerprint — changes with the plan, ignores report-only ops", () => {
  const desired = desiredOf(config());
  const a = planProvision(desired, server(), []);
  const b = planProvision(desired, server({ roles: [role("1", "Admin", 10)] }), []);
  assert.notEqual(planFingerprint(a), planFingerprint(b));
  assert.equal(planFingerprint(a), planFingerprint(planProvision(desired, server(), [])));
});

test("applyBlockers — apply needs Administrator", () => {
  assert.deepEqual(applyBlockers(server()), []);
  assert.match(applyBlockers(server({ admin: false }))[0], /Administrator/);
});

// ── formatPlan / textReply ─────────────────────────────────────────────────

test("formatPlan — sections, changes, errors, blockers, summary", () => {
  const desired = desiredOf(config({ roles: [{ key: "admin", name: "Admin", color: "#ff0000" }] }));
  const current = server({ roles: [role("1", "Admin", 10)], admin: false });
  const plan = planProvision(desired, current, []);
  const text = formatPlan(plan, { configName: "main.json", blockers: applyBlockers(current) });
  assert.match(text, /\*\*Provision plan — Test\*\* \(`main\.json`\)/);
  assert.match(text, /`⇄ adopt  ` @Admin\n    · color #000000 → #ff0000/);
  assert.match(text, /`\+ create ` 📁 ARCHIVE/);
  assert.match(text, /⚠ The bot needs Administrator/);
  assert.match(text, /Σ 1 adopt, 1 create, 1 reorder\./);
});

test("formatPlan — nothing to do", () => {
  const desired = desiredOf(config());
  const current = server({ roles: [role("1", "Admin", 10)], channels: [archiveCategory()] });
  const state = [{ kind: "role", key: "admin", discord_id: "1" }, { kind: "category", key: "archive", discord_id: "a1" }];
  const plan = planProvision(desired, current, state);
  assert.match(formatPlan(plan, { configName: "x.json" }), /✅ The server already matches the config\./);
});

test("textReply — long text goes into a file", () => {
  assert.equal(textReply("short", "a.md"), "short");
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const reply = textReply(long, "plan.md");
  assert.ok(reply.content.length <= 2000);
  assert.match(reply.content, /attached as `plan\.md`/);
  assert.equal(reply.files[0].attachment.toString(), long);
});

// ── configStore ────────────────────────────────────────────────────────────

test("resolveServerConfig — by name, by guild id, and loud failures", async () => {
  const file = path.join(DISCORD_SERVERS_DIR, "zz-probe-provision-test.json");
  fs.writeFileSync(file, JSON.stringify({ guildId: "333333333333333333" }));
  try {
    assert.equal((await resolveServerConfig("333333333333333333")).name, "zz-probe-provision-test");
    assert.equal((await resolveServerConfig("333333333333333333", "zz-probe-provision-test")).name, "zz-probe-provision-test");
    await assert.rejects(resolveServerConfig("444444444444444444", "zz-probe-provision-test"), /not this one/);
    await assert.rejects(resolveServerConfig("444444444444444444"), /No config for this server/);
    await assert.rejects(resolveServerConfig("333333333333333333", "../app.config"), /not a valid config name/);
  } finally {
    fs.unlinkSync(file);
  }
});

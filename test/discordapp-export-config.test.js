import test from "node:test";
import assert from "node:assert/strict";
import { AutoModerationActionType as Action, AutoModerationRuleTriggerType as Trigger, PermissionFlagsBits as P } from "discord.js";

import { exportConfig, keyMaker } from "../src/module/discordapp/features/provision/exporter.js";
import { validateServerConfig } from "../src/module/discordapp/features/provision/schema.js";
import { actionableOps, planProvision } from "../src/module/discordapp/features/provision/planner.js";
import { describeExport } from "../src/module/discordapp/features/provision/Provisioner.js";
import { roleFields } from "../src/module/discordapp/features/provision/applier.js";

const GUILD = "111111111111111111";
const BOT_ROLE = "r-bot";

const role = (id, name, position, extra = {}) =>
  ({ id, name, color: 0, hoist: false, mentionable: false, permissions: 0n, position, managed: false, ...extra });
const channel = (id, name, kind, extra = {}) =>
  ({ id, name, kind, parentId: null, position: 0, topic: null, nsfw: false, slowmode: 0, overwrites: [], ...extra });
const ow = (id, allow = 0n, deny = 0n, type = "role") => ({ id, type, allow, deny });

/** Сервер, яким його міг зробити хтось вручну, з усіма незручними місцями. */
function handmadeServer() {
  return {
    guildId: GUILD, name: "Handmade", community: true, everyoneId: GUILD,
    bot: { userId: "bot", roleId: BOT_ROLE, highestPosition: 50, admin: true },
    roles: [
      role(BOT_ROLE, "Inemuri", 50, { managed: true }),
      role("r-admin", "Admin", 10, { color: 0xe74c3c, hoist: true, permissions: P.Administrator }),
      role("r-mod", "Moderator", 9, { permissions: P.ManageMessages | P.KickMembers }),
      role("r-dup", "Moderator", 8),
      role("r-boost", "Server Booster", 7, { managed: true }),
    ],
    channels: [
      channel("k-info", "📌 INFO", "category", { position: 0, overwrites: [ow(GUILD, P.ViewChannel, P.SendMessages)] }),
      channel("c-rules", "rules", "text", { parentId: "k-info", position: 0, topic: "Read me", overwrites: [ow(GUILD, P.ViewChannel, P.SendMessages)] }),
      channel("c-news", "news", "announcement", { parentId: "k-info", position: 1, overwrites: [ow(GUILD, P.ViewChannel, P.SendMessages | P.AddReactions)] }),
      channel("k-staff", "Staff", "category", { position: 1, overwrites: [ow(GUILD, 0n, P.ViewChannel), ow("r-mod", P.ViewChannel), ow(BOT_ROLE, P.ViewChannel)] }),
      channel("c-staff", "staff-chat", "text", { parentId: "k-staff", overwrites: [ow(GUILD, 0n, P.ViewChannel), ow("r-mod", P.ViewChannel), ow(BOT_ROLE, P.ViewChannel)] }),
      channel("c-log", "log", "text", { parentId: "k-staff", position: 1, slowmode: 10, overwrites: [ow("r-mod", P.ViewChannel), ow("member-7", P.ViewChannel, 0n, "member")] }),
      channel("c-voice", "Hangout", "voice", { position: 2 }),
      channel("c-media", "gallery", "media", { position: 3 }),
      channel("k-arch", "Archive", "category", { position: 9, overwrites: [ow(GUILD, 0n, P.ViewChannel), ow("r-admin", P.ViewChannel | P.ReadMessageHistory)] }),
      channel("c-old", "old", "text", { parentId: "k-arch" }),
    ],
    messages: [],
    automod: [
      { id: "a1", name: "Block Mention Spam", enabled: true, triggerType: Trigger.MentionSpam,
        triggerMetadata: { mentionTotalLimit: 20, mentionRaidProtectionEnabled: true },
        actions: [{ type: Action.BlockMessage, metadata: {} }, { type: Action.SendAlertMessage, metadata: { channelId: "c-log" } }],
        exemptRoles: ["r-mod"], exemptChannels: [] },
    ],
  };
}

test("exportConfig — the exported config validates", () => {
  const { config } = exportConfig(handmadeServer());
  assert.deepEqual(validateServerConfig(config).errors, []);
});

test("exportConfig — round trip: planning the export against the same server only adopts, changing nothing", () => {
  const current = handmadeServer();
  const { config } = exportConfig(current);
  // Дві ролі "Moderator" план не прийме навмисно (помилка, а не вгадування) —
  // тож прибираємо дубль, як зробила б людина.
  config.roles = config.roles.filter((r) => r.key !== "moderator-2");
  current.roles = current.roles.filter((r) => r.id !== "r-dup");

  const { desired } = validateServerConfig(config);
  const plan = planProvision(desired, current, []);
  assert.deepEqual(plan.errors, []);
  // Єдине, що план змінить на сервері, зробленому вручну, — overwrite самого
  // бота: провіжн дає йому стандартний набір у кожному приватному каналі
  // (schema.js withBot), а в конфіг цей overwrite не експортується.
  const notAboutBot = (change) => !change.startsWith("permissions @bot:");
  const changing = actionableOps(plan).filter((op) => op.op !== "adopt" || op.changes.some(notAboutBot));
  assert.deepEqual(changing.map((op) => `${op.op} ${op.key}: ${op.changes?.join("; ")}`), []);
});

test("exportConfig — shape: keys, synced channels, neutral overrides, archive, skipped", () => {
  const { config, skipped } = exportConfig(handmadeServer());
  assert.deepEqual(config.roles.map((r) => r.key), ["admin", "moderator", "moderator-2"]);
  assert.deepEqual(config.roles[0], { key: "admin", name: "Admin", color: "#e74c3c", hoist: true, permissions: ["Administrator"] });

  const [info, staff] = config.categories;
  assert.equal(info.key, "info", "емодзі в назві не заважає ключу");
  assert.equal(info.channels[0].overwrites, undefined, "синхронізований з категорією канал без власних overwrites");
  assert.equal(info.channels[1].type, "announcement");
  assert.deepEqual(info.channels[1].overwrites["@everyone"].deny, ["AddReactions", "SendMessages"]);

  const log = staff.channels.find((c) => c.key === "log");
  assert.deepEqual(log.overwrites["@everyone"], {}, "ціль категорії, якої канал не має, зануляється явно");
  assert.equal(log.slowmode, 10);
  assert.ok(!Object.keys(staff.overwrites).some((t) => t.includes("bot")), "overwrite бота не експортується — провіжн ставить його сам");

  assert.deepEqual(config.archive, { key: "archive", name: "Archive", roles: ["admin"] }, "наявна архівна категорія стає архівом");
  assert.ok(!config.categories.some((c) => c.name === "Archive"));
  assert.deepEqual(config.channels.map((c) => [c.key, c.type]), [["hangout", "voice"]]);

  assert.deepEqual(config.automod, [{ key: "block-mention-spam", name: "Block Mention Spam", type: "mention-spam", limit: 20, raidProtection: true,
    actions: [{ type: "block" }, { type: "alert", channel: "log" }], exempt: { roles: ["moderator"] } }]);

  for (const expected of ["Server Booster", "gallery", "a member", "#old"]) {
    assert.ok(skipped.some((s) => s.includes(expected)), `skipped should mention ${expected}:\n${skipped.join("\n")}`);
  }
  assert.match(describeExport(config, skipped, "config-x.json"), /Exported 3 roles, 2 categories, 5 channels, 1 AutoMod rules/);
});

test("keyMaker — slugs, fallbacks for names without Latin letters, suffixes for repeats", () => {
  const keys = keyMaker();
  assert.equal(keys.make("General Chat!", "channel"), "general-chat");
  assert.equal(keys.make("General chat", "channel"), "general-chat-2");
  assert.equal(keys.make("Загальне", "channel"), "channel-1");
  assert.equal(keys.make("📌", "category"), "category-1");
});

// ── Знайдене на живому сервері ─────────────────────────────────────────────

test("exportConfig — an already managed resource keeps its key from state", () => {
  const current = handmadeServer();
  // Сервер уже провіжнили з конфігу, де Moderator мав ключ "mod", а
  // голосовий Hangout — "general" (назва й ключ не зобов'язані збігатись).
  const state = [
    { kind: "role", key: "mod", discord_id: "r-mod" },
    { kind: "channel", key: "general", discord_id: "c-voice" },
  ];
  const { config } = exportConfig(current, state);
  assert.deepEqual(config.roles.map((r) => r.key), ["admin", "mod", "moderator"], "керований — зі стану, новий — з назви");
  assert.equal(config.channels[0].key, "general");

  const { desired } = validateServerConfig(config);
  current.roles = current.roles.filter((r) => r.id !== "r-dup");
  desired.roles = desired.roles.filter((r) => r.key !== "moderator");
  const plan = planProvision(desired, current, state);
  assert.ok(!plan.ops.some((op) => op.op === "create" && op.kind === "role"), "план не пропонує дублікат керованої ролі");
});

test("permission bits discord.js does not know are neither a change nor erased", () => {
  const UNKNOWN = 1n << 47n;
  const current = handmadeServer();
  current.roles = current.roles.filter((r) => r.id !== "r-dup");
  current.roles.find((r) => r.id === "r-mod").permissions |= UNKNOWN;
  const { config } = exportConfig(current);
  const { desired } = validateServerConfig(config);
  const plan = planProvision(desired, current, []);
  const mod = plan.ops.find((op) => op.key === "moderator");
  assert.deepEqual(mod.changes, [], "невідомий біт не робить роль «зміненою»");

  const spec = desired.roles.find((r) => r.key === "moderator");
  assert.equal(roleFields(spec, { permissions: P.ManageMessages | UNKNOWN }).permissions & UNKNOWN, UNKNOWN, "при записі невідомий біт зберігається");
  assert.equal(roleFields(spec).permissions & UNKNOWN, 0n);
});

test("exportConfig — real ids become adopt, so renaming the export renames the server, not twins", () => {
  const K = "20000000000000001", C = "20000000000000002", R = "20000000000000003", A = "20000000000000004";
  const current = {
    guildId: GUILD, name: "Real", community: false, everyoneId: GUILD,
    bot: { userId: "bot", roleId: BOT_ROLE, highestPosition: 50, admin: true },
    roles: [role(BOT_ROLE, "Inemuri", 50, { managed: true }), role(R, "Member", 5)],
    channels: [channel(K, "DECOR", "category"), channel(C, "general", "text", { parentId: K }), channel(A, "Archive", "category")],
    messages: [], automod: [], specialChannelIds: [],
  };
  const { config } = exportConfig(current);
  assert.equal(config.roles[0].adopt, R);
  assert.equal(config.categories[0].adopt, K);
  assert.equal(config.categories[0].channels[0].adopt, C);
  assert.equal(config.archive.adopt, A);

  config.categories[0].name = "LOBBY";
  config.categories[0].channels[0].name = "lounge";
  config.roles[0].name = "Guest";
  const { errors, desired } = validateServerConfig(config);
  assert.deepEqual(errors, []);
  const plan = planProvision(desired, current, []);
  assert.deepEqual(plan.errors, []);
  assert.ok(!actionableOps(plan).some((op) => op.op === "create" || op.op === "archive"), "лише перейменування");
  assert.ok(plan.ops.find((op) => op.id === C).changes.includes('name "general" → "lounge"'));
});

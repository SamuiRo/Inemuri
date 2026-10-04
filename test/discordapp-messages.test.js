import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits as P } from "discord.js";

import { validateServerConfig } from "../src/module/discordapp/features/provision/schema.js";
import { planProvision } from "../src/module/discordapp/features/provision/planner.js";
import { bodyProblem, hashPayload, renderMessage } from "../src/module/discordapp/features/provision/messages.js";
import {
  computeRoleChange,
  describeRoleChange,
  panelButtonId,
  panelRoleIds,
  parsePanelButton,
  selfAssignRefusal,
} from "../src/module/discordapp/features/roles/rolePanel.js";

const GUILD = "111111111111111111";

function validate(extra) {
  return validateServerConfig({ guildId: GUILD, archive: { key: "archive", name: "ARCHIVE" }, ...extra });
}

function desiredOf(extra) {
  const { errors, desired } = validate(extra);
  assert.deepEqual(errors, []);
  for (const message of desired.messages) if (message.kind === "text") message.body = `body of ${message.file}`;
  return desired;
}

const ROLES = [{ key: "rust", name: "Rust", permissions: [] }, { key: "web", name: "Web" }];

// ── schema ─────────────────────────────────────────────────────────────────

test("schema — text and panel messages are parsed in channel order", () => {
  const desired = desiredOf({
    roles: ROLES,
    channels: [{
      key: "info", name: "info",
      messages: [
        { key: "rules", file: "rules.md", embed: { title: "Rules", color: "#ff0000" } },
        { key: "topics", rolePanel: { mode: "exclusive", roles: ["rust", { role: "web", label: "Web dev", emoji: "🌐" }] } },
      ],
    }],
  });
  assert.deepEqual(desired.messages.map((m) => [m.key, m.kind, m.channelKey]), [["rules", "text", "info"], ["topics", "rolePanel", "info"]]);
  assert.deepEqual(desired.messages[0].embed, { title: "Rules", color: 0xff0000 });
  assert.deepEqual(desired.messages[1].panel.roles, [{ key: "rust" }, { key: "web", label: "Web dev", emoji: "🌐" }]);
});

test("schema — message mistakes are loud", () => {
  const { errors } = validate({
    roles: [...ROLES, { key: "boss", name: "Boss", permissions: ["BanMembers"] }],
    channels: [
      { key: "a", name: "a", messages: [
        { key: "both", file: "x.md", rolePanel: { roles: ["rust"] } },
        { key: "path", file: "../secrets.md" },
        { key: "bad-panel", rolePanel: { mode: "random", roles: ["ghost", "boss", { role: "rust", emoji: "abc" }] } },
      ] },
      { key: "v", name: "Voice", type: "voice", messages: [{ key: "vm", file: "v.md" }] },
    ],
  });
  assert.ok(errors.some((e) => e.includes('exactly one of "file"')));
  assert.ok(errors.some((e) => e.includes("messages[1].file")));
  assert.ok(errors.some((e) => e.includes("rolePanel.mode")));
  assert.ok(errors.some((e) => e.includes('unknown role key "ghost"')));
  assert.ok(errors.some((e) => e.includes('role "boss" carries BanMembers')), "D10: роль з небезпечними дозволами не йде в панель");
  assert.ok(errors.some((e) => e.includes("emoji")));
  assert.ok(errors.some((e) => e.includes("messages can be posted only in")));
});

test("schema — optIn hides the category behind the role and adds the role to the panel", () => {
  const desired = desiredOf({
    roles: ROLES,
    categories: [
      { key: "info", name: "INFO", channels: [{ key: "get-roles", name: "get-roles", messages: [{ key: "topics", rolePanel: { roles: [] } }] }] },
      { key: "rust", name: "RUST", overwrites: { "@everyone": { allow: ["ViewChannel", "SendMessages"] } },
        optIn: { role: "rust", panel: "topics" }, channels: [{ key: "rust-chat", name: "rust-chat" }] },
    ],
  });
  const category = desired.categories.find((c) => c.key === "rust");
  const everyone = category.overwrites.find((o) => o.target === "@everyone");
  assert.equal(everyone.deny, P.ViewChannel, "@everyone не бачить");
  assert.equal(everyone.allow, P.SendMessages, "інші біти @everyone збережені");
  assert.equal(category.overwrites.find((o) => o.target === "role:rust").allow, P.ViewChannel);
  assert.ok(category.overwrites.some((o) => o.target === "@bot"), "бот бачить групу");
  assert.deepEqual(desired.channels.find((c) => c.key === "rust-chat").overwrites, category.overwrites, "канали групи успадковують");
  assert.deepEqual(desired.messages[0].panel.roles, [{ key: "rust" }]);

  const { errors } = validate({ roles: ROLES, categories: [{ key: "x", name: "X", optIn: { role: "rust", panel: "nope" }, channels: [] }] });
  assert.ok(errors.some((e) => e.includes('no rolePanel message with key "nope"')));
});

// ── messages.js ────────────────────────────────────────────────────────────

test("renderMessage — text, embed, and a panel split into rows of five", () => {
  const context = { roleIds: new Map(), roleNames: new Map() };
  assert.deepEqual(renderMessage({ kind: "text", body: "hi", embed: null }, context).payload, { content: "hi", embeds: [], components: [] });
  assert.deepEqual(renderMessage({ kind: "text", body: "hi", embed: { title: "T" } }, context).payload,
    { content: "", embeds: [{ description: "hi", title: "T" }], components: [] });

  const keys = ["a", "b", "c", "d", "e", "f"];
  const panelContext = { roleIds: new Map(keys.map((k) => [k, `id-${k}`])), roleNames: new Map(keys.map((k) => [k, k.toUpperCase()])) };
  const { payload, pending } = renderMessage({ kind: "rolePanel", panel: { mode: "toggle", roles: [...keys.map((key) => ({ key })), { key: "new" }] } }, panelContext);
  assert.deepEqual(pending, ["new"]);
  assert.deepEqual(payload.components.map((row) => row.components.length), [5, 1]);
  assert.equal(payload.components[0].components[0].custom_id, "roles:t:id-a");
  assert.equal(payload.components[0].components[0].label, "A");
  assert.equal(payload.content, "Choose your roles:");
});

test("role panel as an embed — text in the embed (title from `# `), buttons below, content empty", () => {
  const desired = desiredOf({
    roles: ROLES,
    channels: [{ key: "info", name: "info", messages: [
      { key: "topics", embed: { color: "#f47c9b" }, rolePanel: { text: `# Topics\n${"x".repeat(2500)}`, roles: ["rust"] } },
    ] }],
  });
  const panel = desired.messages[0];
  assert.deepEqual(panel.panel.embed, { color: 0xf47c9b });
  const context = { roleIds: new Map([["rust", "id-rust"]]), roleNames: new Map([["rust", "Rust"]]) };
  const { payload } = renderMessage(panel, context);
  assert.equal(payload.content, "");
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, "Topics");
  assert.equal(payload.embeds[0].description.length, 2500, "an embed panel holds more than 2000 characters");
  assert.equal(payload.embeds[0].color, 0xf47c9b);
  assert.equal(payload.components[0].components[0].custom_id, "roles:t:id-rust");

  // Без embed — як і раніше, ліміт content 2000; `as` для панелі — помилка.
  const { errors } = validate({ roles: ROLES, channels: [{ key: "info", name: "info", messages: [
    { key: "long", rolePanel: { text: "x".repeat(2500), roles: ["rust"] } },
    { key: "persona", as: "guide", rolePanel: { roles: ["rust"] } },
  ] }] });
  assert.ok(errors.some((e) => e.includes("up to 2000 characters")));
  assert.ok(errors.some((e) => e.includes("a role panel is posted by the bot")));
});

test("hashPayload — stable for equal payloads, different when text changes", () => {
  const a = { content: "x", embeds: [], components: [] };
  assert.equal(hashPayload(a), hashPayload({ ...a }));
  assert.notEqual(hashPayload(a), hashPayload({ ...a, content: "y" }));
});

test("bodyProblem — empty and over-limit texts", () => {
  assert.match(bodyProblem({ file: "a.md", body: "  ", embed: null }), /empty/);
  assert.match(bodyProblem({ file: "a.md", body: "x".repeat(2001), embed: null }), /"embed": true/);
  assert.equal(bodyProblem({ file: "a.md", body: "x".repeat(2001), embed: {} }), null);
});

// ── planner ────────────────────────────────────────────────────────────────

function server({ roles = [], channels = [], messages = [] } = {}) {
  return {
    guildId: GUILD, name: "T", community: false, everyoneId: GUILD,
    bot: { userId: "bot", roleId: "r-bot", highestPosition: 50, admin: true },
    roles: [{ id: "r-bot", name: "Inemuri", color: 0, hoist: false, mentionable: false, permissions: 0n, position: 50, managed: true }, ...roles],
    channels, messages,
  };
}
const channel = (id, name) => ({ id, name, kind: "text", parentId: null, position: 0, topic: null, nsfw: false, slowmode: 0, overwrites: [] });
const role = (id, name, permissions = 0n) => ({ id, name, color: 0, hoist: false, mentionable: false, permissions, position: 5, managed: false });

test("planner — post, edit on text change, repost when deleted, orphan when removed", () => {
  const desired = desiredOf({ channels: [{ key: "info", name: "info", messages: [{ key: "rules", file: "rules.md" }] }] });
  const current = server({ channels: [channel("c1", "info")], messages: [{ id: "m1", channelId: "c1" }] });
  const base = [{ kind: "channel", key: "info", discord_id: "c1" }];
  const msgOp = (plan) => plan.ops.find((op) => op.kind === "message");

  assert.equal(msgOp(planProvision(desired, current, base)).op, "post");

  const hash = hashPayload(renderMessage(desired.messages[0], { roleIds: new Map(), roleNames: new Map() }).payload);
  const saved = { kind: "message", key: "rules", discord_id: "m1", parent_id: "c1", content_hash: hash };
  assert.equal(msgOp(planProvision(desired, current, [...base, saved])), undefined, "той самий текст — нічого робити");

  const edit = msgOp(planProvision(desired, current, [...base, { ...saved, content_hash: "old" }]));
  assert.equal(edit.op, "edit");
  assert.equal(edit.id, "m1");

  const repost = msgOp(planProvision(desired, server({ channels: [channel("c1", "info")] }), [...base, saved]));
  assert.equal(repost.op, "post");
  assert.match(repost.changes[0], /deleted/);

  const without = desiredOf({ channels: [{ key: "info", name: "info" }] });
  const orphan = msgOp(planProvision(without, current, [...base, saved]));
  assert.equal(orphan.op, "orphaned", "прибране з конфігу повідомлення не видаляється");
});

test("planner — a panel role that gained dangerous permissions on the server is an error", () => {
  const desired = desiredOf({
    roles: [{ key: "web", name: "Web" }],
    channels: [{ key: "info", name: "info", messages: [{ key: "topics", rolePanel: { roles: ["web"] } }] }],
  });
  const plan = planProvision(desired, server({ roles: [role("r1", "Web", P.KickMembers)] }), []);
  assert.ok(plan.errors.some((e) => e.includes("@Web is on a role panel but carries KickMembers")));
});

// ── rolePanel.js ───────────────────────────────────────────────────────────

test("panel buttons — ids round-trip, group read from the message", () => {
  assert.deepEqual(parsePanelButton(panelButtonId("exclusive", "42")), { mode: "exclusive", roleId: "42" });
  assert.equal(parsePanelButton("provision:apply:x:y"), null);
  const rows = [
    { components: [{ customId: "roles:x:1" }, { customId: "roles:x:2" }] },
    { components: [{ custom_id: "roles:x:3" }, { customId: "other:thing" }] },
  ];
  assert.deepEqual(panelRoleIds(rows), ["1", "2", "3"]);
});

test("computeRoleChange — toggle and exclusive", () => {
  const siblingIds = ["a", "b", "c"];
  assert.deepEqual(computeRoleChange({ mode: "toggle", roleId: "a", memberRoleIds: new Set(["b"]), siblingIds }), { add: ["a"], remove: [] });
  assert.deepEqual(computeRoleChange({ mode: "toggle", roleId: "a", memberRoleIds: new Set(["a"]), siblingIds }), { add: [], remove: ["a"] });
  assert.deepEqual(computeRoleChange({ mode: "exclusive", roleId: "a", memberRoleIds: new Set(["b", "c", "z"]), siblingIds }), { add: ["a"], remove: ["b", "c"] });
  assert.deepEqual(computeRoleChange({ mode: "exclusive", roleId: "a", memberRoleIds: new Set(["a"]), siblingIds }), { add: [], remove: ["a"] });
});

test("selfAssignRefusal — missing, managed, above the bot, dangerous; fine otherwise", () => {
  const ok = { name: "Rust", managed: false, position: 5, permissions: P.SendMessages };
  assert.equal(selfAssignRefusal(ok, 10), null);
  assert.match(selfAssignRefusal(null, 10), /no longer exists/);
  assert.match(selfAssignRefusal({ ...ok, managed: true }, 10), /integration/);
  assert.match(selfAssignRefusal({ ...ok, position: 10 }, 10), /above the bot/);
  assert.match(selfAssignRefusal({ ...ok, permissions: P.Administrator }, 10), /Administrator/);
});

test("describeRoleChange", () => {
  assert.equal(describeRoleChange({ add: ["1"], remove: ["2", "3"] }), "✅ Added <@&1>\n➖ Removed <@&2>, <@&3>");
  assert.equal(describeRoleChange({ add: [], remove: [] }), "Nothing changed.");
});

test("role panel button — exclusive switch adds the new role and removes the old one, each by its own call", async () => {
  const { default: rolePanel } = await import("../src/module/discordapp/components/role-panel.js");
  const OLD = "201", NEW = "202";
  const held = new Set([OLD]);
  const calls = [];
  const role = (id) => ({ id, name: `R${id}`, managed: false, position: 1, permissions: { bitfield: 0n } });
  const guild = {
    roles: { fetch: async (id) => role(id), cache: new Map([[OLD, role(OLD)], [NEW, role(NEW)]]) },
    members: {
      fetchMe: async () => ({ roles: { highest: { position: 10 } } }),
      // Знімок учасника: саме на ньому масивні add/remove і затирали одне одного.
      fetch: async () => ({ roles: { cache: new Map([...held].map((id) => [id, role(id)])) } }),
      addRole: async ({ role: id }) => { calls.push(`+${id}`); held.add(id); },
      removeRole: async ({ role: id }) => { calls.push(`-${id}`); held.delete(id); },
    },
  };
  const buttons = [{ components: [{ customId: panelButtonId("exclusive", OLD) }, { customId: panelButtonId("exclusive", NEW) }] }];
  const reply = await rolePanel.execute({
    customId: panelButtonId("exclusive", NEW), guild, user: { id: "u1" }, message: { components: buttons },
  });
  assert.deepEqual(calls, [`+${NEW}`, `-${OLD}`]);
  assert.deepEqual([...held], [NEW]);
  assert.match(reply, /Added <@&202>/);
});

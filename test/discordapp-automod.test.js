import test from "node:test";
import assert from "node:assert/strict";
import { AutoModerationActionType as Action, AutoModerationRuleTriggerType as Trigger } from "discord.js";

import { validateServerConfig } from "../src/module/discordapp/features/provision/schema.js";
import { planProvision } from "../src/module/discordapp/features/provision/planner.js";
import { automodOptions, canonicalRule, diffRule } from "../src/module/discordapp/features/provision/automod.js";
import { formatPlan } from "../src/module/discordapp/features/provision/formatPlan.js";

const GUILD = "111111111111111111";

const BASE = {
  guildId: GUILD,
  archive: { key: "archive", name: "ARCHIVE" },
  roles: [{ key: "mod", name: "Mod" }],
  channels: [{ key: "mod-log", name: "mod-log" }, { key: "voice", name: "Voice", type: "voice" }],
};

const RULES = [
  { key: "scam", name: "Scam links", type: "keyword", keywords: ["*free nitro*", "steamcommunlty"], regex: ["disc[o0]rd\\.gift"],
    actions: [{ type: "block", message: "Looks like a scam" }, { type: "alert", channel: "mod-log" }, { type: "timeout", seconds: 600 }],
    exempt: { roles: ["mod"], channels: ["mod-log"] } },
  { key: "slurs", type: "preset", presets: ["slurs", "profanity"], actions: [{ type: "block" }] },
  { key: "spam", type: "spam", actions: [{ type: "block" }] },
  { key: "mentions", type: "mention-spam", limit: 8, raidProtection: true, actions: [{ type: "block" }, { type: "timeout", seconds: 300 }] },
];

function desiredOf(automod = RULES) {
  const { errors, desired } = validateServerConfig({ ...BASE, automod });
  assert.deepEqual(errors, []);
  return desired;
}

function server({ automod = [], roles = [], channels = [] } = {}) {
  return {
    guildId: GUILD, name: "T", community: true, everyoneId: GUILD,
    bot: { userId: "bot", roleId: "r-bot", highestPosition: 50, admin: true },
    roles: [{ id: "r-bot", name: "Bot", color: 0, hoist: false, mentionable: false, permissions: 0n, position: 50, managed: true }, ...roles],
    channels, messages: [], automod,
  };
}

// ── Валідація ──────────────────────────────────────────────────────────────

test("automod — a valid set parses into rules", () => {
  const desired = desiredOf();
  assert.deepEqual(desired.automod.map((r) => [r.key, r.type, r.name]), [
    ["scam", "keyword", "Scam links"], ["slurs", "preset", "slurs"], ["spam", "spam", "spam"], ["mentions", "mention-spam", "mentions"],
  ]);
  assert.deepEqual(desired.automod[1].metadata.presets, [3, 1]);
});

test("automod — Discord's limits and mistakes are config errors", () => {
  const { errors } = validateServerConfig({ ...BASE, automod: [
    { key: "a", type: "keyword", actions: [{ type: "block" }] },
    { key: "b", type: "spam", keywords: ["x"], actions: [{ type: "timeout", seconds: 60 }] },
    { key: "c", type: "spam", actions: [{ type: "block" }] },
    { key: "d", type: "preset", presets: ["rude"], actions: [] },
    { key: "e", type: "mention-spam", limit: 99, actions: [{ type: "alert", channel: "voice" }] },
    { key: "f", type: "nope", actions: [] },
  ] });
  const has = (text) => assert.ok(errors.some((e) => e.includes(text)), `expected an error with "${text}" in:\n${errors.join("\n")}`);
  has('a keyword rule needs "keywords" or "regex"');
  has("keywords: does not apply to a spam rule");
  has("timeout only on keyword and mention-spam");
  has("at most 1 spam rule(s)");
  has('unknown preset "rude"');
  has("needs at least one action");
  has("1–50");
  has("alerts go to a text channel");
  has("must be one of keyword, preset, spam, mention-spam");
});

// ── Канонічна форма ────────────────────────────────────────────────────────

test("canonicalRule — options from the config equal the rule Discord returns", () => {
  const desired = desiredOf();
  const context = { roleIds: new Map([["mod", "r1"]]), channelIds: new Map([["mod-log", "c1"]]) };
  const { options, pending } = automodOptions(desired.automod[0], context);
  assert.deepEqual(pending, []);

  // Як правило виглядає, прочитане з Discord (readGuild): інший порядок,
  // channelId замість channel, порожні поля, яких конфіг не задавав.
  const fromDiscord = {
    name: "Scam links", enabled: true, triggerType: Trigger.Keyword,
    triggerMetadata: { keywordFilter: ["steamcommunlty", "*free nitro*"], regexPatterns: ["disc[o0]rd\\.gift"], allowList: [], presets: [], mentionTotalLimit: null },
    actions: [
      { type: Action.Timeout, metadata: { durationSeconds: 600, channelId: null, customMessage: null } },
      { type: Action.SendAlertMessage, metadata: { channelId: "c1", durationSeconds: null, customMessage: null } },
      { type: Action.BlockMessage, metadata: { customMessage: "Looks like a scam", channelId: null, durationSeconds: null } },
    ],
    exemptRoles: ["r1"], exemptChannels: ["c1"],
  };
  assert.deepEqual(diffRule(canonicalRule(options), canonicalRule(fromDiscord)), []);
  assert.deepEqual(diffRule(canonicalRule(options), canonicalRule({ ...fromDiscord, enabled: false, name: "Old" })), ['name "Old" → "Scam links"', "enable"]);
});

// ── План ───────────────────────────────────────────────────────────────────

test("planAutomod — single-instance types are adopted by type, keyword rules by name", () => {
  const desired = desiredOf();
  const current = server({
    roles: [{ id: "r1", name: "Mod", color: 0, hoist: false, mentionable: false, permissions: 0n, position: 5, managed: false }],
    channels: [
      { id: "c1", name: "mod-log", kind: "text", parentId: null, position: 0, topic: null, nsfw: false, slowmode: 0, overwrites: [] },
      { id: "c2", name: "Voice", kind: "voice", parentId: null, position: 0, topic: null, nsfw: false, slowmode: 0, overwrites: [] },
    ],
    automod: [
      { id: "a1", name: "Block Mention Spam", enabled: true, triggerType: Trigger.MentionSpam,
        triggerMetadata: { mentionTotalLimit: 20 }, actions: [{ type: Action.BlockMessage, metadata: {} }], exemptRoles: [], exemptChannels: [] },
      { id: "a2", name: "Someone's own rule", enabled: true, triggerType: Trigger.Keyword,
        triggerMetadata: { keywordFilter: ["x"] }, actions: [{ type: Action.BlockMessage, metadata: {} }], exemptRoles: [], exemptChannels: [] },
    ],
  });
  const plan = planProvision(desired, current, []);
  const ops = Object.fromEntries(plan.ops.filter((op) => op.kind === "automod").map((op) => [op.key, op]));
  assert.equal(ops.mentions.op, "adopt", "Community-правило mention spam прийнято, а не продубльовано");
  assert.ok(ops.mentions.changes.includes('name "Block Mention Spam" → "mentions"'));
  assert.ok(ops.mentions.changes.includes("mentionTotalLimit"));
  assert.equal(ops.scam.op, "create", "keyword-правило з іншою назвою не чіпається");
  assert.deepEqual(plan.unmanaged.automod, ["Someone's own rule"]);
});

test("planAutomod — removed from the config is orphaned; unreadable rules are a warning, not an error", () => {
  const current = server({ automod: [{ id: "a1", name: "Spam", enabled: true, triggerType: Trigger.Spam, triggerMetadata: {}, actions: [], exemptRoles: [], exemptChannels: [] }] });
  const plan = planProvision(desiredOf([]), current, [{ kind: "automod", key: "spam", discord_id: "a1" }]);
  assert.ok(plan.ops.some((op) => op.op === "orphaned" && op.kind === "automod"));

  const blind = planProvision(desiredOf(), { ...current, automod: null }, []);
  assert.deepEqual(blind.errors, []);
  assert.match(blind.warnings[0], /Manage Server/);
  assert.match(formatPlan(blind, { configName: "x.json" }), /\*\*Warnings\*\*\n⚠ AutoMod rules could not be read/);
});

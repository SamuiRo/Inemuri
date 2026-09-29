import {
  AutoModerationActionType as Action,
  AutoModerationRuleEventType as Event,
  AutoModerationRuleKeywordPresetType as Preset,
  AutoModerationRuleTriggerType as Trigger,
} from "discord.js";

/**
 * AutoMod як ресурс провіжну (docs/DISCORDAPP.md, «AutoMod»). Чисті функції:
 * валідація конфігу, канонічна форма правила (однакова для конфігу і для
 * того, що повертає Discord), план.
 *
 * Правила, як і все інше, **не видаляються**: прибране з конфігу — orphaned.
 *
 * Конфіг:
 *   { "key", "name", "type": "keyword" | "preset" | "spam" | "mention-spam",
 *     "keywords"?, "regex"?, "allow"?, "presets"?, "limit"?, "raidProtection"?,
 *     "actions": [{ "type": "block", "message"? } | { "type": "alert", "channel": "<key>" }
 *               | { "type": "timeout", "seconds" }],
 *     "exempt"?: { "roles"?: [<key>], "channels"?: [<key>] }, "enabled"? }
 */

const TYPES = {
  keyword: { trigger: Trigger.Keyword, max: 6, timeout: true },
  preset: { trigger: Trigger.KeywordPreset, max: 1, timeout: false },
  spam: { trigger: Trigger.Spam, max: 1, timeout: false },
  "mention-spam": { trigger: Trigger.MentionSpam, max: 1, timeout: true },
};
const TYPE_BY_TRIGGER = Object.fromEntries(Object.entries(TYPES).map(([name, t]) => [t.trigger, name]));
const PRESETS = { profanity: Preset.Profanity, "sexual-content": Preset.SexualContent, slurs: Preset.Slurs };

const FIELDS = ["key", "name", "type", "keywords", "regex", "allow", "presets", "limit", "raidProtection", "actions", "exempt", "enabled"];
const PER_TYPE = {
  keyword: ["keywords", "regex", "allow"],
  preset: ["presets", "allow"],
  spam: [],
  "mention-spam": ["limit", "raidProtection"],
};

// Ліміти Discord.
const LIMITS = {
  keywords: 1000, keywordLength: 60, regex: 10, regexLength: 260,
  allowKeyword: 100, allowPreset: 1000, mentions: 50, message: 150,
  timeout: 2_419_200, exemptRoles: 20, exemptChannels: 50,
};

// ── Валідація ──────────────────────────────────────────────────────────────

/**
 * @param {*} list     raw.automod
 * @param {{ roleKeys: Set<string>, channels: object[] }} known
 * @param {object} v   Validator зі schema.js.
 * @returns {object[]} Бажані правила.
 */
export function parseAutomod(list, known, v) {
  const rules = v.list(list, "automod").map((rule, i) => parseRule(rule, known, `automod[${i}]`, v)).filter(Boolean);
  v.unique(rules.map((rule) => rule.key), "automod", "key");
  for (const [type, { max }] of Object.entries(TYPES)) {
    const count = rules.filter((rule) => rule.type === type).length;
    if (count > max) v.error("automod", `Discord allows at most ${max} ${type} rule(s) per server, the config has ${count}`);
  }
  return rules;
}

function parseRule(rule, known, path, v) {
  if (!v.object(rule, path)) return null;
  v.fields(rule, FIELDS, path);
  const type = rule.type;
  if (!TYPES[type]) {
    v.error(`${path}.type`, `must be one of ${Object.keys(TYPES).join(", ")}`);
    return null;
  }
  for (const field of Object.values(PER_TYPE).flat()) {
    if (rule[field] !== undefined && !PER_TYPE[type].includes(field)) v.error(`${path}.${field}`, `does not apply to a ${type} rule`);
  }

  const parsed = {
    key: v.key(rule.key, `${path}.key`),
    name: v.name(rule.name ?? rule.key, `${path}.name`),
    type,
    enabled: rule.enabled ?? true,
    metadata: {},
    actions: parseActions(rule.actions, type, known, `${path}.actions`, v),
    exemptRoles: [],
    exemptChannels: [],
  };
  if (typeof parsed.enabled !== "boolean") v.error(`${path}.enabled`, "must be true or false");

  if (type === "keyword") {
    parsed.metadata.keywordFilter = strings(rule.keywords, LIMITS.keywords, LIMITS.keywordLength, `${path}.keywords`, v);
    parsed.metadata.regexPatterns = strings(rule.regex, LIMITS.regex, LIMITS.regexLength, `${path}.regex`, v);
    parsed.metadata.allowList = strings(rule.allow, LIMITS.allowKeyword, LIMITS.keywordLength, `${path}.allow`, v);
    if (!parsed.metadata.keywordFilter.length && !parsed.metadata.regexPatterns.length) {
      v.error(path, 'a keyword rule needs "keywords" or "regex"');
    }
  } else if (type === "preset") {
    const names = strings(rule.presets, 3, 20, `${path}.presets`, v);
    if (!names.length) v.error(`${path}.presets`, `list one or more of ${Object.keys(PRESETS).join(", ")}`);
    for (const name of names) if (!PRESETS[name]) v.error(`${path}.presets`, `unknown preset "${name}" (${Object.keys(PRESETS).join(", ")})`);
    parsed.metadata.presets = names.map((name) => PRESETS[name]).filter(Boolean);
    parsed.metadata.allowList = strings(rule.allow, LIMITS.allowPreset, LIMITS.keywordLength, `${path}.allow`, v);
  } else if (type === "mention-spam") {
    if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > LIMITS.mentions) {
      v.error(`${path}.limit`, `must be a whole number of mentions, 1–${LIMITS.mentions}`);
    }
    parsed.metadata.mentionTotalLimit = rule.limit;
    parsed.metadata.mentionRaidProtectionEnabled = rule.raidProtection ?? false;
  }

  if (rule.exempt !== undefined && v.object(rule.exempt, `${path}.exempt`)) {
    v.fields(rule.exempt, ["roles", "channels"], `${path}.exempt`);
    parsed.exemptRoles = v.list(rule.exempt.roles, `${path}.exempt.roles`);
    parsed.exemptChannels = v.list(rule.exempt.channels, `${path}.exempt.channels`);
    for (const key of parsed.exemptRoles) if (!known.roleKeys.has(key)) v.error(`${path}.exempt.roles`, `unknown role key "${key}"`);
    for (const key of parsed.exemptChannels) {
      if (!known.channels.some((c) => c.key === key)) v.error(`${path}.exempt.channels`, `unknown channel key "${key}"`);
    }
    if (parsed.exemptRoles.length > LIMITS.exemptRoles) v.error(`${path}.exempt.roles`, `at most ${LIMITS.exemptRoles}`);
    if (parsed.exemptChannels.length > LIMITS.exemptChannels) v.error(`${path}.exempt.channels`, `at most ${LIMITS.exemptChannels}`);
  }
  return parsed;
}

function parseActions(actions, type, known, path, v) {
  const list = v.list(actions, path);
  if (!list.length) v.error(path, "needs at least one action");
  return list.map((action, i) => {
    const at = `${path}[${i}]`;
    if (!v.object(action, at)) return null;
    if (action.type === "block") {
      v.fields(action, ["type", "message"], at);
      if (action.message !== undefined && (typeof action.message !== "string" || action.message.length > LIMITS.message)) {
        v.error(`${at}.message`, `must be text up to ${LIMITS.message} characters`);
      }
      return { type: "block", message: action.message ?? null };
    }
    if (action.type === "alert") {
      v.fields(action, ["type", "channel"], at);
      const channel = known.channels.find((c) => c.key === action.channel);
      if (!channel) v.error(`${at}.channel`, `unknown channel key "${action.channel}"`);
      else if (!["text", "announcement"].includes(channel.kind)) v.error(`${at}.channel`, "alerts go to a text channel");
      return { type: "alert", channelKey: action.channel };
    }
    if (action.type === "timeout") {
      v.fields(action, ["type", "seconds"], at);
      if (!TYPES[type].timeout) v.error(at, `Discord allows timeout only on keyword and mention-spam rules`);
      if (!Number.isInteger(action.seconds) || action.seconds < 1 || action.seconds > LIMITS.timeout) {
        v.error(`${at}.seconds`, `must be whole seconds, 1–${LIMITS.timeout} (28 days)`);
      }
      return { type: "timeout", seconds: action.seconds };
    }
    v.error(`${at}.type`, 'must be "block", "alert" or "timeout"');
    return null;
  }).filter(Boolean);
}

function strings(list, max, maxLength, path, v) {
  const items = v.list(list, path);
  if (items.length > max) v.error(path, `at most ${max} entries`);
  for (const item of items) {
    if (typeof item !== "string" || !item.trim() || item.length > maxLength) {
      v.error(path, `entries must be text up to ${maxLength} characters`);
      break;
    }
  }
  return items;
}

// ── Канонічна форма ────────────────────────────────────────────────────────

/**
 * Бажане правило → опції discord.js для create/edit плюс канонічна форма
 * для порівняння. Ролі й канали — за id; яких ще немає — у pending.
 */
export function automodOptions(rule, context) {
  const pending = [];
  const idOf = (map, key) => {
    const id = map.get(key);
    if (!id) pending.push(key);
    return id;
  };
  const actions = rule.actions.map((action) => {
    if (action.type === "block") return { type: Action.BlockMessage, metadata: action.message ? { customMessage: action.message } : {} };
    if (action.type === "alert") return { type: Action.SendAlertMessage, metadata: { channel: idOf(context.channelIds, action.channelKey) } };
    return { type: Action.Timeout, metadata: { durationSeconds: action.seconds } };
  });
  const options = {
    name: rule.name,
    eventType: Event.MessageSend,
    triggerType: TYPES[rule.type].trigger,
    triggerMetadata: rule.metadata,
    actions,
    enabled: rule.enabled,
    exemptRoles: rule.exemptRoles.map((key) => idOf(context.roleIds, key)).filter(Boolean),
    exemptChannels: rule.exemptChannels.map((key) => idOf(context.channelIds, key)).filter(Boolean),
  };
  return { options, pending };
}

/**
 * Канонічна форма для порівняння: однакова для опцій з конфігу і для
 * правила, прочитаного з Discord (readGuild). Списки відсортовані — Discord
 * порядку не гарантує, а для правила він не важить.
 */
export function canonicalRule({ name, enabled, triggerType, triggerMetadata = {}, actions = [], exemptRoles = [], exemptChannels = [] }) {
  const type = TYPE_BY_TRIGGER[triggerType];
  const meta = {};
  for (const field of META_FIELDS[type] ?? []) {
    const value = triggerMetadata[field];
    meta[field] = Array.isArray(value) ? [...value].sort() : value ?? DEFAULTS[field];
  }
  return {
    name,
    enabled: Boolean(enabled),
    type,
    metadata: meta,
    actions: actions
      .map(({ type: actionType, metadata = {} }) => ({
        type: actionType,
        customMessage: actionType === Action.BlockMessage ? metadata.customMessage || null : undefined,
        channel: actionType === Action.SendAlertMessage ? metadata.channel ?? metadata.channelId ?? null : undefined,
        durationSeconds: actionType === Action.Timeout ? metadata.durationSeconds ?? null : undefined,
      }))
      .sort((a, b) => a.type - b.type),
    exemptRoles: [...exemptRoles].sort(),
    exemptChannels: [...exemptChannels].sort(),
  };
}

const META_FIELDS = {
  keyword: ["keywordFilter", "regexPatterns", "allowList"],
  preset: ["presets", "allowList"],
  spam: [],
  "mention-spam": ["mentionTotalLimit", "mentionRaidProtectionEnabled"],
};
const DEFAULTS = { keywordFilter: [], regexPatterns: [], allowList: [], presets: [], mentionRaidProtectionEnabled: false };

/** Що відрізняється між двома канонічними формами — для плану. */
export function diffRule(want, have) {
  const changes = [];
  if (want.name !== have.name) changes.push(`name "${have.name}" → "${want.name}"`);
  if (want.enabled !== have.enabled) changes.push(want.enabled ? "enable" : "disable");
  for (const [field, value] of Object.entries(want.metadata)) {
    if (JSON.stringify(value) !== JSON.stringify(have.metadata[field])) changes.push(field);
  }
  if (JSON.stringify(want.actions) !== JSON.stringify(have.actions)) changes.push("actions");
  if (JSON.stringify(want.exemptRoles) !== JSON.stringify(have.exemptRoles)) changes.push("exempt roles");
  if (JSON.stringify(want.exemptChannels) !== JSON.stringify(have.exemptChannels)) changes.push("exempt channels");
  return changes;
}

// ── План ───────────────────────────────────────────────────────────────────

/**
 * Правила AutoMod у план. `current.automod === null` — правила не
 * прочитались (без Manage Server); тоді план AutoMod не складається, а
 * apply, якому Administrator потрібен однаково, прочитає їх сам.
 */
export function planAutomod(desired, current, stateOf, context, plan) {
  if (!desired.automod.length && !stateOf.all("automod").length) return;
  if (current.automod == null) {
    plan.warnings.push("AutoMod rules could not be read (the bot lacks Manage Server) — they are planned when applying with Administrator.");
    return;
  }

  const byId = new Map(current.automod.map((rule) => [rule.id, rule]));
  const claimed = new Set(stateOf.ids("automod"));
  const wanted = new Set(desired.automod.map((rule) => rule.key));

  for (const rule of desired.automod) {
    const saved = stateOf.get("automod", rule.key);
    let have = saved && byId.get(saved.discord_id);
    let op = "update";
    if (!have) {
      const trigger = TYPES[rule.type].trigger;
      // Правило типу, якого на сервері може бути лише одне, приймається за
      // типом: друге Discord створити не дасть, а Community-сервери такі
      // правила вже мають.
      const candidates = current.automod.filter((r) => !claimed.has(r.id) && r.triggerType === trigger
        && (TYPES[rule.type].max === 1 || r.name === rule.name));
      if (candidates.length > 1) {
        plan.errors.push(`${candidates.length} AutoMod rules are named "${rule.name}" — rename all but one.`);
        continue;
      }
      have = candidates[0];
      op = "adopt";
    }

    const { options, pending } = automodOptions(rule, context);
    const base = { phase: "automod", kind: "automod", key: rule.key, name: rule.name, spec: rule };
    if (!have) {
      plan.ops.push({ ...base, op: "create", changes: [] });
      continue;
    }
    claimed.add(have.id);
    const changes = pending.length
      ? [`exemptions/alerts for ${pending.join(", ")} once they exist`]
      : diffRule(canonicalRule(options), canonicalRule(have));
    if (op === "adopt" || changes.length) {
      // currentName — як правило зветься на сервері зараз: під цією назвою
      // людина шукатиме його в налаштуваннях.
      plan.ops.push({ ...base, op, id: have.id, currentName: have.name, changes });
    }
  }

  for (const saved of stateOf.all("automod")) {
    if (!wanted.has(saved.key) && byId.has(saved.discord_id)) {
      plan.ops.push({ phase: "report", op: "orphaned", kind: "automod", key: saved.key, name: byId.get(saved.discord_id).name });
    }
  }
  plan.unmanaged.automod = current.automod.filter((rule) => !claimed.has(rule.id)).map((rule) => rule.name);
}

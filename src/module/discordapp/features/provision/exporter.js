import {
  AutoModerationActionType as Action,
  AutoModerationRuleKeywordPresetType as Preset,
  AutoModerationRuleTriggerType as Trigger,
} from "discord.js";
import { bitNames, VIEW_CHANNEL } from "./permissions.js";
import { PROVISIONABLE_KINDS } from "../../channelKinds.js";

/**
 * Сервер → конфіг провіжну (docs/DISCORDAPP.md, «/provision export»).
 * Чиста функція над знімком readGuild.
 *
 * Мета — щоб перший конфіг правили, а не писали з нуля, і щоб він одразу
 * описував сервер як є: план експорту проти того самого сервера — лише
 * «adopt» без змін (перевіряється тестом). Чого формат конфігу не виражає,
 * те пропускається і перелічується в `skipped`:
 *   - overwrites на окремих учасників;
 *   - overwrite ролі самого бота (провіжн ставить його сам);
 *   - ролі інтеграцій, треди, media-канали;
 *   - повідомлення (їхні тексти живуть у .md-файлах, яких тут немає).
 *
 * **Ключі керованого вже ресурсу беруться зі стану**, а не з назви: інакше
 * план не впізнав би його під новим ключем і запропонував би дублікат
 * (знайдено на живому сервері).
 *
 * @param {object} current   Знімок readGuild.
 * @param {object[]} [state] Рядки discord_resources цього сервера.
 * @returns {{ config: object, skipped: string[] }}
 */
export function exportConfig(current, state = []) {
  const skipped = [];
  const keyOf = (kinds) => new Map(state.filter((row) => kinds.includes(row.kind)).map((row) => [row.discord_id, row.key]));
  const roleKeys = keyMaker(keyOf(["role"]));
  const channelKeys = keyMaker(keyOf(["category", "channel"]));

  const roles = current.roles
    .filter((role) => !role.managed)
    .sort((a, b) => b.position - a.position)
    .map((role) => {
      const out = { key: roleKeys.make(role.name, "role", role.id), name: role.name };
      if (role.color) out.color = `#${role.color.toString(16).padStart(6, "0")}`;
      if (role.hoist) out.hoist = true;
      if (role.mentionable) out.mentionable = true;
      out.permissions = bitNames(role.permissions);
      return [role.id, out];
    });
  const roleKeyById = new Map(roles.map(([id, role]) => [id, role.key]));
  for (const role of current.roles.filter((r) => r.managed)) skipped.push(`role @${role.name} (managed by an integration)`);

  const toTargets = (overwrites, where) => {
    const targets = {};
    for (const overwrite of overwrites) {
      let target;
      if (overwrite.id === current.everyoneId) target = "@everyone";
      else if (overwrite.id === current.bot.roleId || overwrite.id === current.bot.userId) continue;
      else if (roleKeyById.has(overwrite.id)) target = `role:${roleKeyById.get(overwrite.id)}`;
      else {
        skipped.push(`${where}: overwrite for ${overwrite.type === "member" ? "a member" : "a role outside the config"} (${overwrite.id})`);
        continue;
      }
      targets[target] = bits(overwrite);
    }
    return targets;
  };

  // Наявна категорія "archive" стає архівом конфігу — інакше план створив би
  // поруч другу. Її канали туди потрапили як архівні й у конфіг не йдуть.
  const archiveCategory = current.channels.find((c) => c.kind === "category" && slug(c.name) === "archive");
  if (archiveCategory) {
    for (const channel of current.channels.filter((c) => c.parentId === archiveCategory.id)) {
      skipped.push(`#${channel.name} (already in the archive category)`);
    }
  }
  const categories = current.channels
    .filter((channel) => channel.kind === "category" && channel !== archiveCategory)
    .sort(byPosition);
  const channelsOf = (parentId) => current.channels
    .filter((channel) => channel.kind !== "category" && (channel.parentId ?? null) === parentId)
    .sort(byPosition);

  const channelIdToKey = new Map();
  const exportChannel = (channel, categoryTargets) => {
    if (!PROVISIONABLE_KINDS.includes(channel.kind)) {
      skipped.push(`#${channel.name} (${channel.kind} channels are not provisioned)`);
      return null;
    }
    const out = { key: channelKeys.make(channel.name, channel.kind, channel.id), name: channel.name };
    channelIdToKey.set(channel.id, out.key);
    if (channel.kind !== "text") out.type = channel.kind;
    if (channel.topic) out.topic = channel.topic;
    if (channel.nsfw) out.nsfw = true;
    if (channel.slowmode) out.slowmode = channel.slowmode;

    const own = toTargets(channel.overwrites, `#${channel.name}`);
    if (!sameTargets(own, categoryTargets)) {
      // Канал успадковує overwrites категорії, а свої перемагають для тієї ж
      // цілі. Ціль, яку категорія має, а канал ні, треба занулити явно —
      // інакше вона повернулась би з категорії.
      for (const target of Object.keys(categoryTargets)) own[target] ??= {};
      out.overwrites = own;
    }
    return out;
  };

  const config = {
    _readme: "Exported from the server. Review before applying: keys are derived from names, the archive block is a placeholder, and messages are not exported.",
    guildId: current.guildId,
    archive: {
      key: channelKeys.make("archive", "category", archiveCategory?.id),
      name: archiveCategory?.name ?? "🗄 ARCHIVE",
      // Ролі архіву — ті, кому в наявній архівній категорії дозволено бачити.
      roles: (archiveCategory?.overwrites ?? [])
        .filter((overwrite) => roleKeyById.has(overwrite.id) && (overwrite.allow & VIEW_CHANNEL) !== 0n)
        .map((overwrite) => roleKeyById.get(overwrite.id)),
    },
    roles: roles.map(([, role]) => role),
    categories: categories.map((category) => {
      const targets = toTargets(category.overwrites, `📁 ${category.name}`);
      const out = { key: channelKeys.make(category.name, "category", category.id), name: category.name };
      if (Object.keys(targets).length) out.overwrites = targets;
      out.channels = channelsOf(category.id).map((channel) => exportChannel(channel, targets)).filter(Boolean);
      return out;
    }),
    channels: channelsOf(null).map((channel) => exportChannel(channel, {})).filter(Boolean),
  };

  const automod = exportAutomod(current.automod, { roleKeyById, channelIdToKey, skipped, stateKeys: keyOf(["automod"]) });
  if (automod.length) config.automod = automod;
  return { config, skipped };
}

// ── AutoMod ────────────────────────────────────────────────────────────────

const TYPE_BY_TRIGGER = {
  [Trigger.Keyword]: "keyword",
  [Trigger.KeywordPreset]: "preset",
  [Trigger.Spam]: "spam",
  [Trigger.MentionSpam]: "mention-spam",
};
const PRESET_NAMES = { [Preset.Profanity]: "profanity", [Preset.SexualContent]: "sexual-content", [Preset.Slurs]: "slurs" };

function exportAutomod(rules, { roleKeyById, channelIdToKey, skipped, stateKeys }) {
  if (!rules) return [];
  const keys = keyMaker(stateKeys);
  return rules.flatMap((rule) => {
    const type = TYPE_BY_TRIGGER[rule.triggerType];
    if (!type) {
      skipped.push(`AutoMod "${rule.name}" (this rule type is not provisioned)`);
      return [];
    }
    const meta = rule.triggerMetadata ?? {};
    const out = { key: keys.make(rule.name, "automod", rule.id), name: rule.name, type };
    if (type === "keyword") {
      if (meta.keywordFilter?.length) out.keywords = meta.keywordFilter;
      if (meta.regexPatterns?.length) out.regex = meta.regexPatterns;
    }
    if (type === "preset") out.presets = (meta.presets ?? []).map((p) => PRESET_NAMES[p]).filter(Boolean);
    if ((type === "keyword" || type === "preset") && meta.allowList?.length) out.allow = meta.allowList;
    if (type === "mention-spam") {
      out.limit = meta.mentionTotalLimit;
      if (meta.mentionRaidProtectionEnabled) out.raidProtection = true;
    }
    out.actions = rule.actions.flatMap(({ type: actionType, metadata = {} }) => {
      if (actionType === Action.BlockMessage) return [metadata.customMessage ? { type: "block", message: metadata.customMessage } : { type: "block" }];
      if (actionType === Action.Timeout) return [{ type: "timeout", seconds: metadata.durationSeconds }];
      if (actionType === Action.SendAlertMessage && channelIdToKey.has(metadata.channelId)) {
        return [{ type: "alert", channel: channelIdToKey.get(metadata.channelId) }];
      }
      skipped.push(`AutoMod "${rule.name}": an action that has no config equivalent`);
      return [];
    });
    const exemptRoles = rule.exemptRoles.filter((id) => roleKeyById.has(id)).map((id) => roleKeyById.get(id));
    const exemptChannels = rule.exemptChannels.filter((id) => channelIdToKey.has(id)).map((id) => channelIdToKey.get(id));
    if (exemptRoles.length || exemptChannels.length) {
      out.exempt = {};
      if (exemptRoles.length) out.exempt.roles = exemptRoles;
      if (exemptChannels.length) out.exempt.channels = exemptChannels;
    }
    if (!rule.enabled) out.enabled = false;
    return [out];
  });
}

// ── Дрібниці ───────────────────────────────────────────────────────────────

function bits({ allow, deny }) {
  const out = {};
  if (allow) out.allow = bitNames(allow);
  if (deny) out.deny = bitNames(deny);
  return out;
}

function sameTargets(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

function byPosition(a, b) {
  return a.position - b.position || a.name.localeCompare(b.name);
}

function slug(name) {
  return String(name).toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);
}

/**
 * Ключі: зі стану, якщо ресурс уже керований; інакше з назви — латиниця,
 * цифри, дефіси. Назва без латиниці ("📌", "Загальне") дає `<kind>-N`.
 * Повтор отримує суфікс `-2`, `-3`. Ключі зі стану зарезервовані наперед,
 * тож новий ключ із назви з ними не зіткнеться.
 *
 * @param {Map<string, string>} [stateKeys]  discord_id → key.
 */
export function keyMaker(stateKeys = new Map()) {
  const used = new Set(stateKeys.values());
  const counters = new Map();
  return {
    make(name, kind, id = null) {
      if (id && stateKeys.has(id)) return stateKeys.get(id);
      let base = slug(name);
      if (!base) {
        const n = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, n);
        base = `${kind}-${n}`;
      }
      let key = base;
      for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
      used.add(key);
      return key;
    },
  };
}

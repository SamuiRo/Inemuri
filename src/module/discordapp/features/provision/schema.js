import { hasTextName, PROVISIONABLE_KINDS } from "../../channelKinds.js";
import {
  ARCHIVE_ROLE_ALLOW,
  BOT_CHANNEL_ALLOW,
  dangerousIn,
  toBits,
  unknownPermissions,
  VIEW_CHANNEL,
} from "./permissions.js";
import { MAX_PANEL_ROLES, MAX_CONTENT, MAX_EMBED_DESCRIPTION } from "./messages.js";
import { PANEL_MODES } from "../roles/rolePanel.js";
import { parseAutomod } from "./automod.js";
import { DISCORD } from "../../../../shared/platformLimits.js";

/**
 * Валідація конфігу сервера і нормалізація в «бажаний стан». Чиста функція:
 * сирий JSON → { errors, desired }. Формат конфігу описано в
 * docs/DISCORDAPP.md («Feature: provisioning»).
 *
 * Правило для полів: **керується лише те, що задано.** Поле, якого в конфігу
 * немає (колір ролі, topic каналу, overwrites), провіжн не чіпає. Назва
 * керується завжди. Ключі, що починаються з `_`, — коментарі й ігноруються.
 *
 * Бажаний стан:
 *   { guildId, archive: { key, name, roleKeys }, archiveUnmanaged: boolean,
 *     roles:      [{ key, name, color?, hoist?, mentionable?, permissions: BigInt|null }],
 *     categories: [{ key, name, overwrites, requires, isArchive }],   // архів — останній
 *     channels:   [{ key, name, kind, parentKey, topic?, nsfw?, slowmode?, overwrites, requires }],
 *     messages:   [{ key, channelKey, kind: "text", file, embed: null|{ title?, color? } }
 *                | { key, channelKey, kind: "rolePanel", panel: { mode, text?, roles: [{ key, label?, emoji? }] } }],
 *     automod:    [правила — формат у automod.js] }
 *
 *   Текст повідомлень (`body`) тут не читається — функція чиста; його
 *   підвантажує Provisioner.js.
 *
 *   overwrites = null (не керуються) | [{ target, allow: BigInt, deny: BigInt }],
 *   target     = "@everyone" | "@bot" | "role:<key>"
 */

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TARGET_RE = /^(@everyone|role:[a-z0-9][a-z0-9-]*)$/;
// Звичайний emoji (не текст і не кастомний <:name:id>).
const EMOJI_RE = /^(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}])[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Component}\u200d\ufe0f\u20e3]+$/u;
// Шлях відносно src/config/discordapp/messages/, без виходу за теку.
const FILE_RE = /^(?!.*\.\.)[a-z0-9][a-z0-9_./-]*\.md$/i;
// Аватар персони: картинка в тій самій теці повідомлень.
const AVATAR_RE = /^(?!.*[.][.])[a-z0-9][a-z0-9_./-]*[.](png|jpe?g|webp|gif)$/i;
// Discord не приймає вебхук з такими словами в назві.
const WEBHOOK_NAME_BANNED = ["discord", "clyde"];

const FIELDS = {
  root: ["guildId", "archive", "archiveUnmanaged", "presets", "personas", "roles", "categories", "channels", "automod"],
  archive: ["key", "name", "roles", "adopt"],
  role: ["key", "name", "color", "hoist", "mentionable", "permissions", "adopt"],
  category: ["key", "name", "overwrites", "requires", "optIn", "channels", "adopt"],
  channel: ["key", "name", "type", "topic", "nsfw", "slowmode", "overwrites", "requires", "messages", "adopt"],
  overwrite: ["allow", "deny"],
  optIn: ["role", "panel"],
  message: ["key", "file", "embed", "rolePanel", "as"],
  persona: ["name", "avatar"],
  embed: ["title", "color"],
  rolePanel: ["mode", "text", "roles"],
  panelRole: ["role", "label", "emoji"],
};

// Види каналів, куди провіжн публікує повідомлення.
const MESSAGE_KINDS = ["text", "announcement"];

// Ліміти Discord.
const MAX_ROLES = 250;
const MAX_CHANNELS_PER_CATEGORY = 50;
const MAX_TOPIC = DISCORD.channelTopic;
const MAX_SLOWMODE = DISCORD.slowmodeSeconds;

/**
 * @param {object} raw  Розпарсений JSON конфігу.
 * @returns {{ errors: string[], desired: object|null }}
 */
export function validateServerConfig(raw) {
  const v = new Validator();
  if (!v.object(raw, "config")) return { errors: v.errors, desired: null };
  v.fields(raw, FIELDS.root, "config");

  if (!SNOWFLAKE_RE.test(String(raw.guildId ?? ""))) v.error("guildId", "must be the server id (17–20 digits)");

  const presets = parsePresets(raw.presets, v);
  const personas = parsePersonas(raw.personas, v);
  const roles = v.list(raw.roles, "roles").map((role, i) => parseRole(role, `roles[${i}]`, v));
  if (roles.length > MAX_ROLES) v.error("roles", `Discord allows at most ${MAX_ROLES} roles`);
  const roleKeys = new Set(roles.map((role) => role.key));
  v.unique(roles.map((role) => role.key), "roles", "role key");
  v.unique(roles.map((role) => role.adopt), "roles", "adopt id");

  const archive = parseArchive(raw.archive, roleKeys, v);
  // Усе, чого немає в конфігу, — в архів (канали) або приховати (категорії).
  const archiveUnmanaged = raw.archiveUnmanaged ?? false;
  if (typeof archiveUnmanaged !== "boolean") v.error("archiveUnmanaged", "must be true or false");

  const categories = [];
  const channels = [];
  const messages = [];
  const optIns = [];
  for (const [i, category] of v.list(raw.categories, "categories").entries()) {
    const path = `categories[${i}]`;
    if (!v.object(category, path)) continue;
    v.fields(category, FIELDS.category, path);
    let overwrites = parseOverwriteSpec(category.overwrites, presets, roleKeys, `${path}.overwrites`, v);
    const optIn = parseOptIn(category.optIn, roleKeys, `${path}.optIn`, v);
    if (optIn) {
      overwrites = withOptIn(overwrites, optIn.roleKey);
      optIns.push(optIn);
    }
    const parsed = {
      key: v.key(category.key, `${path}.key`),
      name: v.name(category.name, `${path}.name`),
      overwrites: withBot(overwrites),
      requires: parseRequires(category.requires, `${path}.requires`, v),
      adopt: v.adopt(category.adopt, `${path}.adopt`),
      isArchive: false,
    };
    categories.push(parsed);

    const inner = v.list(category.channels, `${path}.channels`);
    if (inner.length > MAX_CHANNELS_PER_CATEGORY) {
      v.error(`${path}.channels`, `Discord allows at most ${MAX_CHANNELS_PER_CATEGORY} channels per category`);
    }
    for (const [j, channel] of inner.entries()) {
      const channelPath = `${path}.channels[${j}]`;
      const parsedChannel = parseChannel(channel, parsed, overwrites, presets, roleKeys, channelPath, v);
      channels.push(parsedChannel);
      messages.push(...parseMessages(channel, parsedChannel, roleKeys, personas, channelPath, v));
    }
  }
  for (const [i, channel] of v.list(raw.channels, "channels").entries()) {
    const parsedChannel = parseChannel(channel, null, null, presets, roleKeys, `channels[${i}]`, v);
    channels.push(parsedChannel);
    messages.push(...parseMessages(channel, parsedChannel, roleKeys, personas, `channels[${i}]`, v));
  }

  if (archive) categories.push(archive.category);
  v.unique([...categories, ...channels].map((item) => item?.key), "categories/channels", "key");
  v.unique([...categories, ...channels].map((item) => item?.adopt), "categories/channels", "adopt id");
  v.unique(messages.map((message) => message.key), "messages", "message key");
  attachOptInsToPanels(optIns, messages, v);
  checkPanelRoles(messages, roles, v);
  const automod = parseAutomod(raw.automod, { roleKeys, channels: channels.filter(Boolean) }, v);

  if (v.errors.length) return { errors: v.errors, desired: null };
  return {
    errors: [],
    desired: {
      guildId: String(raw.guildId),
      archive: { key: archive.category.key, name: archive.category.name, roleKeys: archive.roleKeys },
      archiveUnmanaged,
      personas,
      roles,
      categories,
      channels: channels.filter(Boolean),
      messages,
      automod,
    },
  };
}

/** Як Discord зберігає назву текстового каналу: нижній регістр, пробіли → дефіси. */
export function normalizeChannelName(name, kind) {
  return hasTextName(kind) ? name.trim().toLowerCase().replace(/\s+/g, "-") : name.trim();
}

// ── Частини конфігу ────────────────────────────────────────────────────────

function parseRole(role, path, v) {
  if (!v.object(role, path)) return { key: null };
  v.fields(role, FIELDS.role, path);
  const parsed = {
    key: v.key(role.key, `${path}.key`),
    name: v.name(role.name, `${path}.name`),
    permissions: null,
    adopt: v.adopt(role.adopt, `${path}.adopt`),
  };

  if (role.color !== undefined) {
    if (COLOR_RE.test(String(role.color))) parsed.color = parseInt(role.color.slice(1), 16);
    else v.error(`${path}.color`, 'must look like "#e67e22"');
  }
  for (const flag of ["hoist", "mentionable"]) {
    if (role[flag] === undefined) continue;
    if (typeof role[flag] === "boolean") parsed[flag] = role[flag];
    else v.error(`${path}.${flag}`, "must be true or false");
  }
  if (role.permissions !== undefined) parsed.permissions = v.permissions(role.permissions, `${path}.permissions`);
  return parsed;
}

function parseArchive(archive, roleKeys, v) {
  if (archive === undefined) {
    v.error("archive", "is required — removed channels are moved there instead of being deleted");
    return null;
  }
  if (!v.object(archive, "archive")) return null;
  v.fields(archive, FIELDS.archive, "archive");
  const keys = v.list(archive.roles, "archive.roles");
  for (const key of keys) {
    if (!roleKeys.has(key)) v.error("archive.roles", `unknown role key "${key}"`);
  }
  // Архів приватний завжди: @everyone не бачить, ролі архіву й бот — бачать.
  const overwrites = new Map([
    ["@everyone", { allow: 0n, deny: VIEW_CHANNEL }],
    ...keys.map((key) => [`role:${key}`, { allow: ARCHIVE_ROLE_ALLOW, deny: 0n }]),
  ]);
  return {
    roleKeys: keys,
    category: {
      key: v.key(archive.key, "archive.key"),
      name: v.name(archive.name, "archive.name"),
      overwrites: withBot(overwrites),
      requires: null,
      adopt: v.adopt(archive.adopt, "archive.adopt"),
      isArchive: true,
    },
  };
}

function parseChannel(channel, category, categoryOverwrites, presets, roleKeys, path, v) {
  if (!v.object(channel, path)) return null;
  v.fields(channel, FIELDS.channel, path);

  const kind = channel.type ?? "text";
  if (!PROVISIONABLE_KINDS.includes(kind)) {
    v.error(`${path}.type`, `must be one of ${PROVISIONABLE_KINDS.join(", ")}`);
  }
  const name = v.name(channel.name, `${path}.name`);
  const own = parseOverwriteSpec(channel.overwrites, presets, roleKeys, `${path}.overwrites`, v);
  const parsed = {
    key: v.key(channel.key, `${path}.key`),
    name: name && normalizeChannelName(name, kind),
    kind,
    parentKey: category?.key ?? null,
    // Канал без власних overwrites — синхронізований з категорією; зі своїми —
    // категорійні плюс свої, де свої перемагають для тієї ж цілі.
    overwrites: withBot(mergeOverwrites(categoryOverwrites, own)),
    requires: parseRequires(channel.requires, `${path}.requires`, v) ?? category?.requires ?? null,
    adopt: v.adopt(channel.adopt, `${path}.adopt`),
  };

  if (channel.topic !== undefined) {
    // Discord приймає topic лише в текстових каналах — інакше помилка посеред apply.
    if (!hasTextName(kind)) v.error(`${path}.topic`, `a ${kind} channel has no topic`);
    else if (typeof channel.topic === "string" && channel.topic.length <= MAX_TOPIC) parsed.topic = channel.topic;
    else v.error(`${path}.topic`, `must be text up to ${MAX_TOPIC} characters`);
  }
  if (channel.nsfw !== undefined) {
    if (typeof channel.nsfw === "boolean") parsed.nsfw = channel.nsfw;
    else v.error(`${path}.nsfw`, "must be true or false");
  }
  if (channel.slowmode !== undefined) {
    const s = channel.slowmode;
    if (Number.isInteger(s) && s >= 0 && s <= MAX_SLOWMODE) parsed.slowmode = s;
    else v.error(`${path}.slowmode`, `must be whole seconds, 0–${MAX_SLOWMODE}`);
  }
  return parsed;
}

// ── Повідомлення і панелі ролей ────────────────────────────────────────────

function parseMessages(channel, parsedChannel, roleKeys, personas, path, v) {
  if (!channel || typeof channel !== "object" || channel.messages === undefined) return [];
  const list = v.list(channel.messages, `${path}.messages`);
  if (list.length && parsedChannel && !MESSAGE_KINDS.includes(parsedChannel.kind)) {
    v.error(`${path}.messages`, `messages can be posted only in ${MESSAGE_KINDS.join(" or ")} channels`);
    return [];
  }
  return list.map((message, i) => parseMessage(message, parsedChannel?.key, roleKeys, personas, `${path}.messages[${i}]`, v)).filter(Boolean);
}

function parseMessage(message, channelKey, roleKeys, personas, path, v) {
  if (!v.object(message, path)) return null;
  v.fields(message, FIELDS.message, path);
  const key = v.key(message.key, `${path}.key`);

  if ((message.file === undefined) === (message.rolePanel === undefined)) {
    v.error(path, 'needs exactly one of "file" (text from a .md file) or "rolePanel"');
    return null;
  }

  if (message.file !== undefined) {
    if (typeof message.file !== "string" || !FILE_RE.test(message.file)) {
      v.error(`${path}.file`, "must be a .md path inside src/config/discordapp/messages/");
    }
    const parsed = { key, channelKey, kind: "text", file: message.file, embed: parseEmbed(message.embed, `${path}.embed`, v), as: null };
    if (message.as !== undefined) {
      if (typeof message.as === "string" && personas.has(message.as)) parsed.as = message.as;
      else v.error(`${path}.as`, `unknown persona "${message.as}" (personas: ${[...personas.keys()].join(", ") || "none"})`);
    }
    return parsed;
  }

  // Кнопки панелі обробляє бот; від імені вебхука їх не публікуємо.
  if (message.as !== undefined) v.error(`${path}.as`, "applies to text messages only — a role panel is posted by the bot");
  const panel = message.rolePanel;
  const panelPath = `${path}.rolePanel`;
  if (!v.object(panel, panelPath)) return null;
  v.fields(panel, FIELDS.rolePanel, panelPath);

  const mode = panel.mode ?? "toggle";
  if (!PANEL_MODES.includes(mode)) v.error(`${panelPath}.mode`, `must be one of ${PANEL_MODES.join(", ")}`);
  // Панель-embed: текст іде в опис embed (4096), а не в content (2000);
  // `# Заголовок` першим рядком стає заголовком, як у текстах з файлів.
  const embed = parseEmbed(message.embed, `${path}.embed`, v);
  const maxText = embed ? MAX_EMBED_DESCRIPTION : MAX_CONTENT;
  if (panel.text !== undefined && (typeof panel.text !== "string" || !panel.text.trim() || panel.text.length > maxText)) {
    v.error(`${panelPath}.text`, `must be non-empty text up to ${maxText} characters`);
  }

  const roles = v.list(panel.roles ?? [], `${panelPath}.roles`).map((entry, i) => parsePanelRole(entry, roleKeys, `${panelPath}.roles[${i}]`, v));
  return { key, channelKey, kind: "rolePanel", panel: { mode, text: panel.text, embed, roles: roles.filter(Boolean) } };
}

/**
 * Персони: від чийого імені провіжн публікує текст — вебхук каналу з цим
 * ім'ям і аватаром, створений і керований самим провіжном.
 * @returns {Map<string, { key: string, name: string, avatar: string|null }>}
 */
function parsePersonas(raw, v) {
  const personas = new Map();
  if (raw === undefined) return personas;
  if (!v.object(raw, "personas")) return personas;
  for (const [key, persona] of Object.entries(raw)) {
    if (key.startsWith("_")) continue;
    const path = `personas.${key}`;
    if (!v.key(key, path) || !v.object(persona, path)) continue;
    v.fields(persona, FIELDS.persona, path);
    const name = typeof persona.name === "string" ? persona.name.trim() : "";
    if (!name || name.length > 80) v.error(`${path}.name`, "must be non-empty text up to 80 characters");
    else if (WEBHOOK_NAME_BANNED.some((word) => name.toLowerCase().includes(word))) {
      v.error(`${path}.name`, `Discord refuses webhook names containing ${WEBHOOK_NAME_BANNED.join(" or ")}`);
    }
    let avatar = null;
    if (persona.avatar !== undefined) {
      if (typeof persona.avatar === "string" && AVATAR_RE.test(persona.avatar)) avatar = persona.avatar;
      else v.error(`${path}.avatar`, "must be a .png, .jpg, .webp or .gif path inside src/config/discordapp/messages/");
    }
    personas.set(key, { key, name, avatar });
  }
  return personas;
}

function parseEmbed(embed, path, v) {
  if (embed === undefined || embed === false) return null;
  if (embed === true) return {};
  if (!v.object(embed, path)) return null;
  v.fields(embed, FIELDS.embed, path);
  const parsed = {};
  if (embed.title !== undefined) {
    if (typeof embed.title === "string" && embed.title.length <= 256) parsed.title = embed.title;
    else v.error(`${path}.title`, "must be text up to 256 characters");
  }
  if (embed.color !== undefined) {
    if (COLOR_RE.test(String(embed.color))) parsed.color = parseInt(embed.color.slice(1), 16);
    else v.error(`${path}.color`, 'must look like "#e67e22"');
  }
  return parsed;
}

/** Роль у панелі: "key" або { role, label?, emoji? }. */
function parsePanelRole(entry, roleKeys, path, v) {
  const spec = typeof entry === "string" ? { role: entry } : entry;
  if (!v.object(spec, path)) return null;
  v.fields(spec, FIELDS.panelRole, path);
  if (!roleKeys.has(spec.role)) {
    v.error(path, `unknown role key "${spec.role}"`);
    return null;
  }
  const parsed = { key: spec.role };
  if (spec.label !== undefined) {
    if (typeof spec.label === "string" && spec.label.trim() && spec.label.length <= 80) parsed.label = spec.label;
    else v.error(`${path}.label`, "must be text up to 80 characters");
  }
  if (spec.emoji !== undefined) {
    // Лише звичайні emoji: кастомні потребують id, який відрізняється між серверами.
    if (typeof spec.emoji === "string" && spec.emoji.length <= 16 && EMOJI_RE.test(spec.emoji)) parsed.emoji = spec.emoji;
    else v.error(`${path}.emoji`, "must be a plain emoji such as \"🦀\"");
  }
  return parsed;
}

/**
 * optIn: категорію бачать лише ті, хто має роль. { role, panel? } —
 * `panel` додає кнопку ролі в панель з цим key.
 */
function parseOptIn(optIn, roleKeys, path, v) {
  if (optIn === undefined) return null;
  if (!v.object(optIn, path)) return null;
  v.fields(optIn, FIELDS.optIn, path);
  if (!roleKeys.has(optIn.role)) {
    v.error(`${path}.role`, `unknown role key "${optIn.role}"`);
    return null;
  }
  return { roleKey: optIn.role, panelKey: optIn.panel ?? null, path };
}

/**
 * Overwrites категорії з optIn: @everyone не бачить (інші його біти
 * зберігаються), роль — бачить. Бот додається далі, як для будь-якого
 * приватного.
 */
function withOptIn(overwrites, roleKey) {
  const map = new Map(overwrites ?? []);
  const everyone = map.get("@everyone") ?? { allow: 0n, deny: 0n };
  map.set("@everyone", { allow: everyone.allow & ~VIEW_CHANNEL, deny: everyone.deny | VIEW_CHANNEL });
  const role = map.get(`role:${roleKey}`) ?? { allow: 0n, deny: 0n };
  map.set(`role:${roleKey}`, { allow: role.allow | VIEW_CHANNEL, deny: role.deny & ~VIEW_CHANNEL });
  return map;
}

function attachOptInsToPanels(optIns, messages, v) {
  for (const optIn of optIns) {
    if (!optIn.panelKey) continue;
    const panel = messages.find((message) => message.key === optIn.panelKey && message.kind === "rolePanel");
    if (!panel) {
      v.error(`${optIn.path}.panel`, `there is no rolePanel message with key "${optIn.panelKey}"`);
      continue;
    }
    if (!panel.panel.roles.some((entry) => entry.key === optIn.roleKey)) panel.panel.roles.push({ key: optIn.roleKey });
  }
}

/**
 * Панелі: не порожні, не більше 25 ролей, без повторів і без ролей з
 * небезпечними дозволами (D10). Роль, чиї дозволи конфіг не задає,
 * перевіряє planner — за її поточними дозволами на сервері.
 */
function checkPanelRoles(messages, roles, v) {
  const byKey = new Map(roles.map((role) => [role.key, role]));
  for (const message of messages) {
    if (message.kind !== "rolePanel") continue;
    const path = `rolePanel "${message.key}"`;
    const keys = message.panel.roles.map((entry) => entry.key);
    if (!keys.length) v.error(path, "has no roles");
    if (keys.length > MAX_PANEL_ROLES) v.error(path, `has ${keys.length} roles; a message holds at most ${MAX_PANEL_ROLES} buttons`);
    v.unique(keys, path, "role");
    for (const key of keys) {
      const permissions = byKey.get(key)?.permissions;
      const dangerous = permissions == null ? [] : dangerousIn(permissions);
      if (dangerous.length) v.error(path, `role "${key}" carries ${dangerous.join(", ")} and cannot be self-assigned`);
    }
  }
}

function parseRequires(requires, path, v) {
  if (requires === undefined) return null;
  if (requires === "community") return "community";
  v.error(path, 'the only supported value is "community"');
  return null;
}

// ── Overwrites ─────────────────────────────────────────────────────────────

function parsePresets(presets, v) {
  const result = new Map();
  if (presets === undefined) return result;
  if (!v.object(presets, "presets")) return result;
  for (const [name, spec] of Object.entries(presets)) {
    if (name.startsWith("_")) continue;
    // Пресет не посилається на інші пресети — щоб не було циклів і загадок.
    result.set(name, parseOverwriteObject(spec, `presets.${name}`, v));
  }
  return result;
}

/**
 * overwrites у конфігу: ім'я пресету, об'єкт або масив із них (пізніші
 * перемагають для тієї ж цілі). → Map<target, {allow, deny}> або null.
 */
function parseOverwriteSpec(spec, presets, roleKeys, path, v) {
  if (spec === undefined) return null;
  const parts = Array.isArray(spec) ? spec : [spec];
  let merged = new Map();
  for (const [i, part] of parts.entries()) {
    const partPath = Array.isArray(spec) ? `${path}[${i}]` : path;
    let map;
    if (typeof part === "string") {
      map = presets.get(part);
      if (!map) {
        v.error(partPath, `unknown preset "${part}"`);
        continue;
      }
    } else {
      map = parseOverwriteObject(part, partPath, v);
    }
    merged = mergeOverwrites(merged, map);
  }
  for (const target of merged.keys()) {
    if (target.startsWith("role:") && !roleKeys.has(target.slice(5))) {
      v.error(path, `"${target}" refers to a role that is not in "roles"`);
    }
  }
  return merged;
}

function parseOverwriteObject(spec, path, v) {
  const map = new Map();
  if (!v.object(spec, path)) return map;
  for (const [target, bits] of Object.entries(spec)) {
    if (target.startsWith("_")) continue;
    const targetPath = `${path}.${target}`;
    if (!TARGET_RE.test(target)) {
      v.error(targetPath, 'target must be "@everyone" or "role:<key>"');
      continue;
    }
    if (!v.object(bits, targetPath)) continue;
    v.fields(bits, FIELDS.overwrite, targetPath);
    const allow = bits.allow === undefined ? 0n : v.permissions(bits.allow, `${targetPath}.allow`);
    const deny = bits.deny === undefined ? 0n : v.permissions(bits.deny, `${targetPath}.deny`);
    if ((allow & deny) !== 0n) v.error(targetPath, "the same permission is both allowed and denied");
    map.set(target, { allow, deny });
  }
  return map;
}

/** Злиття двох Map overwrites: для однієї цілі перемагає `own`. null + null = null. */
function mergeOverwrites(base, own) {
  if (!base && !own) return null;
  return new Map([...(base ?? []), ...(own ?? [])]);
}

/**
 * Map → масив для бажаного стану. Якщо @everyone не бачить каналу, бот теж
 * перестане його бачити, щойно з нього знімуть Administrator, — тож бот
 * отримує свій overwrite автоматично, конфіг про це пам'ятати не мусить.
 */
function withBot(map) {
  if (!map) return null;
  const list = [...map].map(([target, bits]) => ({ target, ...bits }));
  const everyone = map.get("@everyone");
  if (everyone && (everyone.deny & VIEW_CHANNEL) !== 0n) {
    list.push({ target: "@bot", allow: BOT_CHANNEL_ALLOW, deny: 0n });
  }
  return list;
}

// ── Збирач помилок ─────────────────────────────────────────────────────────

class Validator {
  constructor() {
    this.errors = [];
  }

  error(path, message) {
    this.errors.push(`${path}: ${message}`);
  }

  object(value, path) {
    if (value && typeof value === "object" && !Array.isArray(value)) return true;
    this.error(path, "must be an object");
    return false;
  }

  /** Необов'язковий список: немає — порожній, не список — помилка і порожній. */
  list(value, path) {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    this.error(path, "must be a list");
    return [];
  }

  /** Невідоме поле — найчастіше опечатка, яка інакше тихо нічого б не робила. */
  fields(object, allowed, path) {
    for (const field of Object.keys(object)) {
      if (!field.startsWith("_") && !allowed.includes(field)) {
        this.error(`${path}.${field}`, `unknown field (allowed: ${allowed.join(", ")})`);
      }
    }
  }

  key(value, path) {
    if (typeof value === "string" && KEY_RE.test(value)) return value;
    this.error(path, "must be lowercase letters, digits and dashes, up to 40 characters");
    return null;
  }

  name(value, path) {
    if (typeof value === "string" && value.trim() && value.length <= 100) return value;
    this.error(path, "must be non-empty text up to 100 characters");
    return null;
  }

  /**
   * Необов'язковий id наявного ресурсу, який прийняти замість пошуку за назвою
   * (перейменування під час першого імпорту, однакові назви).
   */
  adopt(value, path) {
    if (value === undefined) return null;
    if (typeof value === "string" && SNOWFLAKE_RE.test(value)) return value;
    this.error(path, "must be the id of an existing resource, as a string of 17–20 digits");
    return null;
  }

  permissions(value, path) {
    if (!Array.isArray(value)) {
      this.error(path, 'must be a list of permission names, e.g. ["ViewChannel"]');
      return 0n;
    }
    const unknown = unknownPermissions(value);
    if (unknown.length) this.error(path, `unknown permission(s): ${unknown.join(", ")}`);
    return toBits(value);
  }

  unique(keys, path, what) {
    const seen = new Set();
    for (const key of keys) {
      if (key == null) continue;
      if (seen.has(key)) this.error(path, `duplicate ${what} "${key}"`);
      seen.add(key);
    }
  }
}

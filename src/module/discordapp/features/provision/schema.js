import { hasTextName, PROVISIONABLE_KINDS } from "../../channelKinds.js";
import { ARCHIVE_ROLE_ALLOW, BOT_CHANNEL_ALLOW, toBits, unknownPermissions, VIEW_CHANNEL } from "./permissions.js";

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
 *   { guildId, archive: { key, name, roleKeys },
 *     roles:      [{ key, name, color?, hoist?, mentionable?, permissions: BigInt|null }],
 *     categories: [{ key, name, overwrites, requires, isArchive }],   // архів — останній
 *     channels:   [{ key, name, kind, parentKey, topic?, nsfw?, slowmode?, overwrites, requires }] }
 *
 *   overwrites = null (не керуються) | [{ target, allow: BigInt, deny: BigInt }],
 *   target     = "@everyone" | "@bot" | "role:<key>"
 */

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const TARGET_RE = /^(@everyone|role:[a-z0-9][a-z0-9-]*)$/;

const FIELDS = {
  root: ["guildId", "archive", "presets", "roles", "categories", "channels"],
  archive: ["key", "name", "roles"],
  role: ["key", "name", "color", "hoist", "mentionable", "permissions"],
  category: ["key", "name", "overwrites", "requires", "channels"],
  channel: ["key", "name", "type", "topic", "nsfw", "slowmode", "overwrites", "requires"],
  overwrite: ["allow", "deny"],
};

// Ліміти Discord.
const MAX_ROLES = 250;
const MAX_CHANNELS_PER_CATEGORY = 50;
const MAX_TOPIC = 1024;
const MAX_SLOWMODE = 21_600;

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
  const roles = v.list(raw.roles, "roles").map((role, i) => parseRole(role, `roles[${i}]`, v));
  if (roles.length > MAX_ROLES) v.error("roles", `Discord allows at most ${MAX_ROLES} roles`);
  const roleKeys = new Set(roles.map((role) => role.key));
  v.unique(roles.map((role) => role.key), "roles", "role key");

  const archive = parseArchive(raw.archive, roleKeys, v);

  const categories = [];
  const channels = [];
  for (const [i, category] of v.list(raw.categories, "categories").entries()) {
    const path = `categories[${i}]`;
    if (!v.object(category, path)) continue;
    v.fields(category, FIELDS.category, path);
    const overwrites = parseOverwriteSpec(category.overwrites, presets, roleKeys, `${path}.overwrites`, v);
    const parsed = {
      key: v.key(category.key, `${path}.key`),
      name: v.name(category.name, `${path}.name`),
      overwrites: withBot(overwrites),
      requires: parseRequires(category.requires, `${path}.requires`, v),
      isArchive: false,
    };
    categories.push(parsed);

    const inner = v.list(category.channels, `${path}.channels`);
    if (inner.length > MAX_CHANNELS_PER_CATEGORY) {
      v.error(`${path}.channels`, `Discord allows at most ${MAX_CHANNELS_PER_CATEGORY} channels per category`);
    }
    for (const [j, channel] of inner.entries()) {
      channels.push(parseChannel(channel, parsed, overwrites, presets, roleKeys, `${path}.channels[${j}]`, v));
    }
  }
  for (const [i, channel] of v.list(raw.channels, "channels").entries()) {
    channels.push(parseChannel(channel, null, null, presets, roleKeys, `channels[${i}]`, v));
  }

  if (archive) categories.push(archive.category);
  v.unique([...categories, ...channels].map((item) => item.key), "categories/channels", "key");

  if (v.errors.length) return { errors: v.errors, desired: null };
  return {
    errors: [],
    desired: {
      guildId: String(raw.guildId),
      archive: { key: archive.category.key, name: archive.category.name, roleKeys: archive.roleKeys },
      roles,
      categories,
      channels: channels.filter(Boolean),
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
  const parsed = { key: v.key(role.key, `${path}.key`), name: v.name(role.name, `${path}.name`), permissions: null };

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

import { createHash } from "crypto";
import { dangerousIn, describeBitsChange, KNOWN_PERMISSIONS } from "./permissions.js";
import { diffOverwrites, managedTargetIds, resolveOverwrites } from "./overwrites.js";
import { hashPayload, renderMessage } from "./messages.js";
import { planAutomod } from "./automod.js";

/**
 * Планувальник провіжну: (бажаний стан, поточний сервер, стан) → план.
 * Чиста функція — нічого не читає і не пише; applier виконує план,
 * `/provision plan` його показує.
 *
 *   desired — schema.js; current — readGuild.js; state — рядки discord_resources.
 *
 * Операції (docs/DISCORDAPP.md, «Plan and apply»):
 *   create · update · adopt (прийняти наявне за назвою, далі — як update)
 *   archive (прибраний з конфігу канал → в архів) · restore (з архіву назад)
 *   reorder (порядок ролей / каналів) · forget (канал видалено вручну — лише стан)
 *   skip (ресурс лише для Community на звичайному сервері)
 *   orphaned (роль/категорія/повідомлення зникли з конфігу — лишаються як є)
 *   post · edit (повідомлення: опублікувати / відредагувати на місці)
 *   hide · keep (archiveUnmanaged: рукотворна категорія стає приватною;
 *                системний канал лишається на місці)
 *
 * **Нічого не видаляється.** Видалення в плані немає як операції взагалі.
 *
 * @returns {{ guildId, guildName, errors: string[], warnings: string[], ops: object[],
 *   unmanaged: { roles: string[], categories: string[], channels: string[] }, context: object }}
 */
export function planProvision(desired, current, state) {
  const plan = {
    guildId: current.guildId,
    guildName: current.name,
    errors: [],
    warnings: [],
    ops: [],
    // Не з конфігу. archived / hidden — те, що вже прибране з очей: канали в
    // архіві й категорії з правами архіву (archiveUnmanaged), окремо від того,
    // що лежить як лежало.
    unmanaged: { roles: [], categories: [], channels: [], automod: [], archived: [], hidden: [] },
  };

  if (desired.guildId !== current.guildId) {
    plan.errors.push(`The config is for server ${desired.guildId}, not this one (${current.guildId}).`);
    return { ...plan, context: null };
  }

  const context = {
    everyoneId: current.everyoneId,
    bot: current.bot.roleId ? { id: current.bot.roleId, type: "role" } : { id: current.bot.userId, type: "member" },
    roleIds: new Map(),
    roleNames: new Map(desired.roles.map((role) => [role.key, role.name])),
    categoryIds: new Map(),
    channelIds: new Map(),
    archiveCategoryIds: [],
  };
  const stateOf = indexState(state);

  planRoles(desired, current, stateOf, context, plan);
  planCategories(desired, current, stateOf, context, plan);
  planChannels(desired, current, stateOf, context, plan);
  if (desired.archiveUnmanaged) planUnmanagedArchive(desired, current, stateOf, context, plan);
  planOrder(desired, current, context, plan);
  planMessages(desired, current, stateOf, context, plan);
  planAutomod(desired, current, stateOf, context, plan);
  collectUnmanaged(desired, current, state, context, plan);

  return { ...plan, context };
}

// ── Ролі ───────────────────────────────────────────────────────────────────

function planRoles(desired, current, stateOf, context, plan) {
  const byId = new Map(current.roles.map((role) => [role.id, role]));
  const claimed = new Set(stateOf.ids("role"));
  const wanted = new Set(desired.roles.map((role) => role.key));

  for (const role of desired.roles) {
    const saved = stateOf.get("role", role.key);
    let have = saved && byId.get(saved.discord_id);
    let op = "update";

    if (!have) {
      const byName = current.roles.filter((r) => !r.managed && r.name === role.name && !claimed.has(r.id));
      if (byName.length > 1) {
        plan.errors.push(`${byName.length} roles are named "${role.name}" — rename all but one so the config can adopt it.`);
        continue;
      }
      have = byName[0];
      op = "adopt";
    }

    if (!have) {
      plan.ops.push({ phase: "roles", op: "create", kind: "role", key: role.key, name: role.name, spec: role });
      continue;
    }

    claimed.add(have.id);
    context.roleIds.set(role.key, have.id);
    if (have.position >= current.bot.highestPosition) {
      plan.errors.push(`Role "${have.name}" is at or above the bot's highest role — move the bot's role above it in Server Settings → Roles.`);
    }
    const changes = diffRole(role, have);
    if (op === "adopt" || changes.length) {
      plan.ops.push({ phase: "roles", op, kind: "role", key: role.key, name: role.name, id: have.id, changes, spec: role });
    }
  }

  for (const saved of stateOf.all("role")) {
    const have = byId.get(saved.discord_id);
    if (!wanted.has(saved.key) && have) {
      plan.ops.push({ phase: "report", op: "orphaned", kind: "role", key: saved.key, name: have.name, id: have.id });
    }
  }
}

function diffRole(want, have) {
  const changes = [];
  if (want.name !== have.name) changes.push(`name "${have.name}" → "${want.name}"`);
  if (want.color !== undefined && want.color !== have.color) changes.push(`color ${hex(have.color)} → ${hex(want.color)}`);
  if (want.hoist !== undefined && want.hoist !== have.hoist) changes.push(`hoist → ${want.hoist}`);
  if (want.mentionable !== undefined && want.mentionable !== have.mentionable) changes.push(`mentionable → ${want.mentionable}`);
  const known = have.permissions & KNOWN_PERMISSIONS;
  if (want.permissions !== null && want.permissions !== known) {
    changes.push(`permissions ${describeBitsChange(known, want.permissions)}`);
  }
  return changes;
}

// ── Категорії ──────────────────────────────────────────────────────────────

function planCategories(desired, current, stateOf, context, plan) {
  const categories = current.channels.filter((channel) => channel.kind === "category");
  const byId = new Map(categories.map((category) => [category.id, category]));
  const claimed = new Set(stateOf.ids("category"));
  const wanted = new Set(desired.categories.map((category) => category.key));
  const isOverflow = (key) => key.startsWith(`${desired.archive.key}-`) && /^\d+$/.test(key.slice(desired.archive.key.length + 1));

  for (const category of desired.categories) {
    if (category.requires === "community" && !current.community) {
      plan.ops.push({ phase: "report", op: "skip", kind: "category", key: category.key, name: category.name });
      continue;
    }
    const saved = stateOf.get("category", category.key);
    let have = saved && byId.get(saved.discord_id);
    let op = "update";
    if (!have) {
      const byName = categories.filter((c) => c.name === category.name && !claimed.has(c.id));
      if (byName.length > 1) {
        plan.errors.push(`${byName.length} categories are named "${category.name}" — rename all but one.`);
        continue;
      }
      have = byName[0];
      op = "adopt";
    }

    if (!have) {
      plan.ops.push({ phase: "categories", op: "create", kind: "category", key: category.key, name: category.name, spec: category });
      continue;
    }
    claimed.add(have.id);
    context.categoryIds.set(category.key, have.id);
    if (category.isArchive) context.archiveCategoryIds.push(have.id);

    const changes = [...diffName(category, have), ...diffPermissions(category, have, context)];
    if (op === "adopt" || changes.length) {
      plan.ops.push({ phase: "categories", op, kind: "category", key: category.key, name: category.name, id: have.id, changes, spec: category });
    }
  }

  for (const saved of stateOf.all("category")) {
    const have = byId.get(saved.discord_id);
    if (!have || wanted.has(saved.key)) continue;
    if (isOverflow(saved.key)) {
      // Додаткова архівна категорія (архів переповнився) — частина архіву.
      context.archiveCategoryIds.push(have.id);
      context.categoryIds.set(saved.key, have.id);
      continue;
    }
    plan.ops.push({ phase: "report", op: "orphaned", kind: "category", key: saved.key, name: have.name, id: have.id });
  }
}

// ── Канали ─────────────────────────────────────────────────────────────────

const COMMUNITY_KINDS = ["announcement", "stage"];

function planChannels(desired, current, stateOf, context, plan) {
  const channels = current.channels.filter((channel) => channel.kind !== "category");
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const claimed = new Set(stateOf.ids("channel"));
  const wanted = new Set(desired.channels.map((channel) => channel.key));

  for (const channel of desired.channels) {
    if (channel.requires === "community" && !current.community) {
      plan.ops.push({ phase: "report", op: "skip", kind: "channel", key: channel.key, name: channel.name });
      continue;
    }
    if (COMMUNITY_KINDS.includes(channel.kind) && !current.community) {
      plan.errors.push(
        `#${channel.name} is a ${channel.kind} channel, which needs a Community server. ` +
          'Add "requires": "community" to skip it on this server.',
      );
      continue;
    }

    const parentId = channel.parentKey ? context.categoryIds.get(channel.parentKey) ?? null : null;
    const saved = stateOf.get("channel", channel.key);
    let have = saved && byId.get(saved.discord_id);
    let op = saved?.archived_at && have ? "restore" : "update";

    if (!have) {
      const candidates = channels.filter((c) => c.name === channel.name && compatibleKinds(c.kind, channel.kind) && !claimed.has(c.id));
      const preferred = candidates.filter((c) => c.parentId === parentId);
      const pool = preferred.length ? preferred : candidates;
      if (pool.length > 1) {
        plan.errors.push(`${pool.length} channels are named #${channel.name} — rename all but one so the config can adopt it.`);
        continue;
      }
      have = pool[0];
      op = "adopt";
    }

    if (!have) {
      plan.ops.push({ phase: "channels", op: "create", kind: "channel", key: channel.key, name: channel.name, spec: channel });
      continue;
    }
    claimed.add(have.id);
    context.channelIds.set(channel.key, have.id);

    if (!compatibleKinds(have.kind, channel.kind)) {
      plan.errors.push(`#${have.name} is a ${have.kind} channel; the config says ${channel.kind}. Discord cannot convert it — give the config entry a new key to create a fresh one.`);
      continue;
    }
    const changes = diffChannel(channel, have, parentId, current, context);
    if (op !== "update" || changes.length) {
      plan.ops.push({ phase: "channels", op, kind: "channel", key: channel.key, name: channel.name, id: have.id, changes, spec: channel });
    }
  }

  for (const saved of stateOf.all("channel")) {
    if (wanted.has(saved.key)) continue;
    const have = byId.get(saved.discord_id);
    if (!have) {
      plan.ops.push({ phase: "state", op: "forget", kind: "channel", key: saved.key, name: saved.key });
    } else if (!saved.archived_at) {
      // Зі стану, а не з конфігу: категорію могли прибрати з конфігу разом з каналом.
      const parentKey = stateOf.all("category").find((row) => row.discord_id === have.parentId)?.key ?? null;
      plan.ops.push({ phase: "channels", op: "archive", kind: "channel", channelKind: have.kind, key: saved.key, name: have.name, id: have.id, parentKey });
    }
  }
}

function compatibleKinds(a, b) {
  const convertible = ["text", "announcement"];
  return a === b || (convertible.includes(a) && convertible.includes(b));
}

function diffChannel(want, have, parentId, current, context) {
  const changes = diffName(want, have);
  if (want.kind !== have.kind) changes.push(`type ${have.kind} → ${want.kind}`);

  const parentPending = want.parentKey && !parentId;
  if (parentPending || (parentId ?? null) !== (have.parentId ?? null)) {
    changes.push(`category ${categoryLabel(have.parentId, current)} → ${want.parentKey ? `"${want.parentKey}"` : "none"}`);
  }
  if (want.topic !== undefined && want.topic !== (have.topic ?? "")) changes.push("topic");
  if (want.nsfw !== undefined && want.nsfw !== have.nsfw) changes.push(`nsfw → ${want.nsfw}`);
  if (want.slowmode !== undefined && want.slowmode !== have.slowmode) changes.push(`slowmode ${have.slowmode}s → ${want.slowmode}s`);
  changes.push(...diffPermissions(want, have, context));
  return changes;
}

function diffName(want, have) {
  return want.name === have.name ? [] : [`name "${have.name}" → "${want.name}"`];
}

/** Overwrites категорії чи каналу; null у конфігу — не керуються. */
function diffPermissions(want, have, context) {
  if (!want.overwrites) return [];
  const labelOf = (id) => labelForId(id, context);
  return diffOverwrites(resolveOverwrites(want.overwrites, context), have.overwrites, managedTargetIds(context), labelOf)
    .map((change) => `permissions ${change.label}: ${change.detail}`);
}

// ── archiveUnmanaged ───────────────────────────────────────────────────────

/**
 * `archiveUnmanaged: true` — прибрати з очей усе, що створено вручну, не
 * видаляючи: канал поза конфігом і станом переїжджає в архів, як канал,
 * прибраний з конфігу; категорія (у категорію її не вкласти) отримує права
 * архіву й зникає для учасників. Системні канали сервера лишаються на
 * місці — разом з категорією, де лежать.
 *
 * У стан нічого не пишеться: такий канал і далі «не з конфігу», а повернути
 * його можна, додавши в конфіг — план прийме його за назвою.
 */
function planUnmanagedArchive(desired, current, stateOf, context, plan) {
  const special = new Set(current.specialChannelIds ?? []);
  const managed = new Set([
    ...context.channelIds.values(),
    ...context.categoryIds.values(),
    ...stateOf.ids("channel"),
    ...stateOf.ids("category"),
  ]);
  const inArchive = (channel) => context.archiveCategoryIds.includes(channel.parentId);
  const categoryName = (id) => current.channels.find((c) => c.id === id)?.name ?? null;

  for (const channel of current.channels) {
    if (channel.kind === "category" || managed.has(channel.id) || inArchive(channel)) continue;
    const base = { kind: "channel", channelKind: channel.kind, key: `unmanaged:${channel.id}`, name: channel.name, id: channel.id, unmanaged: true };
    if (special.has(channel.id)) {
      plan.ops.push({ ...base, phase: "report", op: "keep" });
    } else {
      plan.ops.push({ ...base, phase: "channels", op: "archive", parentKey: categoryName(channel.parentId) });
    }
  }

  for (const category of current.channels.filter((c) => c.kind === "category")) {
    if (managed.has(category.id) || context.archiveCategoryIds.includes(category.id)) continue;
    const holdsSpecial = current.channels.some((c) => c.parentId === category.id && special.has(c.id));
    if (holdsSpecial) continue;
    if (!hiddenLikeArchive(category, desired, context)) {
      plan.ops.push({ phase: "channels", op: "hide", kind: "category", key: `unmanaged:${category.id}`, name: category.name, id: category.id, unmanaged: true });
    }
  }
}

/**
 * Чи має категорія рівно права архіву — тобто вже прихована. Порівняння
 * точне: у прихованої категорії не лишається нічиїх overwrites, крім архівних.
 */
function hiddenLikeArchive(category, desired, context) {
  const archiveSpec = desired.categories.find((c) => c.isArchive);
  const { resolved, pending } = resolveOverwrites(archiveSpec.overwrites, context);
  if (pending.length) return false;
  const everyone = new Set([...category.overwrites.map((ow) => ow.id), ...resolved.map((ow) => ow.id)]);
  return diffOverwrites({ resolved, pending: [] }, category.overwrites, everyone, (id) => id).length === 0;
}

// ── Порядок ────────────────────────────────────────────────────────────────

function planOrder(desired, current, context, plan) {
  const createdRoles = plan.ops.some((op) => op.kind === "role" && op.op === "create");
  if (createdRoles || roleOrderPositions(desired, current, context).length) {
    plan.ops.push({ phase: "order", op: "reorder", kind: "role", key: "roles", name: "roles" });
  }

  const moved = plan.ops.some((op) => ["create", "restore", "archive"].includes(op.op) && ["channel", "category"].includes(op.kind))
    || plan.ops.some((op) => op.changes?.some((change) => change.startsWith("category ")));
  if (moved || channelOrderPositions(desired, current, context).length) {
    plan.ops.push({ phase: "order", op: "reorder", kind: "channel", key: "channels", name: "categories and channels" });
  }
}

/**
 * Позиції ролей за конфігом: верх списку — найвища. Ролі займають ті самі
 * «слоти» (позиції), що й зараз, лише в новому порядку — тож відносно ролей
 * поза конфігом нічого не зсувається.
 * @returns {{ id: string, position: number }[]}  Лише ті, що змінюються.
 */
export function roleOrderPositions(desired, current, context) {
  const byId = new Map(current.roles.map((role) => [role.id, role]));
  const ordered = desired.roles.map((role) => byId.get(context.roleIds.get(role.key))).filter(Boolean);
  const slots = ordered.map((role) => role.position).sort((a, b) => b - a);
  return ordered
    .map((role, i) => ({ id: role.id, position: slots[i] }))
    .filter(({ id, position }) => byId.get(id).position !== position);
}

/**
 * Позиції категорій і каналів за конфігом, тим самим способом слотів:
 * категорії між собою, канали — всередині своєї категорії. Архів — останній.
 * @returns {{ id: string, position: number }[]}
 */
export function channelOrderPositions(desired, current, context) {
  const byId = new Map(current.channels.map((channel) => [channel.id, channel]));
  const groups = [desired.categories.map((category) => context.categoryIds.get(category.key))];
  for (const parentKey of [null, ...desired.categories.map((category) => category.key)]) {
    groups.push(desired.channels
      .filter((channel) => channel.parentKey === parentKey)
      .map((channel) => context.channelIds.get(channel.key)));
  }

  const result = [];
  for (const ids of groups) {
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    // Канал, що саме переїжджає, ще в чужій категорії — його слот там не рахується.
    const slots = ordered.map((channel) => channel.position).sort((a, b) => a - b);
    ordered.forEach((channel, i) => {
      if (channel.position !== slots[i]) result.push({ id: channel.id, position: slots[i] });
    });
  }
  return result;
}

// ── Повідомлення ───────────────────────────────────────────────────────────

/**
 * Повідомлення порівнюються за хешем payload у стані — читати їхній текст
 * не треба. Відредаговане повідомлення лишається на своєму місці; нове
 * додається в кінець каналу (Discord не вставляє між наявними).
 *
 * **Повідомлення теж не видаляються.** Прибране з конфігу — orphaned;
 * перенесене в інший канал — публікується там, стара копія лишається.
 */
function planMessages(desired, current, stateOf, context, plan) {
  const existing = new Set((current.messages ?? []).map((message) => message.id));
  const skippedChannels = new Set(plan.ops.filter((op) => op.op === "skip").map((op) => op.key));
  const wanted = new Set(desired.messages.map((message) => message.key));
  const channelName = (key) => desired.channels.find((channel) => channel.key === key)?.name ?? key;

  checkPanelRoles(desired, current, context, plan);

  for (const message of desired.messages) {
    if (skippedChannels.has(message.channelKey)) {
      plan.ops.push({ phase: "report", op: "skip", kind: "message", key: message.key, name: message.key });
      continue;
    }
    const { payload, pending } = renderMessage(message, context);
    const hash = pending.length ? null : hashPayload(payload);
    const channelId = context.channelIds.get(message.channelKey) ?? null;
    const saved = stateOf.get("message", message.key);
    const base = { phase: "messages", kind: "message", key: message.key, name: message.key, channel: channelName(message.channelKey), spec: message };
    const changes = pending.length ? [`buttons for ${pending.map((key) => `@${context.roleNames.get(key)}`).join(", ")} once the roles exist`] : [];

    if (!saved) {
      plan.ops.push({ ...base, op: "post", changes });
    } else if (!existing.has(saved.discord_id)) {
      plan.ops.push({ ...base, op: "post", changes: ["the posted copy was deleted — posting it again", ...changes] });
    } else if (channelId && saved.parent_id !== channelId) {
      plan.ops.push({ ...base, op: "post", changes: ["moved to another channel — the old copy stays where it is", ...changes] });
    } else if (hash !== saved.content_hash) {
      plan.ops.push({ ...base, op: "edit", id: saved.discord_id, changes: changes.length ? changes : [message.kind === "rolePanel" ? "panel" : `text of ${message.file}`] });
    }
  }

  for (const saved of stateOf.all("message")) {
    if (!wanted.has(saved.key) && existing.has(saved.discord_id)) {
      plan.ops.push({ phase: "report", op: "orphaned", kind: "message", key: saved.key, name: saved.key });
    }
  }
}

/**
 * Ролі панелей за їхнім станом на сервері (D10): schema.js бачить лише
 * дозволи, задані в конфігу, а роль могла отримати небезпечні вручну.
 */
function checkPanelRoles(desired, current, context, plan) {
  const byId = new Map(current.roles.map((role) => [role.id, role]));
  const checked = new Set();
  for (const message of desired.messages) {
    if (message.kind !== "rolePanel") continue;
    for (const { key } of message.panel.roles) {
      if (checked.has(key)) continue;
      checked.add(key);
      const spec = desired.roles.find((role) => role.key === key);
      const have = byId.get(context.roleIds.get(key));
      // Дозволи, задані конфігом, перевірив schema.js, і apply їх поставить.
      if (!have || spec?.permissions != null) continue;
      const dangerous = dangerousIn(have.permissions);
      if (dangerous.length) {
        plan.errors.push(`@${have.name} is on a role panel but carries ${dangerous.join(", ")} — anyone could take it. Remove those permissions or the role from the panel.`);
      }
    }
  }
}

// ── Некероване ─────────────────────────────────────────────────────────────

function collectUnmanaged(desired, current, state, context, plan) {
  const managed = new Set([
    ...state.map((row) => row.discord_id),
    ...context.roleIds.values(),
    ...context.categoryIds.values(),
    ...context.channelIds.values(),
    // archiveUnmanaged: те, що саме ховається, окремим рядком «не чіпається» не є.
    ...plan.ops.filter((op) => op.unmanaged).map((op) => op.id),
  ]);
  for (const role of current.roles) {
    if (!role.managed && !managed.has(role.id)) plan.unmanaged.roles.push(role.name);
  }
  for (const channel of current.channels) {
    if (managed.has(channel.id)) continue;
    if (channel.kind === "category") {
      (hiddenLikeArchive(channel, desired, context) ? plan.unmanaged.hidden : plan.unmanaged.categories).push(channel.name);
    } else {
      if (context.archiveCategoryIds.includes(channel.parentId)) plan.unmanaged.archived.push({ name: channel.name, kind: channel.kind });
      else plan.unmanaged.channels.push(channel.name);
    }
  }
}

// ── Відбиток плану ─────────────────────────────────────────────────────────

/**
 * Короткий відбиток операцій. Кнопка «Apply» несе його в customId: якщо між
 * показом плану і натисканням сервер або конфіг змінились, план уже інший —
 * і застосовувати те, чого людина не бачила, не можна.
 */
export function planFingerprint(plan) {
  const essence = plan.ops
    .filter((op) => op.phase !== "report")
    .map((op) => [op.op, op.kind, op.key, op.id ?? "", ...(op.changes ?? [])].join("|"));
  return createHash("sha1").update(essence.join("\n")).digest("hex").slice(0, 10);
}

/**
 * Що заважає apply, навіть коли план без помилок (preflight). Discord не дає
 * боту поставити в overwrite дозвіл, якого бот не має сам, тож apply
 * виконується лише з Administrator (docs/DISCORDAPP.md, модель прав).
 * @returns {string[]}
 */
export function applyBlockers(current) {
  if (current.bot.admin) return [];
  return [
    'The bot needs Administrator to apply. Give it a role with Administrator (e.g. "Inemuri Setup"), ' +
      "run apply, then take the role away.",
  ];
}

/** Операції, які щось змінюють (не звіт). */
export function actionableOps(plan) {
  return plan.ops.filter((op) => op.phase !== "report");
}

// ── Дрібниці ───────────────────────────────────────────────────────────────

function indexState(rows) {
  return {
    get: (kind, key) => rows.find((row) => row.kind === kind && row.key === key) ?? null,
    all: (kind) => rows.filter((row) => row.kind === kind),
    ids: (kind) => rows.filter((row) => row.kind === kind).map((row) => row.discord_id),
  };
}

function keyOf(map, id) {
  for (const [key, value] of map) if (value === id) return key;
  return null;
}

function labelForId(id, context) {
  if (id === context.everyoneId) return "@everyone";
  if (id === context.bot.id) return "@bot";
  const key = keyOf(context.roleIds, id);
  return key ? `@${context.roleNames.get(key)}` : id;
}

function categoryLabel(id, current) {
  if (!id) return "none";
  const category = current.channels.find((channel) => channel.id === id);
  return category ? `"${category.name}"` : id;
}

function hex(color) {
  return `#${(color ?? 0).toString(16).padStart(6, "0")}`;
}

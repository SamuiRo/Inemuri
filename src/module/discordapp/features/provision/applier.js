import { OverwriteType } from "discord.js";
import { channelType } from "../../channelKinds.js";
import { readGuild } from "./readGuild.js";
import { channelOrderPositions, planProvision, roleOrderPositions } from "./planner.js";
import { finalOverwrites, managedTargetIds, resolveOverwrites } from "./overwrites.js";
import { hashPayload, renderMessage } from "./messages.js";
import { automodOptions } from "./automod.js";
import { KNOWN_PERMISSIONS } from "./permissions.js";
import { DiscordResource } from "../../../teapot/models/index.js";
import { print } from "../../../../shared/utils.js";

// Показується в журналі аудиту Discord біля кожної зміни.
const REASON = "Inemuri provisioning";
// Ліміт Discord на кількість каналів у категорії.
const CATEGORY_CAPACITY = 50;
// Провіжн-повідомлення нікого не пінгують: "@everyone" у тексті правил — це
// текст, а не сповіщення всьому серверу на кожну правку.
const NO_MENTIONS = { parse: [] };

/**
 * Застосування плану провіжну (docs/DISCORDAPP.md, «Plan and apply»).
 *
 * Фази йдуть по черзі, і **кожна знімає сервер і стан наново й перераховує
 * план** (planner чистий і детермінований). Тож у фазі каналів уже відомі id
 * ролей і категорій, створених щойно, а повторний запуск після збою просто
 * продовжує з того, що лишилось: зроблене вже не з'являється в плані.
 *
 * Збій однієї операції записується в журнал і не зупиняє решту фази —
 * незалежні зміни не повинні чекати на одну невдалу.
 *
 * @param {object} options
 * @param {import("discord.js").Guild} options.guild
 * @param {object} options.desired            schema.js
 * @param {(phase: string) => void} [options.onPhase]
 * @param {(guild) => Promise<object>} [options.read]  Знімок сервера; в тестах — підробка.
 * @param {object} [options.store]                    Стан (DiscordResource); в тестах — у пам'яті.
 * @returns {Promise<{ ok: boolean, text: string }[]>}  Журнал: що зроблено і що ні.
 */
export async function applyProvision({ guild, desired, onPhase = () => {}, read = readGuild, store = DiscordResource }) {
  const log = [];
  for (const phase of PHASES) {
    onPhase(phase.name);
    const state = await store.forGuild(guild.id);
    const current = await read(guild, state);
    const plan = planProvision(desired, current, state);
    if (plan.errors.length) {
      log.push(...plan.errors.map((error) => ({ ok: false, text: error })));
      log.push({ ok: false, text: `Stopped before "${phase.name}".` });
      break;
    }
    await phase.run({ guild, desired, current, plan, log, store });
  }
  print(`[DISCORDAPP] Provisioned ${guild.name}: ${log.filter((e) => e.ok).length} ok, ${log.filter((e) => !e.ok).length} failed`);
  return log;
}

const PHASES = [
  { name: "roles", run: (ctx) => runOps(ctx, "roles", applyRoleOp) },
  { name: "role order", run: applyRoleOrder },
  { name: "categories", run: (ctx) => runOps(ctx, "categories", applyCategoryOp) },
  { name: "channels", run: (ctx) => runOps(ctx, "channels", applyChannelOp) },
  { name: "channel order", run: applyChannelOrder },
  { name: "automod", run: (ctx) => runOps(ctx, "automod", applyAutomodOp) },
  { name: "messages", run: (ctx) => runOps(ctx, "messages", applyMessageOp) },
  { name: "state", run: (ctx) => runOps(ctx, "state", applyStateOp) },
];

async function runOps(ctx, phase, apply) {
  for (const op of ctx.plan.ops.filter((o) => o.phase === phase)) {
    const label = opLabel(op);
    try {
      await apply(op, ctx);
      ctx.log.push({ ok: true, text: label });
    } catch (error) {
      ctx.log.push({ ok: false, text: `${label}: ${error.message}` });
    }
  }
}

function opLabel(op) {
  if (op.kind === "message") return `${op.op} 💬 ${op.name} in #${op.channel}`;
  if (op.kind === "automod") return `${op.op} ⛔ ${op.name}`;
  const prefix = { role: "@", category: "📁 ", channel: "#" }[op.kind] ?? "";
  return `${op.op} ${prefix}${op.name}`;
}

// ── Ролі ───────────────────────────────────────────────────────────────────

async function applyRoleOp(op, { guild, current, store }) {
  const fields = roleFields(op.spec, current.roles.find((role) => role.id === op.id));
  if (op.op === "create") {
    const role = await guild.roles.create({ ...fields, reason: REASON });
    await store.remember(guild.id, "role", op.key, role.id);
    return;
  }
  // adopt: спершу стан — навіть якщо правка впаде, роль уже керована.
  if (op.op === "adopt") await store.remember(guild.id, "role", op.key, op.id);
  if (op.changes.length) await guild.roles.edit(op.id, { ...fields, reason: REASON });
}

/**
 * Поля ролі для Discord: лише задані в конфігу (schema.js). Біти прав, яких
 * discord.js не знає, беруться з поточної ролі — конфіг їх не виражає, і
 * запис не повинен їх стирати. Чиста функція.
 */
export function roleFields(spec, have = null) {
  const fields = { name: spec.name };
  if (spec.color !== undefined) fields.colors = { primaryColor: spec.color };
  if (spec.hoist !== undefined) fields.hoist = spec.hoist;
  if (spec.mentionable !== undefined) fields.mentionable = spec.mentionable;
  if (spec.permissions !== null) {
    fields.permissions = spec.permissions | ((have?.permissions ?? 0n) & ~KNOWN_PERMISSIONS);
  }
  return fields;
}

async function applyRoleOrder({ guild, desired, current, plan, log }) {
  const positions = roleOrderPositions(desired, current, plan.context);
  if (!positions.length) return;
  try {
    await guild.roles.setPositions(positions.map(({ id, position }) => ({ role: id, position })));
    log.push({ ok: true, text: `reorder ${positions.length} role(s)` });
  } catch (error) {
    log.push({ ok: false, text: `reorder roles: ${error.message}` });
  }
}

// ── Категорії ──────────────────────────────────────────────────────────────

async function applyCategoryOp(op, { guild, current, plan, store }) {
  const have = current.channels.find((channel) => channel.id === op.id);
  const overwrites = explicitOverwrites(op.spec, have?.overwrites ?? [], plan.context);
  if (op.op === "create") {
    const category = await guild.channels.create({
      name: op.spec.name,
      type: channelType("category"),
      ...(overwrites && { permissionOverwrites: overwrites }),
      reason: REASON,
    });
    await store.remember(guild.id, "category", op.key, category.id);
    return;
  }
  if (op.op === "adopt") await store.remember(guild.id, "category", op.key, op.id);
  if (op.changes.length) {
    await guild.channels.edit(op.id, { name: op.spec.name, ...(overwrites && { permissionOverwrites: overwrites }), reason: REASON });
  }
}

// ── Канали ─────────────────────────────────────────────────────────────────

async function applyChannelOp(op, ctx) {
  if (op.op === "archive") return archiveChannel(op, ctx);

  const { guild, current, plan, store } = ctx;
  const spec = op.spec;
  const parentId = spec.parentKey ? plan.context.categoryIds.get(spec.parentKey) : null;
  if (spec.parentKey && !parentId) throw new Error(`category "${spec.parentKey}" does not exist — it failed to create`);

  if (op.op === "create") {
    const overwrites = explicitOverwrites(spec, [], plan.context);
    const channel = await guild.channels.create({
      ...channelFields(spec),
      type: channelType(spec.kind),
      parent: parentId,
      // Без власних overwrites Discord синхронізує новий канал з категорією.
      ...(overwrites && { permissionOverwrites: overwrites }),
      reason: REASON,
    });
    await store.remember(guild.id, "channel", op.key, channel.id);
    return;
  }

  if (op.op === "adopt") await store.remember(guild.id, "channel", op.key, op.id);
  if (!op.changes.length && op.op !== "restore") return;

  const have = current.channels.find((channel) => channel.id === op.id);
  await guild.channels.edit(op.id, {
    ...channelFields(spec),
    ...(spec.kind !== have.kind && { type: channelType(spec.kind) }),
    parent: parentId,
    ...permissionEdit(op, spec, have, parentId, plan.context),
    reason: REASON,
  });
  // restore: знімає позначку архіву.
  if (op.op === "restore") await store.remember(guild.id, "channel", op.key, op.id);
}

/** Поля каналу для Discord: лише задані в конфігу. Чиста функція. */
export function channelFields(spec) {
  const fields = { name: spec.name };
  if (spec.topic !== undefined) fields.topic = spec.topic;
  if (spec.nsfw !== undefined) fields.nsfw = spec.nsfw;
  if (spec.slowmode !== undefined) fields.rateLimitPerUser = spec.slowmode;
  return fields;
}

/**
 * Що робити з overwrites при редагуванні каналу. Чиста функція.
 *  - конфіг задає overwrites → записати їх (плюс збережені некеровані);
 *  - канал повертається з архіву або переїжджає в іншу категорію, а конфіг
 *    overwrites не задає → синхронізувати з новою категорією, як це робить
 *    Discord при перетягуванні; без категорії — зняти керовані (архівні);
 *  - інакше — не чіпати.
 */
export function permissionEdit(op, spec, have, parentId, context) {
  const explicit = explicitOverwrites(spec, have.overwrites, context);
  if (explicit) return { permissionOverwrites: explicit };

  const moves = op.op === "restore" || (parentId ?? null) !== (have.parentId ?? null);
  if (!moves) return {};
  if (parentId) return { lockPermissions: true };
  return { permissionOverwrites: toDiscordOverwrites(finalOverwrites([], have.overwrites, managedTargetIds(context))) };
}

/**
 * Канал з конфігу зник — переносимо в архів і синхронізуємо з правами
 * архіву: колишні учасники його більше не бачать, але історія ціла.
 */
async function archiveChannel(op, ctx) {
  const archiveId = await archiveWithSpace(ctx);
  await ctx.guild.channels.edit(op.id, { parent: archiveId, lockPermissions: true, reason: REASON });
  await ctx.store.markArchived(ctx.guild.id, op.key, op.parentKey);
}

/**
 * Архівна категорія, де ще є місце. Коли всі заповнені (50 каналів) —
 * створює наступну, "<name> 2", з тими самими правами. Заповненість
 * рахується на всю фазу: кілька архівувань поспіль бачать одне одного.
 */
async function archiveWithSpace(ctx) {
  const { guild, desired, current, plan, store } = ctx;
  const ids = plan.context.archiveCategoryIds;
  if (!ids.length) throw new Error("the archive category does not exist — it failed to create");

  ctx.archiveUsage ??= new Map(ids.map((id) => [id, current.channels.filter((c) => c.parentId === id).length]));
  let id = ids.find((candidate) => ctx.archiveUsage.get(candidate) < CATEGORY_CAPACITY);

  if (!id) {
    const number = ids.length + 1;
    const archiveSpec = desired.categories.find((category) => category.isArchive);
    const created = await guild.channels.create({
      name: `${archiveSpec.name} ${number}`,
      type: channelType("category"),
      permissionOverwrites: explicitOverwrites(archiveSpec, [], plan.context),
      reason: REASON,
    });
    await store.remember(guild.id, "category", `${desired.archive.key}-${number}`, created.id);
    ids.push(created.id);
    ctx.archiveUsage.set(created.id, 0);
    id = created.id;
  }

  ctx.archiveUsage.set(id, ctx.archiveUsage.get(id) + 1);
  return id;
}

async function applyChannelOrder({ guild, desired, current, plan, log }) {
  const positions = channelOrderPositions(desired, current, plan.context);
  if (!positions.length) return;
  try {
    await guild.channels.setPositions(positions.map(({ id, position }) => ({ channel: id, position })));
    log.push({ ok: true, text: `reorder ${positions.length} channel(s)` });
  } catch (error) {
    log.push({ ok: false, text: `reorder channels: ${error.message}` });
  }
}

// ── AutoMod ────────────────────────────────────────────────────────────────

async function applyAutomodOp(op, { guild, plan, store }) {
  const { options, pending } = automodOptions(op.spec, plan.context);
  if (pending.length) throw new Error(`${pending.join(", ")} do not exist — they failed to create`);

  if (op.op === "create") {
    const rule = await guild.autoModerationRules.create({ ...options, reason: REASON });
    await store.remember(guild.id, "automod", op.key, rule.id);
    return;
  }
  if (op.changes.length) {
    // Тип тригера правила Discord змінити не дає — його й не передаємо.
    const editable = { ...options, reason: REASON };
    delete editable.triggerType;
    try {
      await guild.autoModerationRules.edit(op.id, editable);
    } catch (error) {
      // Виміряно на живому сервері: правило, яке Discord створив сам
      // (стандартне "Block Mention Spam" Community-сервера), читається, але
      // PATCH на нього дає 404. Змінити його бот не може ніяк.
      if (error.status === 404) {
        throw new Error(
          `Discord does not let the bot edit "${op.currentName}" (a rule Discord or another app created). ` +
            "Delete it in Server Settings → AutoMod and apply again, or leave this rule out of the config.",
        );
      }
      throw error;
    }
  }
  // Керованим правило стає лише після успішної правки: інакше план щоразу
  // пропонував би ту саму правку, яка ніколи не пройде.
  if (op.op === "adopt") await store.remember(guild.id, "automod", op.key, op.id);
}

// ── Повідомлення ───────────────────────────────────────────────────────────

/**
 * post — нове повідомлення в кінці каналу; edit — те саме повідомлення, на
 * місці. Payload рендериться тут наново: у цій фазі ролі вже існують, тож
 * кнопки панелей мають справжні id.
 */
async function applyMessageOp(op, { guild, plan, store }) {
  const channelId = plan.context.channelIds.get(op.spec.channelKey);
  const channel = channelId && guild.channels.cache.get(channelId);
  if (!channel) throw new Error(`channel "${op.spec.channelKey}" does not exist — it failed to create`);

  const { payload, pending } = renderMessage(op.spec, plan.context);
  if (pending.length) throw new Error(`role(s) ${pending.join(", ")} do not exist — they failed to create`);
  const extra = { content_hash: hashPayload(payload), parent_id: channelId };

  if (op.op === "edit") {
    await channel.messages.edit(op.id, { ...payload, allowedMentions: NO_MENTIONS });
    await store.remember(guild.id, "message", op.key, op.id, extra);
    return;
  }
  const message = await channel.send({ ...payload, allowedMentions: NO_MENTIONS });
  await store.remember(guild.id, "message", op.key, message.id, extra);
}

// ── Стан ───────────────────────────────────────────────────────────────────

async function applyStateOp(op, { guild, store }) {
  if (op.op === "forget") await store.forget(guild.id, op.kind, op.key);
}

// ── Overwrites ─────────────────────────────────────────────────────────────

/**
 * Overwrites із конфігу у форматі discord.js, з некерованими поточними, або
 * null, якщо конфіг їх не задає. Роль, якої так і не вдалося створити, —
 * помилка: без неї канал отримав би не ті права, що в конфігу.
 */
function explicitOverwrites(spec, currentOverwrites, context) {
  if (!spec.overwrites) return null;
  const { resolved, pending } = resolveOverwrites(spec.overwrites, context);
  if (pending.length) throw new Error(`role(s) ${pending.join(", ")} do not exist — they failed to create`);
  return toDiscordOverwrites(finalOverwrites(resolved, currentOverwrites, managedTargetIds(context)));
}

function toDiscordOverwrites(list) {
  return list.map(({ id, type, allow, deny }) => ({
    id,
    type: type === "member" ? OverwriteType.Member : OverwriteType.Role,
    allow,
    deny,
  }));
}

/**
 * Журнал → текст для відповіді. Чиста функція.
 * @param {{ ok: boolean, text: string }[]} log
 */
export function formatApplyLog(log, { guildName }) {
  const done = log.filter((entry) => entry.ok);
  const failed = log.filter((entry) => !entry.ok);
  const lines = [
    failed.length
      ? `⚠️ **${guildName}**: ${done.length} change(s) applied, **${failed.length} failed**.`
      : `✅ **${guildName}**: ${done.length} change(s) applied.`,
  ];
  if (failed.length) lines.push("", "**Failed**", ...failed.map((entry) => `✖ ${entry.text}`));
  if (done.length) lines.push("", "**Done**", ...done.map((entry) => `✓ ${entry.text}`));
  lines.push(
    "",
    failed.length
      ? "Run `/provision plan` to see what is left; `/provision apply` again continues from there."
      : "You can take Administrator away from the bot now.",
  );
  return lines.join("\n");
}

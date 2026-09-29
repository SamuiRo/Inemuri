import { describeBitsChange } from "./permissions.js";

/**
 * Overwrites каналів: зведення цілей конфігу до id Discord, порівняння з
 * поточними і фінальний список для запису. Чисті функції.
 *
 * **Керовані цілі** — @everyone, бот і ролі з конфігу. Для них конфіг
 * авторитетний: зайвий overwrite такої цілі знімається. Overwrites усіх
 * інших цілей (ручні на учасника, роль поза конфігом) зберігаються як є:
 * провіжн не чіпає того, чим не керує.
 *
 * ctx = { everyoneId, bot: { id, type }, roleIds: Map<key, id>, roleNames: Map<key, name> }
 */

/**
 * @param {{ target: string, allow: bigint, deny: bigint }[]} list  Бажані overwrites.
 * @returns {{ resolved: { id, type, allow, deny, label }[], pending: string[] }}
 *   pending — ролі, яких ще немає (будуть створені), тож і id ще немає.
 */
export function resolveOverwrites(list, ctx) {
  const resolved = [];
  const pending = [];
  for (const { target, allow, deny } of list) {
    if (target === "@everyone") {
      resolved.push({ id: ctx.everyoneId, type: "role", allow, deny, label: "@everyone" });
    } else if (target === "@bot") {
      resolved.push({ id: ctx.bot.id, type: ctx.bot.type, allow, deny, label: "@bot" });
    } else {
      const key = target.slice("role:".length);
      const label = `@${ctx.roleNames.get(key) ?? key}`;
      const id = ctx.roleIds.get(key);
      if (id) resolved.push({ id, type: "role", allow, deny, label });
      else pending.push(label);
    }
  }
  return { resolved, pending };
}

/** Id усіх керованих цілей. */
export function managedTargetIds(ctx) {
  return new Set([ctx.everyoneId, ctx.bot.id, ...ctx.roleIds.values()]);
}

/**
 * Зміни між бажаними і поточними overwrites.
 * @returns {{ label: string, detail: string }[]}  Порожній масив — збігаються.
 */
export function diffOverwrites({ resolved, pending }, current, managedIds, labelOf) {
  const changes = pending.map((label) => ({ label, detail: "added (role is created first)" }));
  const currentById = new Map(current.map((ow) => [ow.id, ow]));
  const desiredIds = new Set(resolved.map((ow) => ow.id));

  for (const want of resolved) {
    const have = currentById.get(want.id);
    if (!have) {
      changes.push({ label: want.label, detail: `added: ${describeAllowDeny(0n, 0n, want.allow, want.deny)}` });
    } else if (have.allow !== want.allow || have.deny !== want.deny) {
      changes.push({ label: want.label, detail: describeAllowDeny(have.allow, have.deny, want.allow, want.deny) });
    }
  }
  for (const have of current) {
    if (managedIds.has(have.id) && !desiredIds.has(have.id)) {
      changes.push({ label: labelOf(have.id), detail: "removed" });
    }
  }
  return changes;
}

/**
 * Повний список для запису в Discord: бажані overwrites плюс збережені
 * некеровані. Discord замінює overwrites каналу цілком, тож некеровані треба
 * передати явно, інакше вони зникнуть.
 */
export function finalOverwrites(resolved, current, managedIds) {
  const kept = current.filter((ow) => !managedIds.has(ow.id));
  return [...resolved, ...kept].map(({ id, type, allow, deny }) => ({ id, type, allow, deny }));
}

function describeAllowDeny(fromAllow, fromDeny, toAllow, toDeny) {
  const parts = [];
  if (fromAllow !== toAllow) parts.push(`allow ${describeBitsChange(fromAllow, toAllow)}`);
  if (fromDeny !== toDeny) parts.push(`deny ${describeBitsChange(fromDeny, toDeny)}`);
  return parts.join("; ") || "no change";
}

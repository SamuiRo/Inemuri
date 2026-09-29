import { buildCustomId, parseCustomId } from "../../customId.js";
import { dangerousIn } from "../provision/permissions.js";

/**
 * Панелі ролей (docs/DISCORDAPP.md, «Feature: role panels»). Чисті функції:
 * провіжн будує кнопки, обробник натискання вирішує, що змінити.
 *
 * Кнопка без стану (D11): `roles:<t|x>:<roleId>`. Група exclusive — це всі
 * кнопки того самого повідомлення, тож окремої таблиці панелей немає.
 */

export const ROLE_PANEL_PREFIX = "roles";

// Однолітерні коди — customId обмежений 100 символами.
const MODE_CODE = { toggle: "t", exclusive: "x" };
const MODE_BY_CODE = { t: "toggle", x: "exclusive" };

export const PANEL_MODES = Object.keys(MODE_CODE);

export function panelButtonId(mode, roleId) {
  return buildCustomId(ROLE_PANEL_PREFIX, MODE_CODE[mode], roleId);
}

/** @returns {{ mode: ("toggle"|"exclusive"), roleId: string } | null} */
export function parsePanelButton(customId) {
  const { prefix, action, args } = parseCustomId(customId);
  const mode = MODE_BY_CODE[action];
  if (prefix !== ROLE_PANEL_PREFIX || !mode || !args[0]) return null;
  return { mode, roleId: args[0] };
}

/**
 * Id ролей з усіх кнопок-панелі в компонентах повідомлення. Приймає і
 * компоненти discord.js (`customId`), і сирий JSON API (`custom_id`).
 */
export function panelRoleIds(rows = []) {
  const ids = [];
  for (const row of rows) {
    for (const component of row.components ?? []) {
      const parsed = parsePanelButton(component.customId ?? component.custom_id ?? "");
      if (parsed) ids.push(parsed.roleId);
    }
  }
  return ids;
}

/**
 * Що змінити учаснику після натискання.
 *  - toggle: є роль — зняти, немає — додати;
 *  - exclusive: те саме, але додавання знімає інші ролі цієї панелі.
 *
 * @param {{ mode: string, roleId: string, memberRoleIds: Set<string>, siblingIds: string[] }} input
 * @returns {{ add: string[], remove: string[] }}
 */
export function computeRoleChange({ mode, roleId, memberRoleIds, siblingIds }) {
  if (memberRoleIds.has(roleId)) return { add: [], remove: [roleId] };
  const remove = mode === "exclusive"
    ? siblingIds.filter((id) => id !== roleId && memberRoleIds.has(id))
    : [];
  return { add: [roleId], remove };
}

/**
 * Чому роль НЕ можна видати кнопкою, або null, якщо можна (D10). Перевіряється
 * при кожному натисканні, а не лише при провіжні: права ролі могли змінити
 * вручну вже після того, як панель опублікували.
 *
 * @param {{ name: string, managed: boolean, position: number, permissions: bigint } | null} role
 * @param {number} botHighestPosition
 * @returns {string|null}
 */
export function selfAssignRefusal(role, botHighestPosition) {
  if (!role) return "This role no longer exists.";
  if (role.managed) return `@${role.name} is managed by an integration and cannot be self-assigned.`;
  if (role.position >= botHighestPosition) return `@${role.name} is above the bot's role, so the bot cannot give it.`;
  const dangerous = dangerousIn(role.permissions);
  if (dangerous.length) return `@${role.name} carries ${dangerous.join(", ")} and cannot be self-assigned.`;
  return null;
}

/** Відповідь після натискання. Згадки ролей в ephemeral нікого не пінгують. */
export function describeRoleChange({ add, remove }) {
  const parts = [];
  if (add.length) parts.push(`✅ Added ${add.map((id) => `<@&${id}>`).join(", ")}`);
  if (remove.length) parts.push(`➖ Removed ${remove.map((id) => `<@&${id}>`).join(", ")}`);
  return parts.join("\n") || "Nothing changed.";
}

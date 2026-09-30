import {
  computeRoleChange,
  describeRoleChange,
  panelRoleIds,
  parsePanelButton,
  ROLE_PANEL_PREFIX,
  selfAssignRefusal,
} from "../features/roles/rolePanel.js";

// Показується в журналі аудиту Discord.
const REASON = "Inemuri role panel";

/**
 * Кнопка панелі ролей (docs/DISCORDAPP.md, «Feature: role panels»).
 * Доступна всім учасникам сервера, не лише адмінам; відповідь ephemeral.
 *
 * Панель публікує провіжн. Тут — лише натискання: яку роль додати чи зняти,
 * і чи можна її взагалі видавати (перевіряється щоразу, D10).
 */
export default {
  prefix: ROLE_PANEL_PREFIX,
  admin: false,

  async execute(interaction) {
    const button = parsePanelButton(interaction.customId);
    if (!button) return "❌ This button is not recognised.";

    const { guild } = interaction;
    // Свіжі дані, не кеш: з застарілими ролями toggle спрацював би навпаки.
    const [role, me, member] = await Promise.all([
      guild.roles.fetch(button.roleId),
      guild.members.fetchMe(),
      guild.members.fetch({ user: interaction.user.id, force: true }),
    ]);

    const refusal = selfAssignRefusal(role && {
      name: role.name,
      managed: role.managed,
      position: role.position,
      permissions: role.permissions.bitfield,
    }, me.roles.highest.position);
    if (refusal) return `❌ ${refusal}`;

    const change = computeRoleChange({
      mode: button.mode,
      roleId: button.roleId,
      memberRoleIds: new Set(member.roles.cache.keys()),
      siblingIds: panelRoleIds(interaction.message.components),
    });
    // Знімаємо лише те, чим бот може керувати: сусідня роль панелі могла
    // опинитись вище за бота вже після публікації.
    change.remove = change.remove.filter((id) => (guild.roles.cache.get(id)?.position ?? Infinity) < me.roles.highest.position);

    // По одній ролі через окремі ендпоінти (PUT/DELETE .../roles/:id). Масив у
    // member.roles.add/remove переписує ВЕСЬ список ролей зі знімка member, і
    // remove після add брав старий знімок — нова роль зникала (exclusive).
    const user = interaction.user.id;
    for (const id of change.add) await guild.members.addRole({ user, role: id, reason: REASON });
    for (const id of change.remove) await guild.members.removeRole({ user, role: id, reason: REASON });
    return describeRoleChange(change);
  },
};

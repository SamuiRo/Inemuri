import { createHash } from "crypto";
import { panelButtonId } from "../roles/rolePanel.js";

/**
 * Повідомлення провіжну (правила, гайди, панелі ролей) → payload Discord.
 * Чисті функції.
 *
 * Payload — сирий JSON API і **завжди містить content, embeds і components**:
 * редагування замінює всі три, тож повідомлення, яке з embed стало текстом,
 * не лишає старий embed. Він же — вхід хешу, за яким видно, що текст змінився.
 */

export const MAX_CONTENT = 2000;
export const MAX_EMBED_DESCRIPTION = 4096;
export const MAX_PANEL_ROLES = 25;
const BUTTONS_PER_ROW = 5;
const MAX_BUTTON_LABEL = 80;
const DEFAULT_PANEL_TEXT = "Choose your roles:";

// Типи і стилі компонентів API.
const ACTION_ROW = 1;
const BUTTON = 2;
const SECONDARY = 2;

/**
 * @param {object} message  Бажане повідомлення (schema.js) з `body` для тексту.
 * @param {{ roleIds: Map<string, string>, roleNames: Map<string, string> }} context
 * @returns {{ payload: object, pending: string[] }}  pending — ролі панелі, яких ще немає.
 */
export function renderMessage(message, context) {
  if (message.kind === "text") {
    if (!message.embed) return { payload: { content: message.body, embeds: [], components: [] }, pending: [] };
    const embed = { description: message.body };
    if (message.embed.title) embed.title = message.embed.title;
    if (message.embed.color !== undefined) embed.color = message.embed.color;
    return { payload: { content: "", embeds: [embed], components: [] }, pending: [] };
  }

  const pending = [];
  const buttons = [];
  for (const entry of message.panel.roles) {
    const roleId = context.roleIds.get(entry.key);
    if (!roleId) {
      pending.push(entry.key);
      continue;
    }
    const button = {
      type: BUTTON,
      style: SECONDARY,
      label: (entry.label ?? context.roleNames.get(entry.key) ?? entry.key).slice(0, MAX_BUTTON_LABEL),
      custom_id: panelButtonId(message.panel.mode, roleId),
    };
    if (entry.emoji) button.emoji = { name: entry.emoji };
    buttons.push(button);
  }

  const components = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    components.push({ type: ACTION_ROW, components: buttons.slice(i, i + BUTTONS_PER_ROW) });
  }
  return { payload: { content: message.panel.text ?? DEFAULT_PANEL_TEXT, embeds: [], components }, pending };
}

/** Короткий хеш payload — у стані, щоб бачити зміну тексту без читання повідомлення. */
export function hashPayload(payload) {
  return createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Ліміти Discord для тексту з файлу — перевіряються, щойно файл прочитано,
 * а не посеред apply.
 * @returns {string|null}
 */
export function bodyProblem(message) {
  const limit = message.embed ? MAX_EMBED_DESCRIPTION : MAX_CONTENT;
  if (!message.body.trim()) return `${message.file} is empty`;
  if (message.body.length > limit) {
    return `${message.file} is ${message.body.length} characters; ${message.embed ? "an embed" : "a message"} holds ${limit}. ` +
      (message.embed ? "Split it into several messages." : 'Set "embed": true (4096) or split it.');
  }
  return null;
}

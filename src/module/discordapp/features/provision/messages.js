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
export const MAX_EMBED_TITLE = 256;
export const MAX_EMBEDS = 10;
// Сума заголовків і текстів усіх embed одного повідомлення.
export const MAX_EMBEDS_TOTAL = 6000;
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
    const { text, pending } = resolveLinks(message.body, context);
    if (!message.embed) return { payload: { content: text, embeds: [], components: [] }, pending };
    const embeds = splitEmbeds(text).map((part, i) => {
      const embed = { description: part.description };
      const title = part.title ?? (i === 0 ? message.embed.title : undefined);
      if (title) embed.title = title;
      if (message.embed.color !== undefined) embed.color = message.embed.color;
      return embed;
    });
    return { payload: { content: "", embeds, components: [] }, pending };
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

/**
 * Короткий хеш повідомлення — у стані, щоб бачити зміну без читання
 * повідомлення. Автор (`as`) теж входить: зміна автора — це нове повідомлення.
 */
export function hashPayload(payload, as = null) {
  const input = as ? { ...payload, as } : payload;
  return createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

// Посилання в тексті за ключем конфігу: {{#channel-key}} і {{@role-key}}.
// Без зворотних слешів — класи символів замість екранування.
const LINK_RE = /[{][{]([#@])([a-z0-9][a-z0-9-]*)[}][}]/g;
// Скільки займає посилання після підстановки: <#id> з 20-значним id.
const LINK_LENGTH = 23;

/**
 * {{#key}} → <#id>, {{@key}} → <@&id>. Ключ, чийого ресурсу ще немає
 * (буде створений у цьому apply), лишається як є і повертається в pending.
 * @returns {{ text: string, pending: string[] }}
 */
export function resolveLinks(body, context) {
  const pending = [];
  const text = body.replace(LINK_RE, (whole, sigil, key) => {
    const id = sigil === "#" ? context.channelIds?.get(key) : context.roleIds?.get(key);
    if (id) return sigil === "#" ? `<#${id}>` : `<@&${id}>`;
    pending.push(`${sigil}${key}`);
    return whole;
  });
  return { text, pending };
}

/** Ключі з посилань у тексті: { channels, roles }. */
export function linkKeys(body) {
  const channels = new Set();
  const roles = new Set();
  for (const [, sigil, key] of body.matchAll(LINK_RE)) (sigil === "#" ? channels : roles).add(key);
  return { channels, roles };
}

/**
 * Текст embed-повідомлення → кілька embed: частини розділяє рядок `---`,
 * перший рядок частини `# Заголовок` стає заголовком embed. Так одне
 * повідомлення несе кілька «міні-embed» з бічною лінією кожен.
 * @returns {{ title?: string, description: string }[]}
 */
export function splitEmbeds(text) {
  return text.split(/^---$/m).map((part) => part.trim()).filter(Boolean).map((part) => {
    const [first, ...rest] = part.split("\n");
    const title = /^# (.+)$/.exec(first);
    return title ? { title: title[1].trim(), description: rest.join("\n").trim() } : { description: part };
  });
}

/**
 * Ліміти Discord для тексту з файлу — перевіряються, щойно файл прочитано,
 * а не посеред apply. Посилання рахуються за довжиною після підстановки.
 * @param {{ channels: Set<string>, roles: Set<string> }} [known]  Ключі конфігу для посилань.
 * @returns {string|null}
 */
export function bodyProblem(message, known = null) {
  if (!message.body.trim()) return `${message.file} is empty`;
  if (known) {
    const { channels, roles } = linkKeys(message.body);
    const unknown = [...[...channels].filter((key) => !known.channels.has(key)).map((key) => `{{#${key}}}`),
      ...[...roles].filter((key) => !known.roles.has(key)).map((key) => `{{@${key}}}`)];
    if (unknown.length) return `${message.file} links to keys the config does not have: ${unknown.join(", ")}`;
  }
  const measured = message.body.replace(LINK_RE, "x".repeat(LINK_LENGTH));

  if (!message.embed) {
    if (measured.length > MAX_CONTENT) {
      return `${message.file} is ${measured.length} characters; a message holds ${MAX_CONTENT}. Set "embed": true or split it.`;
    }
    return null;
  }
  const parts = splitEmbeds(measured);
  if (parts.length > MAX_EMBEDS) return `${message.file} has ${parts.length} embeds (--- sections); a message holds ${MAX_EMBEDS}.`;
  for (const [i, part] of parts.entries()) {
    if (!part.description) return `${message.file}: embed ${i + 1} has a title but no text`;
    if (part.description.length > MAX_EMBED_DESCRIPTION) {
      return `${message.file}: embed ${i + 1} is ${part.description.length} characters; an embed holds ${MAX_EMBED_DESCRIPTION}.`;
    }
    if ((part.title ?? "").length > MAX_EMBED_TITLE) return `${message.file}: embed ${i + 1} has a title over ${MAX_EMBED_TITLE} characters.`;
  }
  const total = parts.reduce((sum, part) => sum + part.description.length + (part.title ?? "").length, 0) + (message.embed.title?.length ?? 0);
  if (total > MAX_EMBEDS_TOTAL) {
    return `${message.file} is ${total} characters across its embeds; a message holds ${MAX_EMBEDS_TOTAL}. Split it into several messages.`;
  }
  return null;
}

/**
 * TheFlow — render() (DELIVERY.md). Чиста функція: пост + кластер → що
 * надіслати на платформу. Жодного I/O.
 *
 * Усе, що є «формулюванням» (рядки, емодзі, підписи осей), зібрано в TEMPLATE
 * нижче; решта файлу — механізм, який шаблон не змінює:
 *
 *   - повний перерендер, ніколи не дописування до рядка (рішення 1);
 *   - сегменти, entities тіла зсунуті на довжину всього, що перед ним
 *     (рішення 2); UTF-16 length = одиниця offset-ів MTProto;
 *   - обов'язкові частини (промокоди, неперевірене з OCR, «також
 *     повідомили N», спростування) переживають будь-яке обрізання — ріжеться
 *     лише тіло;
 *   - діагностика (reason, confidence, model, taxonomy) — лише в #unsorted.
 *
 * Мова шаблону — українська, як і переклад (translate()) та лід (summary_uk):
 * доставка TheFlow адресована українському читачеві.
 *
 * Форма результату:
 *   telegram → { header, body, entities } — TelegramDestination складає
 *              `header + "\n" + body` і сам зсуває entities на header + 1.
 *              Промокоди — окремими рядками з MessageEntityCode: у клієнті
 *              код копіюється одним дотиком.
 *   discord  → { author, title, description, fields, footer, color, url,
 *              timestamp } — embed: лід — заголовок (посилання на
 *              оригінал), коди й подія — окремі поля, час події — Discord
 *              timestamp (кожен бачить у своєму поясі).
 */

import { DISCORD, TELEGRAM } from "../../../shared/platformLimits.js";

export const LIMITS = {
  telegram: TELEGRAM.message, // текст повідомлення
  // Підпис до медіа без Premium (з Premium — 4096). Викликач передає
  // справжній ліміт акаунта (`captionLimit`, TELEGRAM_PREMIUM); за
  // замовчуванням — безпечний.
  telegramCaption: TELEGRAM.caption,
  discord: DISCORD.embedDescription,
  discordTotal: DISCORD.embedTotal, // сума всіх текстів одного embed
  discordTitle: DISCORD.embedTitle,
  discordFieldValue: DISCORD.embedFieldValue,
};

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// ── Шаблон ──────────────────────────────────────────────────────────────────
export const TEMPLATE = {
  topicEmoji: {
    steam: "🎮", games: "🕹️", airdrop: "🪂", p2e: "⚔️", crypto: "💹", tools: "🧰",
    health: "🩺", mind: "🧠", money: "💰", markets: "📈", other: "📦",
  },
  topicLabel: {
    steam: "Steam", games: "Ігри", airdrop: "Аірдропи", p2e: "P2E", crypto: "Крипта", tools: "Інструменти",
    health: "Здоров'я", mind: "Психологія", money: "Гроші", markets: "Ринки", other: "Інше",
  },
  signalEmoji: {
    promo_code: "🎟", freebie: "🎁", analysis: "📊", event: "📅", launch: "🚀", patch: "🛠",
    outage: "⚠️", opinion: "💬", security: "🛡", research: "🔬", report: "📰",
    giveaway_result: "🏆", stream: "🔴", meme: "😹",
  },
  signalLabel: {
    promo_code: "Промокод", freebie: "Роздача", analysis: "Аналітика", event: "Подія", launch: "Запуск",
    patch: "Оновлення", outage: "Збій", opinion: "Думка", security: "Безпека", research: "Дослідження",
    report: "Новина", giveaway_result: "Результати розіграшу", stream: "Стрім", meme: "Мем",
  },
  // Колір бічної смуги embed за сигналом. security — червоний: це та
  // категорія, де пропущений пост коштує більше за незручність.
  signalColor: {
    security: 0xe03131, outage: 0xf08c00, promo_code: 0x2f9e44, freebie: 0x2f9e44,
    launch: 0x1971c2, event: 0x1971c2, patch: 0x5f3dc4, analysis: 0x0c8599,
    research: 0x0c8599, report: 0x1971c2,
    opinion: 0x868e96, giveaway_result: 0x868e96, stream: 0x868e96, meme: 0xe8590c,
  },
  defaultColor: 0x5865f2,
  // «🕹️ Ігри · 🎟 Промокод». Невідома вісь — як є, без емодзі.
  axes: ({ topic, signal }) => {
    if (!topic) return null;
    const t = `${TEMPLATE.topicEmoji[topic] ?? TEMPLATE.topicEmoji.other} ${TEMPLATE.topicLabel[topic] ?? topic}`;
    if (!signal) return t;
    const s = TEMPLATE.signalLabel[signal] ? `${TEMPLATE.signalEmoji[signal]} ${TEMPLATE.signalLabel[signal]}` : signal;
    return `${t} · ${s}`;
  },
  header: ({ source, axes }) => [source, axes].filter(Boolean).join(" — "),
  lead: (summary) => `🇺🇦 ${summary}`,
  codesTitle: (n) => (n === 1 ? "🎟 Промокод" : "🎟 Промокоди"),
  codeNote: ({ expires, unverified }) => [
    expires ? `до ${expires}` : null,
    unverified ? "⚠️ прочитано з картинки, перевір" : null,
  ].filter(Boolean).join(" · "),
  eventTitle: "📅 Подія",
  // Telegram: «📅 Case drop — 2026-10-05 18:00 → 2026-10-12».
  event: ({ name, when, unverified }) => `📅 ${name} — ${when}${unverified ? " (дата з картинки, не перевірено)" : ""}`,
  additionsTitle: "➕ Доповнення",
  addition: (a) => `➕ ${a}`,
  moreAdditions: (n) => `…і ще ${n} ${plural(n, "доповнення", "доповнення", "доповнень")}`,
  alsoReported: (n) => `📡 Також повідомили ще ${n} ${plural(n, "канал", "канали", "каналів")}`,
  correction: (text) => `✏️ **Виправлення:** ${text}`,
  denial: (text) => `⛔ **Спростовано:** ${text}`,
  correctionTitle: "✏️ Виправлення",
  denialTitle: "⛔ Спростування",
  original: (url) => `🔗 ${url}`,
  diagnosticsTitle: "🔧 Чому в #unsorted",
  diagnostics: ({ confidence, model, taxonomy, reason }) =>
    `🔧 ${reason ?? "?"} · впевненість ${confidence ?? "?"} · ${model ?? "?"} · таксономія v${taxonomy ?? "?"}`,
  truncated: "…",
};

export const MAX_ADDITIONS = 3;

// Telegram показує **…** як є — жирний там робиться entity, не розміткою.
const plainMarkdown = (s) => s.replace(/\*\*/g, "");

// ── Механізм ────────────────────────────────────────────────────────────────

/** ISO-дата (з часом або без) → { ms, dateOnly } або null. */
function parseWhen(iso) {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const dateOnly = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(iso.trim());
  const ms = Date.parse(dateOnly ? `${iso.trim()}T00:00:00Z` : iso);
  return Number.isFinite(ms) ? { ms, dateOnly, iso: iso.trim() } : null;
}

/**
 * Дата для читача. Discord — timestamp `<t:…>`: кожен бачить у своєму поясі
 * і мові клієнта; дата без часу — як текст, бо опівніч UTC у західних поясах
 * показалась би попереднім днем. Telegram — «2026-10-05 18:00».
 */
function formatWhen(when, platform, { relative = false } = {}) {
  if (!when) return null;
  if (when.dateOnly) return when.iso;
  if (platform === "discord") {
    const unix = Math.floor(when.ms / 1000);
    return relative ? `<t:${unix}:f> (<t:${unix}:R>)` : `<t:${unix}:f>`;
  }
  return when.iso.slice(0, 16).replace("T", " ");
}

/** Подія (фаза 4) — лише коли в неї є дата з перевіреним якорем або з OCR. */
function eventOf(post) {
  const e = post.analysis?.extracted?.event;
  if (!e?.name || !(e.starts_at || e.ends_at)) return null;
  return { name: e.name, starts: parseWhen(e.starts_at), ends: parseWhen(e.ends_at), unverified: e.verified === false };
}

/** Рядок події для Telegram (і для перевірки в тестах). */
export function eventLine(post) {
  const e = eventOf(post);
  if (!e) return null;
  const s = formatWhen(e.starts, "telegram");
  const f = formatWhen(e.ends, "telegram");
  const when = s && f ? `${s} → ${f}` : s ?? f;
  return TEMPLATE.event({ name: e.name, when, unverified: e.unverified });
}

/** Те саме для поля embed: «Case drop\n<t:…> → <t:…>». */
function eventField(post) {
  const e = eventOf(post);
  if (!e) return null;
  const s = formatWhen(e.starts, "discord", { relative: true });
  const f = formatWhen(e.ends, "discord");
  const when = s && f ? `${s} → ${f}` : s ?? f;
  return `**${e.name}**\n${when}${e.unverified ? "\n⚠️ дата з картинки, не перевірено" : ""}`;
}

/** Промокоди поста, перевірені й ні (VISION.md, hazard 1). */
export function promoCodes(post) {
  const codes = post.analysis?.extracted?.promo_codes;
  return (Array.isArray(codes) ? codes : [])
    .filter((c) => c && typeof c.code === "string" && c.code.trim())
    .map((c) => ({ code: c.code.trim(), unverified: c.verified === false, expires: parseWhen(c.expires_at) }));
}

/** Неперевірені коди: `verified: false` (з OCR). */
export function unverifiedCodes(post) {
  return promoCodes(post).filter((c) => c.unverified).map((c) => c.code);
}

/**
 * Доповнення з членів кластера (DEDUPLICATION.md, крок 3). `adds` пише
 * delta-виклик (§6.6); до нього linked-пости доповнень не мають.
 * Спростування/виправлення — окремо: на них кап не діє ніколи.
 */
export function collectUpdates(members = []) {
  const additions = [];
  const corrections = [];
  for (const m of members) {
    const adds = m?.adds;
    if (!adds || typeof adds !== "object") continue;
    const texts = (Array.isArray(adds.adds) ? adds.adds : [])
      // Українською, коли delta-виклик дав переклад: лід теж український.
      .map((a) => (typeof a === "string" ? a : a?.text_uk || a?.text))
      .filter(Boolean);
    if (adds.relation === "corrects" || adds.relation === "denies") {
      corrections.push({ relation: adds.relation, text: texts.join("; ") || adds.summary || "див. оновлення" });
    } else if (adds.relation === "adds") {
      additions.push(...texts);
    }
  }
  return { additions, corrections };
}

/** Entities, що лежать у [0, end): за межею — геть, через межу — укоротити. */
function clipEntities(entities, end) {
  const out = [];
  for (const e of entities) {
    const offset = Number(e?.offset);
    const length = Number(e?.length);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) continue;
    if (offset >= end) continue;
    out.push({ ...e, offset, length: Math.min(length, end - offset) });
  }
  return out;
}

/**
 * Обрізає рядок тіла до `max` UTF-16 одиниць і підганяє entities: ті, що за
 * межею, зникають, ті, що перетинають межу, укорочуються.
 *
 * Обрізання entities — завжди, не лише коли ріжеться текст: offset-и
 * індексують текст ДО text_replacements (DELIVERY.md), тож після заміни
 * entity може вилазити за кінець raw_text, а такий Telegram відхиляє.
 */
export function truncateWithEntities(text, entities, max, ellipsis = TEMPLATE.truncated) {
  if (text.length <= max) return { text, entities: clipEntities(entities, text.length) };
  let cut = Math.max(0, max - ellipsis.length);
  // Не розрізати сурогатну пару (емодзі): інакше в кінці — битий символ.
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut) + ellipsis, entities: clipEntities(entities, cut) };
}

/**
 * Рядок сегмента: просто текст або { text, entities } — entities відносно
 * початку рядка (напр. код промокоду моноширинним).
 */
const lineText = (line) => (typeof line === "string" ? line : line.text);
const lineEntities = (line) => (typeof line === "string" ? [] : line.entities ?? []);

/** Склеює рядки через "\n", entities зсуваються на позицію свого рядка. */
function joinLines(lines, shift = 0) {
  let text = "";
  const entities = [];
  lines.forEach((line, i) => {
    if (i > 0) text += "\n";
    for (const e of lineEntities(line)) entities.push({ ...e, offset: e.offset + shift + text.length });
    text += lineText(line);
  });
  return { text, entities };
}

/**
 * Складає тіло з сегментів: `before` (банери, лід) + оригінал + `after`
 * (обов'язкові рядки). Обрізається лише оригінал; entities оригіналу
 * зсуваються на довжину всього, що перед ним, entities рядків after — на
 * свою позицію в кінці.
 */
export function composeBody({ before, original, originalEntities = [], after, max }) {
  const head = joinLines(before);
  const pre = before.length ? head.text + "\n\n" : "";
  const tailText = after.length ? "\n\n" + joinLines(after).text : "";
  const room = Math.max(0, max - pre.length - tailText.length);
  const cut = truncateWithEntities(original ?? "", originalEntities, room);
  const tail = after.length ? joinLines(after, pre.length + cut.text.length + 2) : { entities: [] };
  return {
    text: pre + cut.text + tailText,
    entities: [
      ...head.entities,
      ...cut.entities.map((e) => ({ ...e, offset: e.offset + pre.length })),
      ...tail.entities,
    ],
  };
}

/**
 * Окреме повідомлення про виправлення чи спростування — відповідь на вже
 * надіслане (DELIVERY.md, рішення 3). Редагування не дає сповіщення, тож
 * спростування, доставлене лише правкою, — спростування, якого ніхто не
 * побачить.
 *
 * @param {{ header: string, relation: "corrects"|"denies", text: string, platform: string }} args
 */
export function renderNotice({ header, relation, text, platform }) {
  const line = relation === "denies" ? TEMPLATE.denial(text) : TEMPLATE.correction(text);
  if (platform === "telegram") return { platform, header, body: plainMarkdown(line), entities: [] };
  return {
    platform,
    author: header,
    title: relation === "denies" ? TEMPLATE.denialTitle : TEMPLATE.correctionTitle,
    description: text,
    footer: null,
    color: relation === "denies" ? TEMPLATE.signalColor.security : TEMPLATE.signalColor.outage,
    url: null,
  };
}

const clip = (s, max) => (s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + TEMPLATE.truncated);

/**
 * @param {object} args
 * @param {object} args.post        Канонічний пост (рядок posts як plain-об'єкт).
 * @param {object|null} args.cluster
 * @param {object[]} [args.members] Інші пости кластера (linked / correction).
 * @param {string|null} args.source Назва джерела.
 * @param {{outcome: string, reason: string}} args.resolved  Результат resolve().
 * @param {string|null} [args.link] Посилання на оригінал.
 * @param {"telegram"|"discord"} args.platform
 * @param {number} [args.captionLimit]  Ліміт підпису до медіа в Telegram
 *   (1024 без Premium, 4096 з ним). Діє лише на пост із медіа.
 */
export function render({
  post, cluster = null, members = [], source = null, resolved, link = null, platform,
  captionLimit = LIMITS.telegramCaption,
}) {
  if (!LIMITS[platform]) throw new Error(`render(): unknown platform ${JSON.stringify(platform)}`);

  const topic = post.topic ?? null;
  const signal = post.signal_type ?? null;
  const axes = TEMPLATE.axes({ topic, signal });
  const { additions, corrections } = collectUpdates(members);
  const codes = promoCodes(post);
  const others = Math.max(0, Number(cluster?.members_count ?? 1) - 1);
  const unsorted = resolved?.outcome === "unsorted";
  const diagnostics = unsorted
    ? TEMPLATE.diagnostics({
      confidence: post.confidence == null ? null : Number(post.confidence).toFixed(2),
      model: post.model_used,
      taxonomy: post.taxonomy_version,
      reason: resolved.reason,
    })
    : null;
  const summary = typeof post.analysis?.summary_uk === "string" && post.analysis.summary_uk.trim()
    ? post.analysis.summary_uk.trim()
    : null;

  // Пост не українською — тіло перекладом (analysis.text_uk). Переклад —
  // plain text: entities оригіналу індексують інший рядок і не переносяться;
  // URL у перекладі лишаються як є, оригінал — за посиланням.
  const uk = post.analysis?.text_uk;
  const translated = typeof uk === "string" && uk.trim() ? uk.trim() : null;
  const banners = corrections.map((c) => (c.relation === "denies" ? TEMPLATE.denial(c.text) : TEMPLATE.correction(c.text)));

  if (platform === "telegram") {
    const header = TEMPLATE.header({ source, axes });
    // Над оригіналом: спростування (завжди, без капу), лід, подія.
    const before = banners.map(plainMarkdown);
    if (summary) before.push(TEMPLATE.lead(summary));
    const ev = eventLine(post);
    if (ev) before.push(ev);

    // Під оригіналом: промокоди (код — моноширинний, копіюється дотиком),
    // доповнення з капом, розмір кластера, лінк, діагностика.
    const after = [];
    for (const c of codes) {
      const note = TEMPLATE.codeNote({ expires: formatWhen(c.expires, "telegram"), unverified: c.unverified });
      const prefix = "🎟 ";
      after.push({
        text: `${prefix}${c.code}${note ? ` · ${note}` : ""}`,
        entities: [{ className: "MessageEntityCode", offset: prefix.length, length: c.code.length }],
      });
    }
    for (const a of additions.slice(0, MAX_ADDITIONS)) after.push(TEMPLATE.addition(a));
    if (additions.length > MAX_ADDITIONS) after.push(TEMPLATE.moreAdditions(additions.length - MAX_ADDITIONS));
    if (others > 0) after.push(TEMPLATE.alsoReported(others));
    if (link) after.push(TEMPLATE.original(link));
    if (diagnostics) after.push(diagnostics);

    // Пост із медіа йде підписом — його ліміт без Premium 1024, не 4096.
    // Бюджетувати треба тут: обрізання в адаптері відрізало б обов'язкові
    // рядки (посилання, діагностику) разом із хвостом тіла.
    const limit = post.has_media ? Math.min(LIMITS.telegram, Number(captionLimit) || LIMITS.telegramCaption) : LIMITS.telegram;
    const body = composeBody({
      before,
      original: translated ?? post.raw_text ?? "",
      originalEntities: translated ? [] : Array.isArray(post.entities) ? post.entities : [],
      after,
      max: limit - header.length - 1,
    });
    return { platform, header, body: body.text, entities: body.entities };
  }

  // ── Discord: embed ──────────────────────────────────────────────────
  const author = source ?? null;
  // Заголовок — лід українською; без нього — заголовок статті (новини, Reddit).
  const title = summary ?? (typeof post.title === "string" && post.title.trim() ? post.title.trim() : null);

  const fields = [];
  if (codes.length) {
    const lines = codes.map((c) => {
      const note = TEMPLATE.codeNote({ expires: formatWhen(c.expires, "discord", { relative: true }), unverified: c.unverified });
      return `\`${c.code}\`${note ? ` · ${note}` : ""}`;
    });
    fields.push({ name: TEMPLATE.codesTitle(codes.length), value: clip(lines.join("\n"), LIMITS.discordFieldValue) });
  }
  const ev = eventField(post);
  if (ev) fields.push({ name: TEMPLATE.eventTitle, value: clip(ev, LIMITS.discordFieldValue) });
  if (additions.length) {
    const lines = additions.slice(0, MAX_ADDITIONS).map((a) => `• ${a}`);
    if (additions.length > MAX_ADDITIONS) lines.push(TEMPLATE.moreAdditions(additions.length - MAX_ADDITIONS));
    fields.push({ name: TEMPLATE.additionsTitle, value: clip(lines.join("\n"), LIMITS.discordFieldValue) });
  }
  if (diagnostics) fields.push({ name: TEMPLATE.diagnosticsTitle, value: clip(diagnostics.replace(/^🔧 /, ""), LIMITS.discordFieldValue) });

  const footer = [axes, others > 0 ? TEMPLATE.alsoReported(others) : null].filter(Boolean).join(" · ") || null;
  const postedAt = post.posted_at ? new Date(post.posted_at) : null;

  // Discord рахує 6000 на весь embed: опис отримує те, що лишилось після
  // заголовка, автора, полів і footer (із запасом на назви полів).
  const used = (title?.length ?? 0) + (author?.length ?? 0) + (footer?.length ?? 0)
    + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const room = Math.max(200, Math.min(LIMITS.discord, LIMITS.discordTotal - used - 50));
  const body = composeBody({ before: banners, original: translated ?? post.text_md ?? post.raw_text ?? "", after: [], max: room });

  return {
    platform,
    author,
    title: title ? clip(title, LIMITS.discordTitle) : null,
    description: body.text,
    fields,
    footer,
    color: TEMPLATE.signalColor[signal] ?? TEMPLATE.defaultColor,
    url: link,
    timestamp: postedAt && Number.isFinite(postedAt.getTime()) ? postedAt.toISOString() : null,
  };
}

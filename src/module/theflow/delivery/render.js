/**
 * TheFlow — render() (DELIVERY.md). Чиста функція: пост + кластер → що
 * надіслати на платформу. Жодного I/O.
 *
 * Механізм зафіксовано в DELIVERY.md, шаблон — ні: точні рядки, емодзі й
 * розкладка embed вирішуються оператором на реальному матеріалі (ROADMAP
 * §5.4). Тому все, що є «формулюванням», зібрано в TEMPLATE нижче, а решта
 * файлу — механізм, який шаблон не змінює:
 *
 *   - повний перерендер, ніколи не дописування до рядка (рішення 1);
 *   - сегменти, entities тіла зсунуті на довжину всього, що перед ним
 *     (рішення 2); UTF-16 length = одиниця offset-ів MTProto;
 *   - обов'язкові рядки (неперевірене з OCR, «також повідомили N»,
 *     спростування) переживають будь-яке обрізання — ріжеться лише тіло;
 *   - діагностика (confidence, model, taxonomy, reason) — лише в #unsorted.
 *
 * Форма результату підлаштована під наявні адаптери, які не змінюються:
 *   telegram → { header, body, entities } — TelegramDestination складає
 *              `header + "\n" + body` і сам зсуває entities на header + 1;
 *   discord  → { author, description, footer, color, url } — embed.
 */

export const LIMITS = {
  telegram: 4096, // text і caption однаково: клієнт — user account, не бот
  discord: 4096, // embed.description
};

// ── Шаблон (чернетка; остаточні формулювання — за оператором) ─────────────
export const TEMPLATE = {
  topicEmoji: {
    steam: "🎮", airdrop: "🪂", crypto: "💹", tools: "🧰",
    health: "🩺", mind: "🧠", money: "💰", markets: "📈", other: "📦",
  },
  // Колір бічної смуги embed за сигналом. security — червоний: це та
  // категорія, де пропущений пост коштує більше за незручність.
  signalColor: {
    security: 0xe03131, outage: 0xf08c00, promo_code: 0x2f9e44, freebie: 0x2f9e44,
    launch: 0x1971c2, event: 0x1971c2, patch: 0x5f3dc4, analysis: 0x0c8599,
    research: 0x0c8599, report: 0x1971c2,
    opinion: 0x868e96, giveaway_result: 0x868e96, stream: 0x868e96,
  },
  defaultColor: 0x5865f2,
  header: ({ source, topic, signal, emoji }) =>
    [source, topic ? `${emoji} ${topic} · ${signal}` : null].filter(Boolean).join(" — "),
  lead: (summary) => `🇺🇦 ${summary}`,
  // Фаза 4: подія з датою. `when` — «2026-10-05» або «2026-10-05 → 2026-10-12».
  event: ({ name, when, unverified }) => `📅 ${name} — ${when}${unverified ? " (date read from an image, unverified)" : ""}`,
  unverified: (codes) => `⚠️ Unverified (read from an image): ${codes.join(", ")}`,
  alsoReported: (n) => `📡 Also reported by ${n} more channel${n === 1 ? "" : "s"}`,
  addition: (a) => `➕ ${a}`,
  moreAdditions: (n) => `…and ${n} more update${n === 1 ? "" : "s"}`,
  correction: (text) => `✏️ Correction: ${text}`,
  denial: (text) => `⛔ Denied: ${text}`,
  original: (url) => `🔗 ${url}`,
  diagnostics: ({ confidence, model, taxonomy, reason }) =>
    `🔧 ${reason ?? "?"} · confidence ${confidence ?? "?"} · ${model ?? "?"} · taxonomy v${taxonomy ?? "?"}`,
  truncated: "…",
};

export const MAX_ADDITIONS = 3;

// ── Механізм ────────────────────────────────────────────────────────────────

/** Рядок події (фаза 4), лише коли в неї є дата з перевіреним якорем або з OCR. */
export function eventLine(post) {
  const e = post.analysis?.extracted?.event;
  if (!e?.name || !(e.starts_at || e.ends_at)) return null;
  // «2026-10-05» або «2026-10-05 18:00» (зсув пояса не показуємо).
  const day = (d) => String(d).slice(0, 16).replace("T", " ");
  const when = e.starts_at && e.ends_at ? `${day(e.starts_at)} → ${day(e.ends_at)}` : day(e.starts_at ?? e.ends_at);
  return TEMPLATE.event({ name: e.name, when, unverified: e.verified === false });
}

/** Неперевірені коди: `verified: false` (з OCR) — VISION.md, hazard 1. */
export function unverifiedCodes(post) {
  const codes = post.analysis?.extracted?.promo_codes;
  return (Array.isArray(codes) ? codes : [])
    .filter((c) => c && c.verified === false && c.code)
    .map((c) => c.code);
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
      corrections.push({ relation: adds.relation, text: texts.join("; ") || adds.summary || "see update" });
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
 * Складає тіло з сегментів: `before` (лід, банери) + оригінал + `after`
 * (обов'язкові рядки). Обрізається лише оригінал; entities оригіналу
 * зсуваються на довжину всього, що перед ним.
 */
export function composeBody({ before, original, originalEntities = [], after, max }) {
  const pre = before.length ? before.join("\n") + "\n\n" : "";
  const post = after.length ? "\n\n" + after.join("\n") : "";
  const room = Math.max(0, max - pre.length - post.length);
  const cut = truncateWithEntities(original ?? "", originalEntities, room);
  const shift = pre.length;
  return {
    text: pre + cut.text + post,
    entities: cut.entities.map((e) => ({ ...e, offset: e.offset + shift })),
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
  if (platform === "telegram") return { platform, header, body: line, entities: [] };
  return {
    platform,
    author: header,
    description: line,
    footer: null,
    color: relation === "denies" ? TEMPLATE.signalColor.security : TEMPLATE.signalColor.outage,
    url: null,
  };
}

/**
 * @param {object} args
 * @param {object} args.post        Канонічний пост (рядок posts як plain-об'єкт).
 * @param {object|null} args.cluster
 * @param {object[]} [args.members] Інші пости кластера (linked / correction).
 * @param {string|null} args.source Назва джерела.
 * @param {{outcome: string, reason: string}} args.resolved  Результат resolve().
 * @param {string|null} [args.link] Посилання на оригінал.
 * @param {"telegram"|"discord"} args.platform
 */
export function render({ post, cluster = null, members = [], source = null, resolved, link = null, platform }) {
  if (!LIMITS[platform]) throw new Error(`render(): unknown platform ${JSON.stringify(platform)}`);

  const topic = post.topic ?? null;
  const signal = post.signal_type ?? null;
  const header = TEMPLATE.header({
    source, topic, signal, emoji: TEMPLATE.topicEmoji[topic] ?? TEMPLATE.topicEmoji.other,
  });

  const { additions, corrections } = collectUpdates(members);

  // Над оригіналом: банери спростувань (завжди, без капу), потім лід.
  const before = [];
  for (const c of corrections) {
    before.push(c.relation === "denies" ? TEMPLATE.denial(c.text) : TEMPLATE.correction(c.text));
  }
  const summary = post.analysis?.summary_uk;
  if (typeof summary === "string" && summary.trim()) before.push(TEMPLATE.lead(summary.trim()));
  const ev = eventLine(post);
  if (ev) before.push(ev);

  // Під оригіналом: доповнення з капом, неперевірене, розмір кластера, лінк,
  // діагностика лише для #unsorted.
  const after = [];
  for (const a of additions.slice(0, MAX_ADDITIONS)) after.push(TEMPLATE.addition(a));
  if (additions.length > MAX_ADDITIONS) after.push(TEMPLATE.moreAdditions(additions.length - MAX_ADDITIONS));
  const unverified = unverifiedCodes(post);
  if (unverified.length) after.push(TEMPLATE.unverified(unverified));
  const others = Math.max(0, Number(cluster?.members_count ?? 1) - 1);
  if (others > 0) after.push(TEMPLATE.alsoReported(others));
  if (link && platform === "telegram") after.push(TEMPLATE.original(link));
  if (resolved?.outcome === "unsorted") {
    after.push(TEMPLATE.diagnostics({
      confidence: post.confidence == null ? null : Number(post.confidence).toFixed(2),
      model: post.model_used,
      taxonomy: post.taxonomy_version,
      reason: resolved.reason,
    }));
  }

  if (platform === "telegram") {
    // Тіло — raw_text з оригінальними entities (DELIVERY.md: «delivered as
    // written»). Заголовок іде в слот source.name адаптера: header + "\n" +
    // body ≤ ліміту.
    const max = LIMITS.telegram - header.length - 1;
    const body = composeBody({
      before,
      original: post.raw_text ?? "",
      originalEntities: Array.isArray(post.entities) ? post.entities : [],
      after,
      max,
    });
    return { platform, header, body: body.text, entities: body.entities };
  }

  // Discord: markdown (text_md), без entities; заголовок — embed.author,
  // осі — footer, колір — за сигналом, лінк — url заголовка.
  const body = composeBody({ before, original: post.text_md ?? post.raw_text ?? "", after, max: LIMITS.discord });
  return {
    platform,
    author: header,
    description: body.text,
    footer: [topic, signal].filter(Boolean).join(" · ") || null,
    color: TEMPLATE.signalColor[signal] ?? TEMPLATE.defaultColor,
    url: link,
  };
}

/**
 * TheFlow — стадія дедуплікації, чисте ядро (ROADMAP §6, DEDUPLICATION.md).
 *
 * Тут лише функції без I/O: ключі tier 1, косинус tier 2, richness і
 * дешевий гейт, вікна, саме рішення. Базу читає і пише DedupStage.js.
 *
 * Пост тут — plain-об'єкт із полями рядка posts (text_en, topic,
 * signal_type, candidates, analysis, embedding, embedding_model, …) плюс
 * `t` — час події в мс (posted_at, інакше createdAt).
 */

const HOUR = 3_600_000;

// Параметри, що не несуть змісту, але роблять одне посилання різними рядками.
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "yclid", "mc_cid", "mc_eid", "igshid", "ref", "ref_src",
  "si", "feature", "_ga", "spm",
]);

/**
 * Нормалізоване посилання як ключ tier 1: той самий ресурс — той самий рядок.
 * Нижній регістр хоста, без `www.`, без фрагмента, без трекінгових
 * параметрів, параметри відсортовані, без кінцевого слеша; youtu.be/ID →
 * youtube.com/watch?v=ID. Невалідний URL → null (ключем не стає).
 */
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  let host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  let path = u.pathname;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(k.toLowerCase()));

  if (host === "youtu.be" && path.length > 1) {
    params.push(["v", path.slice(1)]);
    host = "youtube.com";
    path = "/watch";
  }

  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "/") path = "";
  return `${host}${path}${query}`;
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Ключі tier 1 — точний збіг сутностей (DEDUPLICATION.md «Tier 1»).
 *
 * - `code:` — промокод, **лише перевірений** (`verified: true`, знайдений у
 *   тексті поста). Код з OCR не може бути авторитетом дедуплікації
 *   (ROADMAP §4, hazard 1): помилкова транскрипція склеїла б різні події.
 * - `url:` — нормалізоване посилання з candidates, крім шаблонних
 *   (`boilerplate` — посилання, що джерело ставить у кожен пост: без цього
 *   виключення підпис каналу склеїв би все, що він пише).
 * - `ext:` — external_url (Reddit, новини).
 * - `hash:` — text_hash, дослівний текст.
 *
 * @param {object} post
 * @param {Set<string>} [boilerplate]  Нормалізовані URL, що ключем не є.
 * @returns {string[]}
 */
export function tier1Keys(post, boilerplate = new Set()) {
  const keys = new Set();

  for (const c of asList(post.analysis?.extracted?.promo_codes)) {
    if (c?.verified === true && typeof c.code === "string" && c.code.trim().length >= 4) {
      keys.add(`code:${c.code.trim().toUpperCase()}`);
    }
  }
  for (const raw of asList(post.candidates?.urls)) {
    const n = normalizeUrl(raw);
    if (n && !boilerplate.has(n)) keys.add(`url:${n}`);
  }
  const ext = post.external_url ? normalizeUrl(post.external_url) : null;
  if (ext) keys.add(`ext:${ext}`);
  if (post.text_hash) keys.add(`hash:${post.text_hash}`);

  // «Тікер + дата» (DEDUPLICATION.md, фаза 4): `$ABC` і дата лістингу з двох
  // каналів — одна подія. Лише з перевірених частин: тікер із тексту (не з
  // OCR) і дата події з дослівним якорем у тексті.
  const day = eventDay(post);
  if (day) {
    for (const t of verifiedTickers(post)) keys.add(`evt:${t}:${day}`);
  }

  return [...keys];
}

/** Дата події (YYYY-MM-DD), лише якщо її якір перевірено в тексті. */
export function eventDay(post) {
  const e = post.analysis?.extracted?.event;
  if (!e || e.verified !== true) return null;
  const d = e.starts_at ?? e.ends_at;
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

/** Тікери з тексту поста (OCR-тікери перелічені в analysis.unverified). */
export function verifiedTickers(post) {
  const fromOcr = new Set(
    asList(post.analysis?.unverified)
      .filter((u) => u?.path === "entities.tickers")
      .map((u) => String(u.value).toUpperCase()),
  );
  return [...new Set(asList(post.analysis?.entities?.tickers)
    .map((t) => String(t).toUpperCase().replace(/^\$/, ""))
    .filter((t) => t && !fromOcr.has(t) && !fromOcr.has(`$${t}`)))];
}

/**
 * Float32 BLOB → Float32Array. Перевірка формату з §13.2:
 * `buffer.length === embedding_dim * 4`. Невідповідність → null (вектор не
 * використовується, а не читається криво).
 */
export function decodeEmbedding(buf, dim) {
  if (!buf || !dim) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length !== dim * 4) return null;
  // Копія, бо Buffer із пулу може бути не вирівняний по 4 байтах.
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, dim);
}

/**
 * Косинус одиничних векторів — скалярний добуток (вектори нормалізуються при
 * записі, §13.2). Різна довжина → null: порівнювати нема чого.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Інформативність поста (DEDUPLICATION.md, крок 1):
 * довжина text_en + посилання + числа й дати + сутності + медіа.
 */
export function richness(post) {
  const c = post.candidates ?? {};
  const a = post.analysis ?? {};
  const entities =
    asList(a.entities?.tickers).length +
    (a.entities?.project ? 1 : 0) +
    asList(a.extracted?.promo_codes).length;
  return (
    String(post.text_en ?? "").length +
    asList(c.urls).length +
    asList(c.dates).length + asList(c.amounts).length +
    entities +
    (post.has_media ? 1 : 0)
  );
}

/**
 * Множина сутностей поста для питання «чи додає B щось до A».
 * Коди, тікери, проєкт, посилання, дати, суми — нормалізовані рядки.
 */
export function entitySet(post) {
  const out = new Set();
  const a = post.analysis ?? {};
  const c = post.candidates ?? {};
  for (const x of asList(a.extracted?.promo_codes)) if (x?.code) out.add(`code:${String(x.code).toUpperCase()}`);
  for (const t of asList(a.entities?.tickers)) out.add(`ticker:${String(t).toUpperCase().replace(/^\$/, "")}`);
  if (a.entities?.project) out.add(`project:${String(a.entities.project).toLowerCase()}`);
  for (const u of asList(c.urls)) {
    const n = normalizeUrl(u);
    if (n) out.add(`url:${n}`);
  }
  for (const d of asList(c.dates)) out.add(`date:${String(d)}`);
  for (const m of asList(c.amounts)) out.add(`amount:${String(m).replace(/\s+/g, "")}`);
  // Фаза 4: нормалізована дата події й підтверджені посилання — нова дата чи
  // нове посилання у пізнішому пості означає «щось додає».
  const day = eventDay(post);
  if (day) out.add(`event:${day}`);
  for (const l of asList(a.extracted?.links)) {
    const n = normalizeUrl(l?.url);
    if (n) out.add(`url:${n}`);
  }
  return out;
}

/**
 * Вікно дедуплікації в годинах: перевизначення джерела
 * (`flow.dedup_window_hours`), інакше вікно сигналу з categories.json.
 */
export function windowHours(signal, taxonomy, flow = null, fallback = 48) {
  const own = Number(flow?.dedup_window_hours);
  if (Number.isFinite(own) && own > 0) return own;
  const w = Number(taxonomy?.signals?.[signal]?.dedup_window_hours);
  return Number.isFinite(w) && w > 0 ? w : fallback;
}

/** Найдовше вікно таксономії — межа пулу кандидатів. */
export function maxWindowHours(taxonomy, fallback = 48) {
  const all = Object.values(taxonomy?.signals ?? {})
    .map((s) => Number(s?.dedup_window_hours))
    .filter((n) => Number.isFinite(n) && n > 0);
  return Math.max(fallback, ...all);
}

/** Кластер приймає пост у момент `t`? Закритий — ні; поза вікном — ні. */
export function clusterAccepts(cluster, t, windowH) {
  if (!cluster || cluster.closed) return false;
  return t - cluster.last_seen_at <= windowH * HOUR;
}

// Сигнали, які дедуплікація не пригнічує ніколи (ROADMAP §6 «Non-negotiable»):
// друге повідомлення про той самий злам може назвати контракт, від якого
// тримаєтесь подалі. `corrects` / `denies` — відношення з delta-виклику
// (§6.6), з'являться разом із ним.
export const NEVER_SUPPRESS_SIGNALS = new Set(["security"]);

/**
 * Рішення для одного поста. Чиста функція.
 *
 * @param {object} args
 * @param {object} args.post           Пост, що дедуплікується.
 * @param {{cluster: object, post: object, key: string}|null} args.tier1
 *   Збіг tier 1: кластер, член-збіг і спільний ключ.
 * @param {{cluster: object, post: object, s: number}|null} args.tier2
 *   Найближчий член за косинусом (уже в межах вікна, тієї ж моделі й топіка).
 * @param {object|null} args.canonicalOf  Канонічний пост кластера-кандидата
 *   (для гейту richness). null → гейт порівнює з richness кластера.
 * @param {{high: number, low: number, gateFactor: number, replaceFactor: number}} args.thresholds
 * @returns {{
 *   decision: "new"|"join", tier: 1|2|null, cluster: object|null,
 *   role: "canonical"|"linked"|"duplicate", suppress: boolean,
 *   replaceCanonical: boolean, log: object }}
 */
export function decide({ post, tier1, tier2, canonicalOf = null, thresholds }) {
  const s = tier2?.s ?? null;
  const log = {
    tier: null,
    s: s === null ? null : Math.round(s * 10_000) / 10_000,
    nearest_post_id: tier2?.post?.id ?? null,
    key: null,
    gray: false,
    no_embedding: !post.embedding_model,
  };

  let target = null;
  if (tier1) {
    target = tier1;
    log.tier = 1;
    log.key = tier1.key;
  } else if (tier2 && s >= thresholds.high) {
    target = tier2;
    log.tier = 2;
  }

  if (!target) {
    // Сіра зона до tier 3 — нова подія з позначкою (DEDUPLICATION.md):
    // опублікувати дубль прикро, проковтнути справжню новину гірше.
    log.gray = s !== null && s > thresholds.low;
    return {
      decision: "new", tier: null, cluster: null, role: "canonical",
      suppress: false, replaceCanonical: false, log: { ...log, decision: "new", role: "canonical" },
    };
  }

  const cluster = target.cluster;
  const mine = richness(post);
  const theirs = canonicalOf ? richness(canonicalOf) : Number(cluster.richness ?? 0);
  const theirEntities = canonicalOf ? entitySet(canonicalOf) : new Set();
  const addsEntities = [...entitySet(post)].filter((e) => !theirEntities.has(e));

  log.gate = { richness: mine, canonical_richness: theirs, adds_entities: addsEntities.slice(0, 10) };

  const replaceCanonical = theirs > 0 && mine >= theirs * thresholds.replaceFactor;
  let role;
  if (replaceCanonical) {
    role = "canonical";
  } else if (NEVER_SUPPRESS_SIGNALS.has(post.signal_type) || NEVER_SUPPRESS_SIGNALS.has(cluster.signal_type)) {
    role = "linked";
    log.never_suppress = true;
  } else if (mine <= theirs * thresholds.gateFactor && addsEntities.length === 0) {
    role = "duplicate";
  } else {
    // Пройшов дешевий гейт: може щось додавати. Що саме — вирішить
    // delta-виклик (§6.6); до нього пост лишається linked без `adds`.
    role = "linked";
  }

  return {
    decision: "join",
    tier: log.tier,
    cluster,
    role,
    suppress: role === "duplicate",
    replaceCanonical,
    log: { ...log, decision: "join", role, cluster_id: cluster.id, matched_post_id: target.post?.id ?? null },
  };
}

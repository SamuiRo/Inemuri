/**
 * Переклад як умова доставки (DELIVERY.md «Translation»). Чисте.
 *
 * До v4.64.0 невдалий переклад (квота, невалідна відповідь) не зупиняв
 * доставку: у тематичний канал ішов оригінал. Перший день доставки на VPS
 * дав 0 перекладених із 353 — enrich з'їдав денну квоту, переклад скидався.
 * Тепер пост чекає й пробує знову; не вдалося за `waitMs` — #unsorted з
 * причиною, а не канал мовою джерела.
 */

/** Чи пост потребує перекладу перед тематичним каналом. */
export function needsTranslation(post) {
  const lang = post?.lang;
  if (!lang || lang === "uk") return false;
  return typeof post.raw_text === "string" && post.raw_text.trim() !== "";
}

/** Чи переклад уже є (analysis.text_uk). */
export function hasTranslation(post) {
  const t = post?.analysis?.text_uk;
  return typeof t === "string" && t.trim() !== "";
}

/**
 * @param {{ post: object, waitingSince?: string|null, now: number, waitMs: number }} args
 *   waitingSince — коли пост уперше став чекати (delivery.since), ISO або null.
 * @returns {"go"|"wait"|"give_up"}
 */
export function translationVerdict({ post, waitingSince = null, now, waitMs }) {
  if (!needsTranslation(post) || hasTranslation(post)) return "go";
  const since = waitingSince ? Date.parse(waitingSince) : NaN;
  if (Number.isFinite(since) && now - since >= waitMs) return "give_up";
  return "wait";
}

/**
 * Стан `posts.delivery` поста, що чекає перекладу. `retry_at` виводить його з
 * черги до наступної спроби: інакше п'ять найстаріших постів, що чекають,
 * займали б увесь пакет доставки, і українські пости за ними стояли б теж.
 *
 * Той самий стан і для ринкової витримки (`kind: "market"`, marketGate.js).
 *
 * @param {object|null} prev попередній posts.delivery
 * @param {{ now: number, retryMs: number, kind?: "translation"|"market" }} opts
 */
export function waitingState(prev, { now, retryMs, kind = "translation" }) {
  const was = prev?.waiting === kind ? prev : null;
  return {
    waiting: kind,
    since: was?.since ?? new Date(now).toISOString(),
    retry_at: new Date(now + retryMs).toISOString(),
    tries: (was?.tries ?? 0) + 1,
  };
}

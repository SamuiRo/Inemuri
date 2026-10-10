import { cosine } from "../dedup/DedupCore.js";

/**
 * Ринки: підтвердження і ліміт (NEWS_INTAKE.md §5, кроки 2–3). Чисте.
 *
 * Чому не кластер дедуплікації: та сама новина з різних видань має косинус
 * 0.80–0.89 (виміряно на знімку VPS 2026-10-10: Wells Fargo 0.891, бичачий
 * ринок 0.880, МВФ 0.81–0.82), а кластер склеює від DEDUP_HIGH (0.90) — тож
 * лише 8 із 753 ринкових кластерів мали два джерела. Підтвердження —
 * слабше твердження, ніж «це дубль»: «хтось іще пише про те саме», тож і
 * поріг нижчий, і дедуплікацію він не чіпає.
 *
 * Рішення (marketVerdict):
 *   go      — у канал: підтверджено, або поодинока після витримки в межах ліміту;
 *   hold    — чекати підтвердження (до holdMs від публікації);
 *   cap     — ліміт вікна вичерпано: не в потік (лишається для дайджесту);
 *   twin    — підтверджувач уже в каналі: та сама новина вдруге не йде.
 *
 * Ліміт — ковзне вікно (capWindowMs, 6 год), а не доба: добовий ліміт «хто
 * перший» вичерпувався до полудня за UTC (симуляція 2026-10-09), і закриття
 * Wall Street не проходило ніколи.
 */

/**
 * Скільки ІНШИХ джерел пишуть про те саме, і чи котресь уже доставлене.
 *
 * @param {{ id: number, source_id: number, vector: Float32Array|number[]|null, t: number }} post
 * @param {Array<{ id: number, source_id: number, vector: Float32Array|number[]|null, t: number, delivered: boolean }>} others
 * Повтор того самого видання (Reuters пише ту саму історію вдруге — SpaceX і
 * телекоми двома текстами) підтвердженням не є, але й удруге в канал не йде:
 * deliveredTwin від sameSourceMin (суворіше — у серії одного видання близькі
 * тексти бувають і про різне: «Five charts…» / «Four signs…» — 0.83).
 *
 * Повтор з іншого видання — від twinMin (типово = minSimilarity): він відкидає
 * пост цілком, тож може бути суворішим за підтвердження.
 *
 * @param {{ minSimilarity: number, windowMs: number, twinMin?: number, sameSourceMin?: number }} opts
 * @returns {{ sources: number, deliveredTwin: number|null, best: number }}
 */
export function corroboration(post, others, { minSimilarity, windowMs, twinMin = minSimilarity, sameSourceMin = Infinity }) {
  const sources = new Set();
  let deliveredTwin = null;
  let best = 0;
  if (!post?.vector) return { sources: 0, deliveredTwin: null, best: 0 };
  for (const o of others) {
    // Інша модель ембедингів — інший простір: такі вектори не порівнюються.
    if (o.id === post.id || !o.vector || o.vector.length !== post.vector.length) continue;
    if (Math.abs(o.t - post.t) > windowMs) continue;
    const s = cosine(post.vector, o.vector);
    if (o.source_id === post.source_id) {
      if (o.delivered && s >= sameSourceMin && deliveredTwin == null) deliveredTwin = o.id;
      continue;
    }
    if (s > best) best = s;
    if (s < minSimilarity) continue;
    sources.add(o.source_id);
    if (o.delivered && s >= twinMin && deliveredTwin == null) deliveredTwin = o.id;
  }
  return { sources: sources.size, deliveredTwin, best };
}

/**
 * @param {{
 *   isMarket: boolean,
 *   ageMs: number,                          від публікації поста
 *   corroborated: { sources: number, deliveredTwin: number|null },
 *   sentInWindow: number, singlesInWindow: number, за останні capWindowMs
 *   holdMs: number, cap: number, singleCap: number,
 * }} a
 * @returns {{ verdict: "go"|"hold"|"cap"|"twin", kind: "corroborated"|"single"|null }}
 */
export function marketVerdict(a) {
  if (!a.isMarket) return { verdict: "go", kind: null };
  if (a.corroborated.deliveredTwin != null) return { verdict: "twin", kind: "corroborated" };
  if (a.corroborated.sources >= 1) {
    return { verdict: a.sentInWindow < a.cap ? "go" : "cap", kind: "corroborated" };
  }
  if (a.ageMs < a.holdMs) return { verdict: "hold", kind: null };
  const room = a.sentInWindow < a.cap && a.singlesInWindow < a.singleCap;
  return { verdict: room ? "go" : "cap", kind: "single" };
}

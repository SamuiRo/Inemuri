import { sectionsOf } from "./candidates.js";

/**
 * Безкоштовна частина triage (NEWS_INTAKE.md §2.3, §5). Чиста.
 *
 * Правило відкидає лише те, у чому нічого з профілю бути не може: розділи
 * зі списку `deny_sections` (спорт, ставки, шопінг…). Список навмисно
 * вузький — бажаний приклад оператора лежить у NYPost `/lifestyle/`, тож
 * усе сумнівне вирішує модель, а не правило.
 */

/**
 * @param {{ link?: string|null }} item
 * @param {{ deny_sections?: string[] }} profile triage.json
 * @returns {{ reason: string }|null} null — правило не вирішує, далі модель.
 */
export function ruleVerdict(item, profile) {
  const deny = new Set((profile?.deny_sections ?? []).map((s) => String(s).toLowerCase()));
  if (!deny.size || !item?.link) return null;
  const hit = sectionsOf(item.link).find((s) => deny.has(s));
  return hit ? { reason: `section:${hit}` } : null;
}

/**
 * Чи позначити відкинутий моделлю кандидат на перегляд.
 * @param {number} rate 0..1
 * @param {() => number} [random]
 */
export function shouldSample(rate, random = Math.random) {
  return rate > 0 && random() < rate;
}

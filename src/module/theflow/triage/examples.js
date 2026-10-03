import { FewShotStore } from "../FewShot.js";
import { loadExamples } from "../knowledge/KnowledgeBase.js";

/**
 * Приклади для промпту triage — з бази знань (NEWS_INTAKE.md §2.3).
 *
 * Беруться рівні `headline` (мітки `flow triage review`) і `post` (зокрема
 * приклади оператора, origin manual): обидва кажуть, що читачеві цікаво.
 * `good` і `missed` — «хотів би бачити», `noise` — «не треба».
 */

const SNIPPET = 200;

/** Заголовок, а без нього — перший рядок тексту: суть поста зазвичай там. */
function headlineOf(row) {
  const line = String(row.title || row.body || "").split("\n").find((l) => l.trim()) ?? "";
  const t = line.replace(/\s+/g, " ").trim();
  return t.length <= SNIPPET ? t : t.slice(0, SNIPPET - 1) + "…";
}

/**
 * Рядки бази знань → приклади. Чиста функція.
 *
 * @param {Array<{ uid, content_hash, verdict, title?, body }>} rows Найновіші першими.
 * @param {{ maxGood?: number, maxNoise?: number }} [opts]
 * @returns {Array<{ kind: "good"|"noise", ref: string, text: string }>}
 */
export function pickTriageExamples(rows, { maxGood = 8, maxNoise = 6 } = {}) {
  const latest = new Map();
  for (const r of rows) {
    if (!latest.has(r.content_hash)) latest.set(r.content_hash, r);
  }
  const shaped = [...latest.values()]
    .map((r) => ({ kind: r.verdict === "noise" ? "noise" : "good", ref: r.uid, text: headlineOf(r) }))
    .filter((e) => e.text);
  return [
    ...shaped.filter((e) => e.kind === "good").slice(0, maxGood),
    ...shaped.filter((e) => e.kind === "noise").slice(0, maxNoise),
  ];
}

/** Кеш прикладів triage: та сама механіка оновлення, що й у few-shot enrich. */
export function createTriageExamples(opts = {}) {
  return new FewShotStore({
    ...opts,
    load: () => loadExamples({ levels: ["headline", "post"], verdicts: ["good", "missed", "noise"], limit: 300 }),
    pick: pickTriageExamples,
  });
}

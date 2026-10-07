import { Op } from "sequelize";

import { DiscoveredItem, Source } from "../../teapot/models/index.js";

/**
 * Огляд triage для оператора: статистика і черга перегляду
 * (`flow triage stats|review`, NEWS_INTAKE.md §2.3, §5 «Measure first»).
 */

/**
 * Мітка бази знань з відповіді оператора «хотів би бачити?» і рішення моделі.
 * Чиста.
 *
 *   хотів би бачити + модель пропустила  → good
 *   хотів би бачити + модель відкинула   → missed  (triage помилився — найцінніше)
 *   не хотів би                          → noise
 */
export function reviewVerdict(wanted, row) {
  if (!wanted) return "noise";
  return row.status === "passed" ? "good" : "missed";
}

/**
 * Що переглянути: усе, що модель пропустила, і відібрані на перегляд
 * відкинуті (`sampled`). Правилом відкинуте не показується — розділи зі
 * списку deny_sections оператор уже назвав сміттям.
 */
export function reviewQueue({ limit = 50 } = {}) {
  return DiscoveredItem.findAll({
    where: {
      review_verdict: null,
      decided_by: "llm",
      [Op.or]: [{ status: "passed" }, { status: "rejected", sampled: true }],
    },
    order: [["createdAt", "ASC"], ["id", "ASC"]],
    limit,
  });
}

/**
 * @param {{ days?: number, now?: Date }} [opts]
 * @returns {Promise<{
 *   total: number,
 *   byOutcome: Record<string, number>,   // "rejected/rule", "passed/llm", "pending/-"…
 *   bySource: Array<{ source: string, total: number, passed: number, rule: number, llmRejected: number }>,
 *   areas: Record<string, number>,
 *   ruleReasons: Record<string, number>,
 *   toReview: number,
 *   reviewed: Record<string, number>,
 * }>}
 */
export async function collectTriageStats({ days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await DiscoveredItem.findAll({
    where: { createdAt: { [Op.gte]: since } },
    attributes: ["source_id", "status", "decided_by", "area", "reason", "sampled", "review_verdict"],
    raw: true,
  });
  const names = new Map((await Source.findAll({ attributes: ["id", "channel_name"], raw: true }))
    .map((s) => [s.id, s.channel_name]));

  const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  const byOutcome = {};
  const areas = {};
  const ruleReasons = {};
  const reviewed = {};
  const perSource = new Map();
  let toReview = 0;

  for (const r of rows) {
    count(byOutcome, `${r.status}/${r.decided_by ?? "-"}`);
    if (r.status === "passed" && r.area) count(areas, r.area);
    if (r.decided_by === "rule") count(ruleReasons, r.reason ?? "?");
    if (r.review_verdict) count(reviewed, r.review_verdict);
    else if (r.decided_by === "llm" && (r.status === "passed" || r.sampled)) toReview += 1;

    const name = names.get(r.source_id) ?? "(deleted source)";
    if (!perSource.has(name)) perSource.set(name, { source: name, total: 0, passed: 0, rule: 0, llmRejected: 0 });
    const s = perSource.get(name);
    s.total += 1;
    if (r.status === "passed") s.passed += 1;
    if (r.decided_by === "rule") s.rule += 1;
    if (r.status === "rejected" && r.decided_by === "llm") s.llmRejected += 1;
  }

  return {
    total: rows.length,
    byOutcome,
    bySource: [...perSource.values()].sort((a, b) => b.total - a.total),
    areas,
    ruleReasons,
    toReview,
    reviewed,
  };
}

/** Назва джерела кандидата — для показу в перегляді. */
export async function sourceNames(rows) {
  const ids = [...new Set(rows.map((r) => r.source_id).filter((id) => id != null))];
  const sources = await Source.findAll({ where: { id: ids }, attributes: ["id", "channel_name"], raw: true });
  return new Map(sources.map((s) => [s.id, s.channel_name]));
}

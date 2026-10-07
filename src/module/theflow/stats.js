/**
 * `flow stats` — статистика корпусу (ROADMAP §2.8).
 *
 * `aggregateFlowStats` — чиста функція над рядками posts; `collectFlowStatsRows`
 * — єдиний запит. Друк — у CLI.
 */

import database from "../teapot/sqlite/sqlite_db.js";
import { DAY, HOUR } from "../../shared/time.js";

export const CANDIDATE_KEYS = ["promo_codes", "tickers", "urls", "dates", "amounts"];
// Пост із медіа і текстом коротшим за це — кандидат на vision.
const VISION_CANDIDATE_MAX_LEN = 200;
const LEN_BUCKETS = [["0", 1], ["<50", 50], ["<200", 200], ["<500", 500], ["<1000", 1000], ["1000+", Infinity]];

function emptyBucket() {
  return {
    n: 0,
    status: {},
    mediaShort: 0,
    lenSum: 0,
    lenMax: 0,
    lenBuckets: Object.fromEntries(LEN_BUCKETS.map(([k]) => [k, 0])),
    cand: Object.fromEntries(CANDIDATE_KEYS.map((k) => [k, { n: 0, samples: new Set() }])),
  };
}

function parseCandidates(raw) {
  let c = raw;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return null; }
  }
  return c && typeof c === "object" ? c : null;
}

function add(bucket, row, len, cand) {
  bucket.n++;
  bucket.status[row.status] = (bucket.status[row.status] ?? 0) + 1;
  bucket.lenSum += len;
  if (len > bucket.lenMax) bucket.lenMax = len;
  bucket.lenBuckets[LEN_BUCKETS.find(([, below]) => len < below)[0]]++;
  if (row.has_media && len < VISION_CANDIDATE_MAX_LEN) bucket.mediaShort++;
  if (!cand) return;
  for (const k of CANDIDATE_KEYS) {
    const arr = Array.isArray(cand[k]) ? cand[k] : [];
    if (arr.length === 0) continue;
    bucket.cand[k].n++;
    for (const v of arr.slice(0, 3)) if (bucket.cand[k].samples.size < 8) bucket.cand[k].samples.add(String(v));
  }
}

/**
 * @param {Array<{ source_id: number, status: string, has_media: boolean, candidates: any, created_at: any, len: number|null }>} rows
 * @param {{ now?: number }} [opts]
 * @returns {{ total: object, perSource: Map<number, object>, spanDays: number }}
 */
export function aggregateFlowStats(rows, { now = Date.now() } = {}) {
  const total = emptyBucket();
  const perSource = new Map();
  const times = rows.map((r) => new Date(r.created_at).getTime()).filter((t) => !Number.isNaN(t));
  const spanDays = times.length ? Math.max((now - Math.min(...times)) / DAY, HOUR / DAY) : 0;

  for (const r of rows) {
    if (!perSource.has(r.source_id)) perSource.set(r.source_id, emptyBucket());
    const len = r.len ?? 0;
    const cand = parseCandidates(r.candidates);
    add(total, r, len, cand);
    add(perSource.get(r.source_id), r, len, cand);
  }
  return { total, perSource, spanDays };
}

export async function collectFlowStatsRows() {
  const [rows] = await database.sequelize.query(
    'SELECT source_id, status, has_media, candidates, "createdAt" AS created_at, ' +
      "LENGTH(raw_text) AS len FROM posts",
  );
  return rows;
}

import { MINUTE } from "../../shared/time.js";
import { Op } from "sequelize";

import { Post, Source, ProviderQuota } from "../teapot/models/index.js";

/**
 * Нагляд за TheFlow (ROADMAP §13.10).
 *
 * Базовий інваріант TheFlow — AI *може* впасти, і ingest від цього не
 * зупиняється. Зворотний бік: коли AI падає, нічого не падає гучно. Пости
 * тихо стають `failed` або тихо лежать `pending`, і єдиний сигнал — ручний
 * `flow stats`. Пілот 2026-09-29 так прожив добу: кожен виклик Gemini давав
 * 400, і ніхто цього не бачив.
 *
 * Три частини, як і решта TheFlow — чисте ядро, I/O по краях:
 *
 *   collectHealthSnapshot()  — кілька COUNT по posts і рядок квоти (I/O);
 *   assessHealth()           — чиста функція: знімок + пороги → проблеми;
 *   FlowHealthMonitor        — таймер і машина станів алертів: повідомляє
 *                              лише на переходах (нова / нагадування /
 *                              відновлення), а не на кожному тіку.
 *
 * Модуль не знає ні Telegram, ні Discord, ні EventBus: доставку ін'єктує
 * inemuri.js як `notify(text)`.
 */

const MIN = MINUTE;
const HOUR = 60 * MIN;

/**
 * @param {{
 *   now?: Date,
 *   failureWindowMin: number,
 *   quota?: { key: string, timeZone: string, rpd: number } | null,
 * }} opts  `quota` — ключ complete-моделі основного провайдера (як його
 *   веде LLMGateway: `provider:model`) і її RPD.
 */
export async function collectHealthSnapshot({ now = new Date(), failureWindowMin, quota = null }) {
  const windowStart = new Date(now.getTime() - failureWindowMin * MIN);

  const [pending, oldestPending, enrichedInWindow, failedRows, lastIngest, sources, lastFinished] = await Promise.all([
    Post.count({ where: { status: "pending" } }),
    Post.min("createdAt", { where: { status: "pending" } }),
    Post.count({ where: { status: "enriched", updatedAt: { [Op.gte]: windowStart } } }),
    Post.findAll({
      where: { status: "failed", updatedAt: { [Op.gte]: windowStart } },
      attributes: ["last_error"],
      raw: true,
    }),
    Post.max("createdAt"),
    Source.findAll({ where: { is_active: true } }),
    Post.max("updatedAt", { where: { status: ["enriched", "failed"] } }),
  ]);

  let quotaState = null;
  if (quota?.key) {
    const day = ProviderQuota.today(quota.timeZone, now);
    const row = await ProviderQuota.findOne({ where: { provider: quota.key, day_utc: day }, raw: true });
    quotaState = {
      key: quota.key,
      used: row?.count ?? 0,
      rpd: quota.rpd ?? null,
      exhausted: Boolean(row?.exhausted_at),
    };
  }

  return {
    now,
    pending,
    oldestPendingAt: oldestPending ? new Date(oldestPending) : null,
    window: {
      minutes: failureWindowMin,
      enriched: enrichedInWindow,
      failed: failedRows.length,
      topErrors: topErrors(failedRows.map((r) => r.last_error)),
    },
    lastIngestAt: lastIngest ? new Date(lastIngest) : null,
    lastFinishedAt: lastFinished ? new Date(lastFinished) : null,
    flowSources: sources.filter((s) => s.isFlowEnabled()).length,
    quota: quotaState,
  };
}

/**
 * Найчастіші помилки, згруповані за першими 120 символами: хвіст last_error
 * зазвичай тіло HTTP-відповіді, що різниться дрібницями.
 */
export function topErrors(errors, limit = 2) {
  const counts = new Map();
  for (const e of errors) {
    const key = String(e ?? "(no last_error)").slice(0, 120);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([error, count]) => ({ error, count }));
}

/** Квота дня вичерпана — бэклог чекає скидання, і це не застій. */
export function isQuotaWait(quota) {
  if (!quota) return false;
  return quota.exhausted || (quota.rpd != null && quota.used >= quota.rpd);
}

export function formatAge(ms) {
  const totalMin = Math.max(0, Math.floor(ms / MIN));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Чиста оцінка. Нічого не читає й не пише.
 *
 * @param {object} snap  Результат collectHealthSnapshot().
 * @param {{ pendingMaxAgeMin: number, failureMin: number, failureShare: number,
 *           ingestSilentHours: number }} thresholds
 * @param {{ workerRunning?: boolean, since?: Date|null }} [context]
 *   `workerRunning` — чи крутиться EnrichWorker у цьому процесі (без нього
 *   pending накопичуються за дизайном, і про збагачення нема чого казати).
 *   `since` — старт монітора: тиша ingest рахується не раніше нього, інакше
 *   свіжий запуск на порожній базі одразу кричав би.
 * @returns {{ ok: boolean, problems: Array<{key, message}>, notes: string[] }}
 */
export function assessHealth(snap, thresholds, { workerRunning = true, since = null } = {}) {
  const problems = [];
  const notes = [];
  const now = snap.now.getTime();

  if (snap.flowSources === 0) {
    notes.push("no flow-enabled sources — nothing to watch");
    return { ok: true, problems, notes };
  }

  if (workerRunning) {
    const { failed, enriched, minutes, topErrors: errs } = snap.window;
    const finished = failed + enriched;
    if (failed >= thresholds.failureMin && finished > 0 && failed / finished >= thresholds.failureShare) {
      const top = errs[0] ? ` Most common: ${errs[0].error} (×${errs[0].count})` : "";
      problems.push({
        key: "enrich_failing",
        message: `${failed} of ${finished} posts finished in the last ${minutes} min failed.${top}`,
      });
    }

    // Застій — не «старий pending», а «pending є, і нічого не завершується».
    // Після `flow requeue` чи простою старі пости — норма, поки воркер їх
    // розбирає; тривога лише коли за той самий інтервал жоден пост не став
    // enriched/failed (відлік — не раніше старту монітора).
    const maxAge = thresholds.pendingMaxAgeMin * MIN;
    const progressAt = Math.max(snap.lastFinishedAt?.getTime() ?? 0, since?.getTime() ?? 0);
    if (snap.pending > 0 && snap.oldestPendingAt && now - progressAt > maxAge) {
      const age = now - snap.oldestPendingAt.getTime();
      if (age > maxAge) {
        if (isQuotaWait(snap.quota)) {
          notes.push(
            `${snap.pending} pending, oldest ${formatAge(age)} — waiting for the daily quota reset ` +
              `(${snap.quota.key}: ${snap.quota.used}/${snap.quota.rpd ?? "?"})`,
          );
        } else {
          problems.push({
            key: "enrich_stalled",
            message:
              `${snap.pending} post(s) pending, the oldest for ${formatAge(age)}; nothing enriched or failed ` +
              `${snap.lastFinishedAt ? `for ${formatAge(now - snap.lastFinishedAt.getTime())}` : "yet"}, ` +
              "and the quota is not exhausted — the worker is not draining.",
          });
        }
      }
    }
  } else if (snap.pending > 0) {
    notes.push(`${snap.pending} pending — the enrich worker is not running in this process`);
  }

  const silentFrom = Math.max(snap.lastIngestAt?.getTime() ?? 0, since?.getTime() ?? 0);
  if (silentFrom > 0 && now - silentFrom > thresholds.ingestSilentHours * HOUR) {
    const what = snap.lastIngestAt
      ? `No flow post ingested for ${formatAge(now - snap.lastIngestAt.getTime())}`
      : `No flow post ingested since the monitor started ${formatAge(now - silentFrom)} ago`;
    problems.push({
      key: "ingest_silent",
      message: `${what} (${snap.flowSources} flow source(s)) — a dead channel, or listener/polling stopped.`,
    });
  }

  return { ok: problems.length === 0, problems, notes };
}

const LABEL = {
  enrich_failing: "enrich failing",
  enrich_stalled: "enrich stalled",
  ingest_silent: "ingest silent",
};

/**
 * Текст одного повідомлення. Простий текст із мінімумом розмітки — однаково
 * читається і в Telegram, і в Discord.
 */
export function formatHealthMessage({ raised = [], repeated = [], recovered = [] }) {
  const lines = [];
  const active = raised.length + repeated.length;
  lines.push(active ? `⚠️ TheFlow health — ${active} problem(s)` : "✅ TheFlow health — recovered");
  for (const p of raised) lines.push(`• ${LABEL[p.key] ?? p.key}: ${p.message}`);
  for (const p of repeated) lines.push(`• still — ${LABEL[p.key] ?? p.key}: ${p.message}`);
  for (const key of recovered) lines.push(`✅ recovered: ${LABEL[key] ?? key}`);
  return lines.join("\n");
}

/**
 * Таймер + машина станів. Тік — ланцюжок setTimeout, як в EnrichWorker:
 * повільна база не накладає тіки один на одного.
 */
export class FlowHealthMonitor {
  /**
   * @param {{
   *   collect: () => Promise<object>,
   *   notify: (text: string, report: object) => (void|Promise<void>),
   *   thresholds: object,
   *   intervalMs: number,
   *   repeatMs: number,
   *   workerRunning?: boolean,
   *   now?: () => number,
   *   log?: (msg: string, level?: string) => void,
   * }} deps
   */
  constructor({ collect, notify, thresholds, intervalMs, repeatMs, workerRunning = true, now = Date.now, log = () => {} }) {
    this.collect = collect;
    this.notify = notify;
    this.thresholds = thresholds;
    this.intervalMs = intervalMs;
    this.repeatMs = repeatMs;
    this.workerRunning = workerRunning;
    this.now = now;
    this.log = log;
    this.since = new Date(now());
    this.active = new Map(); // key -> { alertedAt }
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._schedule();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule() {
    if (!this._running) return;
    this._timer = setTimeout(async () => {
      await this.tick();
      this._schedule();
    }, this.intervalMs);
    // Нагляд не має тримати процес живим при зупинці.
    this._timer.unref?.();
  }

  /**
   * Один прохід. Повертає те, що було повідомлено (для тестів і CLI), або
   * null, якщо переходів не було. Помилка збору не валить монітор.
   */
  async tick() {
    let report;
    try {
      const snap = await this.collect();
      report = assessHealth(snap, this.thresholds, { workerRunning: this.workerRunning, since: this.since });
    } catch (error) {
      this.log(`[FLOW HEALTH] check failed: ${error.message}`, "warning");
      return null;
    }

    const now = this.now();
    const raised = [];
    const repeated = [];
    const seen = new Set();

    for (const p of report.problems) {
      seen.add(p.key);
      const state = this.active.get(p.key);
      if (!state) {
        raised.push(p);
        this.active.set(p.key, { alertedAt: now });
      } else if (now - state.alertedAt >= this.repeatMs) {
        repeated.push(p);
        state.alertedAt = now;
      }
    }
    const recovered = [...this.active.keys()].filter((k) => !seen.has(k));
    for (const k of recovered) this.active.delete(k);

    if (raised.length + repeated.length + recovered.length === 0) return null;

    const text = formatHealthMessage({ raised, repeated, recovered });
    this.log(text, raised.length || repeated.length ? "warning" : "success");
    try {
      await this.notify(text, report);
    } catch (error) {
      this.log(`[FLOW HEALTH] notify failed: ${error.message}`, "warning");
    }
    return { raised, repeated, recovered, text };
  }
}

/**
 * Квота, за якою судимо «чекаємо скидання»: complete-модель основного
 * провайдера, під тим самим ключем, що веде LLMGateway.
 */
export function primaryQuota(providers, primary) {
  const p = providers?.[primary];
  if (!p?.completeModel) return null;
  return {
    key: `${primary}:${p.completeModel}`,
    timeZone: p.quotaTimeZone ?? "UTC",
    rpd: p.modelLimits?.[p.completeModel]?.rpd ?? p.rpd ?? null,
  };
}

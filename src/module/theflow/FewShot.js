import { HOUR } from "../../shared/time.js";
import crypto from "crypto";

import { loadExamples } from "./knowledge/KnowledgeBase.js";

/**
 * TheFlow — few-shot з бази знань (ROADMAP §9, фаза 5; NEWS_INTAKE.md §3.4).
 *
 * Мітки `flow review` потрапляють у knowledge_examples разом зі знімком
 * поста, і звідти стають прикладами в промпті enrich:
 *
 *   good         → «так правильно»: текст і його класифікація;
 *   wrong_topic  → «так було неправильно»: текст, хибна класифікація і
 *                  причина від рецензента (у ній зазвичай правильна відповідь).
 *   noise        → не приклад класифікації, пропускається.
 *
 * Знімок, а не join до posts: після `flow requeue` поточний topic поста може
 * відрізнятися від того, на який ставили мітку, а знімок зберігає саме його.
 *
 * Приклади — це текст чужих каналів, тобто дані від джерела. Тому вони
 * йдуть у промпт окремим nonced-блоком як ДАНІ, не в системний промпт:
 * інакше колись позначений пост став би каналом ін'єкції в кожен виклик.
 *
 * Модуль не знає ні Telegram, ні Discord, ні gateway.
 */

const SNIPPET = 280;

const snippet = (s, max = SNIPPET) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
};

/**
 * Рядки бази знань → приклади. Чиста функція.
 *
 * @param {Array<{ uid, content_hash, verdict, reason, body, text_en, topic, signal_type }>} rows
 *   Від найновіших до найстаріших.
 * @param {{ maxGood?: number, maxWrong?: number }} [opts]
 * @returns {Array<{ kind: "good"|"wrong", ref: string, text, topic, signal_type, note: string|null }>}
 */
export function pickExamples(rows, { maxGood = 4, maxWrong = 3 } = {}) {
  // Остання мітка змісту вирішує: рецензент міг передумати.
  const latest = new Map();
  for (const r of rows) {
    if (!r?.topic || !(r.text_en || r.body)) continue;
    if (!latest.has(r.content_hash)) latest.set(r.content_hash, r);
  }
  const list = [...latest.values()];

  // good: спершу по одному на сигнал (різноманіття), потім решта найновіших.
  const good = [];
  const bySignal = new Set();
  const goods = list.filter((r) => r.verdict === "good");
  for (const r of goods) {
    if (good.length >= maxGood) break;
    if (bySignal.has(r.signal_type)) continue;
    bySignal.add(r.signal_type);
    good.push(r);
  }
  for (const r of goods) {
    if (good.length >= maxGood) break;
    if (!good.includes(r)) good.push(r);
  }

  // wrong_topic: лише з причиною — без неї незрозуміло, що правильно.
  const wrong = list.filter((r) => r.verdict === "wrong_topic" && r.reason && r.reason.trim()).slice(0, maxWrong);

  const shape = (r, kind) => ({
    kind,
    ref: r.uid,
    text: snippet(r.text_en || r.body),
    topic: r.topic,
    signal_type: r.signal_type,
    note: kind === "wrong" ? snippet(r.reason, 160) : null,
  });
  return [...good.map((r) => shape(r, "good")), ...wrong.map((r) => shape(r, "wrong"))];
}

/** Коротка ідентичність набору прикладів — у ключ кешу і в analysis.fewshot. */
export function hashExamples(examples) {
  if (!examples?.length) return null;
  return crypto.createHash("sha1")
    .update(JSON.stringify(examples.map((e) => [e.kind, e.ref, e.topic, e.signal_type, e.note])))
    .digest("hex").slice(0, 12);
}

// Сам блок для промпту — у services/ai/prompts/fewshot.js (промпт gateway не
// імпортує конвеєр); тут лише збирання прикладів із бази.
export { buildExamplesBlock } from "../../services/ai/prompts/fewshot.js";

/**
 * Приклади з кешем: перечитуються з бази не частіше за refreshMs — нові мітки
 * з `flow review` підхоплюються без перезапуску.
 *
 * `load` і `pick` замінні: той самий кеш дає приклади й triage
 * (triage/examples.js) — з іншого зрізу бази знань і з іншим відбором.
 * Решта опцій (maxGood, maxWrong…) іде в `pick`.
 */
export class FewShotStore {
  constructor({ refreshMs = HOUR, now = Date.now, load = loadExamples, pick = pickExamples, ...pickOptions } = {}) {
    this.pick = pick;
    this.opts = pickOptions;
    this.refreshMs = refreshMs;
    this.now = now;
    this.load = load;
    this._examples = [];
    this._hash = null;
    this._loadedAt = -Infinity;
  }

  /** @returns {Promise<{ examples: object[], hash: string|null }>} */
  async get() {
    if (this.now() - this._loadedAt >= this.refreshMs) {
      try {
        this._examples = this.pick(await this.load(), this.opts);
        this._hash = hashExamples(this._examples);
      } catch {
        // Без прикладів збагачення працює як раніше — це не привід падати.
      }
      this._loadedAt = this.now();
    }
    return { examples: this._examples, hash: this._hash };
  }
}

export default FewShotStore;

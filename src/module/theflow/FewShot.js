import crypto from "crypto";
import { Op } from "sequelize";

import { Post, PostFeedback } from "../teapot/models/index.js";

/**
 * TheFlow — few-shot з міток оператора (ROADMAP §9, фаза 5).
 *
 * `flow review` пише мітки в post_feedback з першого дня shadow mode саме для
 * цього: розмічені пости стають прикладами в промпті enrich.
 *
 *   good         → «так правильно»: пост і його вердикт;
 *   wrong_topic  → «так було неправильно»: пост, хибний вердикт і примітка
 *                  рецензента (у ній зазвичай правильна відповідь).
 *   noise        → не приклад класифікації, пропускається.
 *
 * Приклади — це text_en чужих каналів, тобто дані від джерела. Тому вони
 * йдуть у промпт окремим nonced-блоком як ДАНІ, не в системний промпт:
 * інакше колись позначений пост став би каналом ін'єкції в кожен виклик.
 *
 * Модуль не знає ні Telegram, ні Discord, ні gateway: лише posts і
 * post_feedback.
 */

const SNIPPET = 280;

const snippet = (s, max = SNIPPET) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
};

/**
 * Мітки → приклади. Чиста функція.
 *
 * @param {Array<{ verdict, note, created_at, post: { id, text_en, topic, signal_type } }>} labelled
 *   Від найновіших до найстаріших.
 * @param {{ maxGood?: number, maxWrong?: number }} [opts]
 * @returns {Array<{ kind: "good"|"wrong", post_id, text, topic, signal_type, note: string|null }>}
 */
export function pickExamples(labelled, { maxGood = 4, maxWrong = 3 } = {}) {
  // Остання мітка поста вирішує: рецензент міг передумати.
  const latest = new Map();
  for (const l of labelled) {
    if (!l?.post?.text_en || !l.post.topic) continue;
    if (!latest.has(l.post.id)) latest.set(l.post.id, l);
  }
  const list = [...latest.values()];

  // good: спершу по одному на сигнал (різноманіття), потім решта найновіших.
  const good = [];
  const bySignal = new Set();
  const goods = list.filter((l) => l.verdict === "good");
  for (const l of goods) {
    if (good.length >= maxGood) break;
    if (bySignal.has(l.post.signal_type)) continue;
    bySignal.add(l.post.signal_type);
    good.push(l);
  }
  for (const l of goods) {
    if (good.length >= maxGood) break;
    if (!good.includes(l)) good.push(l);
  }

  // wrong_topic: лише з приміткою — без неї незрозуміло, що правильно.
  const wrong = list.filter((l) => l.verdict === "wrong_topic" && l.note && l.note.trim()).slice(0, maxWrong);

  const shape = (l, kind) => ({
    kind,
    post_id: l.post.id,
    text: snippet(l.post.text_en),
    topic: l.post.topic,
    signal_type: l.post.signal_type,
    note: kind === "wrong" ? snippet(l.note, 160) : null,
  });
  return [...good.map((l) => shape(l, "good")), ...wrong.map((l) => shape(l, "wrong"))];
}

/** Коротка ідентичність набору прикладів — у ключ кешу і в analysis.fewshot. */
export function hashExamples(examples) {
  if (!examples?.length) return null;
  return crypto.createHash("sha1")
    .update(JSON.stringify(examples.map((e) => [e.kind, e.post_id, e.topic, e.signal_type, e.note])))
    .digest("hex").slice(0, 12);
}

// Сам блок для промпту — у services/ai/prompts/fewshot.js (промпт gateway не
// імпортує конвеєр); тут лише збирання прикладів із бази.
export { buildExamplesBlock } from "../../services/ai/prompts/fewshot.js";

/** Мітки з бази, найновіші першими. */
export async function loadLabelled({ limit = 200 } = {}) {
  const labels = await PostFeedback.findAll({
    where: { verdict: ["good", "wrong_topic"], post_id: { [Op.ne]: null } },
    order: [["created_at", "DESC"], ["id", "DESC"]],
    limit,
  });
  if (!labels.length) return [];
  const posts = await Post.findAll({
    where: { id: [...new Set(labels.map((l) => l.post_id))] },
    attributes: ["id", "text_en", "topic", "signal_type"],
  });
  const byId = new Map(posts.map((p) => [p.id, p.get({ plain: true })]));
  return labels
    .map((l) => ({ verdict: l.verdict, note: l.note, created_at: l.created_at, post: byId.get(l.post_id) }))
    .filter((l) => l.post);
}

/**
 * Приклади з кешем: перечитуються з бази не частіше за refreshMs — нові мітки
 * з `flow review` підхоплюються без перезапуску.
 */
export class FewShotStore {
  constructor({ maxGood = 4, maxWrong = 3, refreshMs = 3_600_000, now = Date.now, load = loadLabelled } = {}) {
    this.opts = { maxGood, maxWrong };
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
        this._examples = pickExamples(await this.load(), this.opts);
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

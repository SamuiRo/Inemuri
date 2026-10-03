import { DiscoveredItem, Source } from "../../teapot/models/index.js";
import { FLOW_TRIAGE } from "../../../config/app.config.js";
import { print } from "../../../shared/utils.js";
import { shouldSample } from "./rules.js";

/**
 * TheFlow — LLM-triage заголовків (NEWS_INTAKE.md §2.3, ROADMAP §14.3).
 *
 * Бере пакет pending-кандидатів, питає gateway.triage(), записує рішення.
 * Пропущене стає постом через `promote(row)` — ін'єкцію: створення поста
 * належить опитувачу стрічок (той самий шлях replacements → FlowIngest, що й
 * без triage), а цей модуль не знає ні стрічок, ні FlowIngest.
 *
 * Біжить у тіку EnrichWorker, перед збагаченням: пропущене в цьому ж тіку
 * стає pending-постом і одразу збагачується. Без ключа провайдера воркера
 * немає — кандидати чекають, як і pending-пости (THEFLOW.md, інваріант).
 *
 * Частка відкинутих моделлю (`sampleRate`) позначається `sampled` — на
 * перегляд у `flow triage review`; без негативів ніщо не скаже triage, що
 * він дарма щось відкинув.
 */
export class TriageStage {
  constructor({
    gateway,
    promote,
    examples = null,
    profile = FLOW_TRIAGE.profile,
    batchSize = FLOW_TRIAGE.batchSize,
    maxAttempts = FLOW_TRIAGE.maxAttempts,
    sampleRate = FLOW_TRIAGE.sampleRate,
    random = Math.random,
    Model = DiscoveredItem,
    log = print,
  }) {
    if (!gateway) throw new Error("TriageStage: a gateway is required");
    if (typeof promote !== "function") throw new Error("TriageStage: promote(row) is required");
    this.gateway = gateway;
    this.promote = promote;
    // { get() → { examples, hash } } — triage/examples.js; null — без прикладів.
    this.examples = examples;
    this.profile = profile;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.sampleRate = sampleRate;
    this.random = random;
    this.Model = Model;
    this.log = log;
  }

  /** Один пакет. Повертає, скільки кандидатів отримали рішення або стали постом. */
  async runOnce() {
    let advanced = await this._promoteLeftovers();

    const batch = await this.Model.nextPending(this.batchSize);
    if (!batch.length) return advanced;

    const shots = this.examples ? await this.examples.get() : { examples: [], hash: null };
    let result;
    try {
      result = await this.gateway.triage({
        items: await this._describe(batch),
        profile: this.profile,
        examples: shots.examples,
        examplesHash: shots.hash,
      }, { priority: "normal" });
    } catch (error) {
      await this._recordFailure(batch, `${error.kind ?? "error"}: ${error.message}`);
      this.log(`[TRIAGE] batch of ${batch.length} failed: ${error.message}`, "warning");
      return advanced;
    }
    if (result.shed) {
      this.log(`[TRIAGE] ${batch.length} candidate(s) deferred (${result.reason ?? "quota reserve"})`, "debug");
      return advanced;
    }

    const decided = new Set();
    let passed = 0;
    for (const d of result.decisions) {
      const row = batch[d.index];
      decided.add(row.id);
      await this._decide(row, d, result.model_used);
      if (d.relevant) {
        passed += 1;
        await this._promoteOne(row);
      }
      advanced += 1;
    }
    // Модель пропустила когось у відповіді — спробуємо в наступному пакеті.
    await this._recordFailure(batch.filter((r) => !decided.has(r.id)), "no decision in the response");

    this.log(`[TRIAGE] ${decided.size}/${batch.length} decided, ${passed} passed (${result.model_used})`, passed ? "success" : "info");
    return advanced;
  }

  /** Кандидати → вхід промпту: заголовок, анонс, ключові слова, розділ, назва джерела. */
  async _describe(batch) {
    const ids = [...new Set(batch.map((r) => r.source_id).filter((id) => id != null))];
    const names = new Map((await Source.findAll({ where: { id: ids }, attributes: ["id", "channel_name"] }))
      .map((s) => [s.id, s.channel_name]));
    return batch.map((r) => ({
      title: r.title,
      teaser: r.teaser,
      keywords: r.keywords ?? [],
      section: r.section,
      source: names.get(r.source_id) ?? null,
    }));
  }

  async _decide(row, d, model) {
    await row.update({
      status: d.relevant ? "passed" : "rejected",
      decided_by: "llm",
      area: d.area,
      reason: d.reason,
      profile_version: this.profile?.version ?? null,
      model_used: model ?? null,
      sampled: !d.relevant && shouldSample(this.sampleRate, this.random),
      attempts: 0,
      last_error: null,
    });
  }

  /** Створити пост пропущеного. Збій — не втрата: рядок лишається passed без post_id. */
  async _promoteOne(row) {
    try {
      const post = await this.promote(row);
      await row.update({ post_id: post.id, last_error: null });
      return true;
    } catch (error) {
      await row.update({ attempts: (row.attempts ?? 0) + 1, last_error: `promote: ${error.message}`.slice(0, 500) });
      this.log(`[TRIAGE] discovered#${row.id} passed, but the post was not created: ${error.message}`, "warning");
      return false;
    }
  }

  /** Пропущені минулого разу, але без поста (збій створення) — ще раз, у межах спроб. */
  async _promoteLeftovers() {
    const rows = (await this.Model.unpromoted(this.batchSize)).filter((r) => (r.attempts ?? 0) < this.maxAttempts);
    let promoted = 0;
    for (const row of rows) {
      if (await this._promoteOne(row)) promoted += 1;
    }
    return promoted;
  }

  /** Невдала спроба для pending-кандидатів; після maxAttempts — failed. */
  async _recordFailure(rows, message) {
    for (const row of rows) {
      const attempts = (row.attempts ?? 0) + 1;
      await row.update({
        attempts,
        status: attempts >= this.maxAttempts ? "failed" : "pending",
        last_error: message.slice(0, 500),
      });
    }
  }
}

export default TriageStage;

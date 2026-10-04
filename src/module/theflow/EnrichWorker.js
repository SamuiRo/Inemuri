import { print } from "../../shared/utils.js";
import { Post } from "../teapot/models/index.js";
import { ENRICH_PROMPT_VERSION } from "../../services/ai/prompts/enrich.js";
import { isDeferrable } from "../../services/ai/LLMGateway.js";
import {
  CATEGORIES,
  ENRICH_TICK_MS,
  ENRICH_BATCH_SIZE,
  ENRICH_MAX_ATTEMPTS,
} from "../../config/app.config.js";

/**
 * TheFlow — enrichment worker (ROADMAP §3.6).
 *
 * Reads `pending` posts, asks the gateway for a verdict and an embedding,
 * writes them back as `enriched`. Knows nothing about Telegram, Discord or the
 * event bus — only `posts` and the gateway. That boundary is what keeps a
 * later extraction into its own process cheap.
 *
 * The tick is a **chained `setTimeout`**, scheduled after the batch resolves:
 * ticks cannot overlap by construction, and a slow provider throttles the
 * worker instead of stacking batches. `attempts` is incremented at claim time
 * inside `Post.claimPending` — before the gateway call (§13.1).
 *
 * Phase 1 is shadow mode: verdicts land in `posts`, routing ignores them.
 *
 * Phase 1.5: an optional vision stage runs before enrich. It is **injected**,
 * not imported — VisionStage reaches Telegram through the media resolver, and
 * importing it here would break the boundary above. `flowFor(post)` is
 * injected for the same reason: the source lookup stays out of this module.
 */
export class EnrichWorker {
  constructor({
    gateway,
    taxonomy = CATEGORIES,
    tickMs = ENRICH_TICK_MS,
    batchSize = ENRICH_BATCH_SIZE,
    maxAttempts = ENRICH_MAX_ATTEMPTS,
    PostModel = Post,
    vision = null,
    flowFor = null,
    dedup = null,
    delta = null,
    fewShot = null,
    triage = null,
  } = {}) {
    if (!gateway) throw new Error("EnrichWorker: a gateway is required");
    if (vision && typeof flowFor !== "function") {
      throw new Error("EnrichWorker: a vision stage needs flowFor(post) to read the source's flow config");
    }
    this.vision = vision;
    this.flowFor = flowFor;
    // Стадія дедуплікації (§6) — теж ін'єкція: вона працює лише з posts і
    // clusters, але рішення, чи вона є, належить складанню в inemuri.js.
    this.dedup = dedup;
    // Delta-виклик (§6.6) — після дедуплікації, тією ж ін'єкцією.
    this.delta = delta;
    // Few-shot з міток оператора (фаза 5): { get() → { examples, hash } }.
    this.fewShot = fewShot;
    // Triage заголовків новин (§14.3) — до збагачення: пропущене стає
    // pending-постом і збагачується в цьому ж тіку.
    this.triage = triage;
    this.gateway = gateway;
    this.taxonomy = taxonomy;
    this.tickMs = tickMs;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.Post = PostModel;
    this._timer = null;
    this._stopped = true;
    this._halting = false;
    // Тік, що виконується зараз (null — простій). stop() чекає його: інакше
    // база закривалась посеред запису, а захоплена спроба згоряла на кожному
    // рестарті.
    this._running = null;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._halting = false;
    print(`[ENRICH] worker started — tick ${this.tickMs}ms, batch ${this.batchSize}`, "success");
    this._schedule(0);
  }

  /**
   * Зупиняє цикл і чекає поточний тік, але не довше за `graceMs`: виклик
   * провайдера може висіти до таймауту, а зупинка не має висіти разом із ним.
   * @returns {Promise<boolean>} true — тік завершився (або його не було).
   */
  async stop({ graceMs = 15_000 } = {}) {
    this._stopped = true;
    // Окремо від _stopped: той true і до start(), а runOnce() викликають і
    // напряму (CLI, тести) — пакет має обриватись лише після справжнього stop().
    this._halting = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._running) return true;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); });
    const done = await Promise.race([this._running.then(() => true, () => true), timeout]);
    clearTimeout(timer);
    return done;
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(() => {
      this._running = this._tick().finally(() => { this._running = null; });
    }, delayMs);
  }

  async _tick() {
    if (this._stopped) return;
    let advanced = 0;
    if (this.triage) {
      try {
        advanced += await this.triage.runOnce();
      } catch (error) {
        print(`[TRIAGE] tick error: ${error.message}`, "error");
      }
    }
    try {
      advanced += await this.runOnce();
    } catch (error) {
      print(`[ENRICH] tick error: ${error.message}`, "error");
      console.error(error);
    }
    // Дедуплікація щойно збагачених — у тому ж тіку, після enrich. Її збій
    // не зупиняє збагачення: пост лишається enriched без рішення і
    // підхоплюється наступним тіком.
    if (this.dedup) {
      try {
        advanced += await this.dedup.runOnce();
      } catch (error) {
        print(`[DEDUP] tick error: ${error.message}`, "error");
      }
    }
    if (this.delta) {
      try {
        advanced += await this.delta.runOnce();
      } catch (error) {
        print(`[DELTA] tick error: ${error.message}`, "error");
      }
    }
    // Drain a backlog quickly, then idle at the configured cadence.
    this._schedule(advanced > 0 ? Math.min(this.tickMs, 1_000) : this.tickMs);
  }

  /** Process one claimed batch. Returns how many posts advanced past `pending`. */
  async runOnce() {
    const batch = await this.Post.claimPending(this.batchSize);
    if (batch.length === 0) return 0;

    let advanced = 0;
    for (let i = 0; i < batch.length; i++) {
      const post = batch[i];
      if (this._halting) {
        // Зупинка посеред пакета: решту не чіпали — повертаємо їхні спроби.
        for (const rest of batch.slice(i)) await this.Post.releaseClaim(rest.id);
        break;
      }
      try {
        if (await this._enrichPost(post)) advanced += 1;
      } catch (error) {
        await this._recordFailure(post, error);
        if (isDeferrable(error)) {
          // Провайдер не приймає — решта пакета впреться в те саме. Повертаємо
          // їхні спроби і чекаємо наступного тіку.
          for (const rest of batch.slice(i + 1)) await this.Post.releaseClaim(rest.id);
          break;
        }
      }
    }
    return advanced;
  }

  async _enrichPost(post) {
    // Стадія 1.5. text_ocr пишеться всередині стадії одразу, до enrich(), тож
    // повтор збагачення за транскрипцію вже не платить.
    if (this.vision) {
      const flow = await this.flowFor(post);
      const seen = await this.vision.run(post, flow ?? {});
      if (seen.status === "shed") {
        // Не збагачувати без OCR: скріншот-пост отримав би впевнений вердикт на
        // порожньому тексті, став би enriched і більше ніколи не дістав OCR.
        await this.Post.releaseClaim(post.id);
        print(`[ENRICH] posts#${post.id} vision shed (quota reserve) — left pending`, "debug");
        return false;
      }
    }

    const shots = this.fewShot ? await this.fewShot.get() : { examples: [], hash: null };

    // Заголовок — окремим полем, не склеєним з тілом (ROADMAP §7).
    const enr = await this.gateway.enrich(
      {
        examples: shots.examples,
        examplesHash: shots.hash,
        text: post.raw_text ?? "",
        title: post.title ?? null,
        postedAt: post.posted_at ?? post.createdAt ?? null,
        candidates: post.candidates ?? {},
        textOcr: post.text_ocr ?? "",
        taxonomy: this.taxonomy,
      },
      { priority: "critical" },
    );

    if (enr?.shed) {
      // Shed — не збій: спробу, забрану при захопленні, повертаємо.
      await this.Post.releaseClaim(post.id);
      print(`[ENRICH] posts#${post.id} deferred (${enr.reason ?? "quota reserve"}) — left pending`, "debug");
      return false;
    }

    const v = enr.value;

    let emb = null;
    try {
      emb = await this.gateway.embed(v.text_en, { priority: "critical" });
    } catch (error) {
      // No embedding is not a failure: the post becomes enriched, dedup
      // degrades to tier 1, a backfill can fill the gap later (ROADMAP §3.1).
      print(`[ENRICH] posts#${post.id} embed failed (${error.message}) — verdict kept`, "warning");
    }
    const noEmbedding = !emb || emb.shed;

    await post.update({
      status: "enriched",
      text_en: v.text_en,
      lang: v.lang ?? null,
      topic: v.topic,
      signal_type: v.signal_type,
      confidence: v.confidence,
      analysis: {
        entities: v.entities ?? null,
        extracted: v.extracted ?? null,
        why_interesting: v.why_interesting ?? null,
        is_ad: v.is_ad ?? null,
        summary_uk: v.summary_uk ?? null,
        discarded: enr.discarded ?? [],
        // Що прийшло лише з OCR (тікери не мають місця для позначки на
        // елементі) — tier 1 дедуплікації не бере їх за ключ.
        unverified: enr.unverified ?? [],
        tiered: Boolean(enr.tiered),
        prompt_version: ENRICH_PROMPT_VERSION,
        // Якими прикладами з міток збагачено (null — без прикладів). Хеш
        // входить у ключ кешу gateway, тож і кешований вердикт — з ними.
        fewshot: shots.hash,
      },
      model_used: enr.model_used,
      taxonomy_version: this.taxonomy?.version ?? null,
      embedding: noEmbedding ? null : Buffer.from(emb.vector.buffer, emb.vector.byteOffset, emb.vector.byteLength),
      embedding_model: noEmbedding ? null : emb.model,
      embedding_dim: noEmbedding ? null : emb.dim,
      last_error: null,
    });

    print(
      `[ENRICH] posts#${post.id} → ${v.topic}/${v.signal_type} c=${v.confidence} ` +
        `(${enr.model_used}${noEmbedding ? ", no embedding" : ""})`,
      "success",
    );
    return true;
  }

  async _recordFailure(post, error) {
    // Квота чи rate limit — не вада поста: повертаємо спробу, пост лишається
    // pending і піде, коли провайдер знову прийматиме.
    if (isDeferrable(error)) {
      await this.Post.releaseClaim(post.id);
      print(`[ENRICH] posts#${post.id} deferred (${error.message}) — left pending`, "warning");
      return;
    }
    // `attempts` was already incremented at claim time (§13.1).
    const exhausted = (post.attempts ?? 0) >= this.maxAttempts;
    await post.update({
      status: exhausted ? "failed" : "pending",
      last_error: `${error.kind ?? "error"}: ${error.message}`.slice(0, 500),
    });
    print(
      `[ENRICH] posts#${post.id} ${exhausted ? "FAILED — attempts exhausted" : "will retry"}: ${error.message}`,
      exhausted ? "error" : "warning",
    );
  }
}

export default EnrichWorker;

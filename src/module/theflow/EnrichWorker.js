import { print } from "../../shared/utils.js";
import { Post } from "../teapot/models/index.js";
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
 */
export class EnrichWorker {
  constructor({
    gateway,
    taxonomy = CATEGORIES,
    tickMs = ENRICH_TICK_MS,
    batchSize = ENRICH_BATCH_SIZE,
    maxAttempts = ENRICH_MAX_ATTEMPTS,
    PostModel = Post,
  } = {}) {
    if (!gateway) throw new Error("EnrichWorker: a gateway is required");
    this.gateway = gateway;
    this.taxonomy = taxonomy;
    this.tickMs = tickMs;
    this.batchSize = batchSize;
    this.maxAttempts = maxAttempts;
    this.Post = PostModel;
    this._timer = null;
    this._stopped = true;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    print(`[ENRICH] worker started — tick ${this.tickMs}ms, batch ${this.batchSize}`, "success");
    this._schedule(0);
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(() => this._tick(), delayMs);
  }

  async _tick() {
    if (this._stopped) return;
    let advanced = 0;
    try {
      advanced = await this.runOnce();
    } catch (error) {
      print(`[ENRICH] tick error: ${error.message}`, "error");
      console.error(error);
    }
    // Drain a backlog quickly, then idle at the configured cadence.
    this._schedule(advanced > 0 ? Math.min(this.tickMs, 1_000) : this.tickMs);
  }

  /** Process one claimed batch. Returns how many posts advanced past `pending`. */
  async runOnce() {
    const batch = await this.Post.claimPending(this.batchSize);
    if (batch.length === 0) return 0;

    let advanced = 0;
    for (const post of batch) {
      try {
        if (await this._enrichPost(post)) advanced += 1;
      } catch (error) {
        await this._recordFailure(post, error);
      }
    }
    return advanced;
  }

  async _enrichPost(post) {
    const text = [post.title, post.raw_text]
      .filter((s) => s && String(s).trim() !== "")
      .join("\n\n");

    const enr = await this.gateway.enrich(
      {
        text,
        candidates: post.candidates ?? {},
        textOcr: post.text_ocr ?? "",
        taxonomy: this.taxonomy,
      },
      { priority: "critical" },
    );

    if (enr?.shed) {
      print(`[ENRICH] posts#${post.id} shed (quota reserve) — left pending`, "debug");
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
        tiered: Boolean(enr.tiered),
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

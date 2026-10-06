# TheFlow

> **Status (v4.59):** phases 0–5 and 1.5 are built and live on the VPS since
> 2026-10-06, delivery on to staff-only test channels for a test week before
> public ones; phase 6 (news intake) has steps 1–3 built — the knowledge base,
> sitemap/WordPress discovery and headline triage. Silent sources are watched
> by the status board (Inemuri-wide, `src/module/status/`). Open:
> deduplication threshold calibration (§6.8), phase 6 step 4 (article text)
> and the poll-interval half of step 5, reactions (§5.7, deferred).
> Without a primary provider key the worker does not start and flow sources
> only accumulate `pending` posts. This file is the entry point; per-task
> status lives in [theflow/ROADMAP.md](theflow/ROADMAP.md), the version record
> in [CHANGELOG.md](CHANGELOG.md).

## What TheFlow is

TheFlow is a subsystem of Inemuri. Inemuri remains the name of the whole system —
the event-driven content and data flow manager described in
[ARCHITECTURE.md](ARCHITECTURE.md). TheFlow is the part of it responsible for
turning a raw, noisy, multilingual firehose into a stream of validated,
categorized, deduplicated posts.

The problem it solves: instead of reading 30 channels where everything is mixed
together and every story is repeated five times in different words and different
languages, you get a sorted stream where each event appears once.

## Where TheFlow sits inside Inemuri

Inemuri already has an ingestion path: sources produce normalized `messageData`,
the event bus carries it, the router dispatches it to destinations. TheFlow
inserts itself between normalization and routing, and changes what "routing"
means for the sources that opt into it.

| Layer | Owner | Responsibility | Guarantee |
|---|---|---|---|
| Ingestion | Inemuri core (existing) | Source adapters, parsing, text replacements, persistence | Must always work |
| TheFlow | New subsystem | Translation, categorization, extraction, deduplication, content-based routing | May fail, stall, or run out of quota |
| Delivery | Inemuri core (existing) | Destination adapters for Telegram and Discord | Must always work |

**Invariant:** if TheFlow is completely unavailable, Inemuri keeps running.
Classic sources forward exactly as before, TheFlow sources accumulate in the
`posts` table with status `pending`, and nothing is lost. When the AI provider
comes back, the worker drains the backlog.

Every other architectural decision follows from this invariant — it is the
reason the pipeline is decoupled through the database instead of chained
through in-memory calls.

## Two source modes

Both coexist permanently. The mode is set per source.

**Classic forwarding** (`flow.enabled: false`, the default) — current Inemuri
behavior, unchanged: replacements, keyword filters, delivery to
`source.destinations`. For channels where a plain mirror is all you need, this
is sufficient and there is no reason to pay for AI.

**TheFlow mode** (`flow.enabled: true`) — the full pipeline below.

Existing sources are untouched until explicitly switched over.

## Locked decisions

| Question | Decision | Rationale |
|---|---|---|
| Canonical language | English, translated as the **first** step | Everything downstream becomes monolingual: embeddings, classification, search, and keyword rules all operate on one representation. Otherwise every stage has to handle Korean, Chinese, and Ukrainian separately |
| Code placement | A module inside Inemuri, behind a hard boundary | Two processes on one SQLite file require WAL and an explicit `busy_timeout`, or they hit `SQLITE_BUSY`. Decoupling through a table already provides the logical separation; extraction into a separate process stays cheap |
| Publish latency | First-wins, no hold window | Speed matters more than completeness: promo codes expire. Completeness is recovered by the `linked` mechanism instead |
| AI providers | Gateway with primary plus fallback | Free tiers have no SLA. The pipeline only ever sees `enrich()` and `embed()` |
| Taxonomy | Two closed axes: topic and signal type | Models choose more accurately from short lists, and the result is a routing matrix rather than two dozen separate destination mappings |
| Deduplication | Three tiers, LLM only in the gray zone | "Is this similar to these 50 posts?" cannot be asked of an LLM directly: expensive, non-deterministic, does not scale |
| Gateway packaging | A module with a clean contract, not an HTTP service | Several in-process consumers is exactly what a module is for — that is the argument for a module, not against one. A separate process would add a server, serialization, auth, and a second failure mode while solving nothing that exists today. The criterion for extraction is a second *process*, and the conditions that would create one are listed in [theflow/LLM_GATEWAY.md](theflow/LLM_GATEWAY.md) |
| Screenshots | Vision transcribes text only, never classifies | The transcription merges into the same text field and the existing pipeline runs unchanged. Classifying from images directly would create a second pipeline with its own reliability and tuning |

## Pipeline

```text
STAGE 1 — INGEST (synchronous, fast, no outbound network)
  parse -> text_replacements -> regex stage -> INSERT posts (pending)
                                                     |
  ------------------------------ seam: everything below reads from the database
                                                     |
STAGE 1.5 — VISION (optional, only on sources that enable it)
  image-only post -> downscale -> hash -> cache -> transcribe -> text_ocr
                                                     |
STAGE 2 — ENRICH (worker, async, queued and rate limited)
  SELECT pending -> gateway.enrich() -> gateway.embed() -> UPDATE (enriched)
                                                     |
  ------------------------------ seam
                                                     |
STAGE 3 — FLOW (delivery)
  deduplicate -> resolve destinations -> download media -> send / edit
```

Details: [theflow/ARCHITECTURE.md](theflow/ARCHITECTURE.md)

## Documents

| File | Covers |
|---|---|
| [theflow/ARCHITECTURE.md](theflow/ARCHITECTURE.md) | Pipeline stages, the pre-AI regex stage, changes to existing code, resilience invariants |
| [theflow/DATA_MODEL.md](theflow/DATA_MODEL.md) | `posts` and `clusters` tables, statuses, indexes, migration order |
| [theflow/TAXONOMY.md](theflow/TAXONOMY.md) | The two classification axes, `categories.json` format, routing matrix |
| [theflow/DEDUPLICATION.md](theflow/DEDUPLICATION.md) | Three deduplication tiers, the `linked` mechanism, handling retractions |
| [theflow/LLM_GATEWAY.md](theflow/LLM_GATEWAY.md) | Provider contract, fallback matrix, quota accounting, priority classes |
| [theflow/VISION.md](theflow/VISION.md) | Screenshot transcription, gates, unverifiable entities, image-borne injection |
| [theflow/DELIVERY.md](theflow/DELIVERY.md) | How a flow post is rendered and kept current: full re-render, entity offsets, corrections, platform limits |
| [theflow/NEWS_INTAKE.md](theflow/NEWS_INTAKE.md) | News outlets as sources: what they give (measured), headline triage, the portable knowledge base |
| [theflow/ROADMAP.md](theflow/ROADMAP.md) | **The work plan.** Current state, per-phase task tables with files and effort, exit gates, sequencing |

## Phases

Each phase is useful on its own and does not require the next one.

> The ordered task breakdown, with files, effort and exit gates, lives in
> [theflow/ROADMAP.md](theflow/ROADMAP.md). Phases added there after this list
> was written: **0.5 (foundation: migrations, schema generalization)**, **3.5
> (Reddit and news adapters)** and **6 (news intake, §14)**; **vision moved to
> phase 1.5**, straight after the gateway. The phase numbered 6 here
> originally (vision) is retired — today's phase 6 is news intake.

### Phase 0 — persistence without AI ✅ implemented

The `posts` table, ingestion writing everything raw, the `flow.enabled` flag on
sources. No AI calls at all.

Produces a corpus of real data for tuning prompts and thresholds offline.
**Useful even if the AI plan is abandoned entirely** — post history is needed
for search and digests in any scenario.

Without this phase, similarity thresholds and category definitions have to be
guessed.

What landed:

- `Source.flow` JSON column (default `{ enabled: false, ... }`), plus
  `getFlowConfig()` / `isFlowEnabled()` / `isVisionEnabled()` on the model.
  `flow` is managed declaratively through `sources.json` (the seeder merges
  partial config with defaults).
- `posts` and `clusters` tables — `src/module/teapot/models/Post.js` and
  `Cluster.js`, full field set from [DATA_MODEL.md](theflow/DATA_MODEL.md).
- `src/module/theflow/RegexStage.js` — the deterministic pre-AI stage:
  rejection (`skipped_blacklist` / `skipped_empty` / `skipped_noise`),
  candidate extraction, normalized-text hashing.
- `src/module/theflow/FlowIngest.js` — stage 1: regex stage → repost check
  over a window → idempotent `INSERT posts`. No outbound network calls.
- `TelegramSourceListener._filterAndProcess()` branches on
  `source.isFlowEnabled()`: replacements are shared, then flow sources persist
  to `posts` (blacklist-only, whitelist disabled) instead of `emit` + media
  download. Classic forwarding is byte-for-byte unchanged.
- Migration: `001-theflow-phase0` via `npm run migrate` — idempotent (creates
  the schema on a fresh database, adopts it on one that already has it). The
  runner backs up before applying and refuses `NODE_ENV=development`.

Deviation from spec: `image_hash` is **not** written during ingest. Recording it
there would require downloading the image, which breaks the "ingestion makes no
outbound network calls" invariant. `has_media` is recorded at ingest;
`image_hash` is filled by a separate pass — `scripts/backfill-image-hash.js`
(dHash via `sharp`, rate-limited, resumable).

### Phase 1 — gateway plus enrichment in shadow mode ✅ implemented

`LLMGateway` (provider registry, RPM/RPD limits, cache, circuit breaker,
priority queue, fallback matrix), `categories.json` v1, and the enrichment
worker are all built — see [theflow/ROADMAP.md](theflow/ROADMAP.md) §3 for the
full breakdown per task. Verdicts are written to `posts`; the resolve stage
and delivery exist (phase 2) — delivery is off by default (shadow mode) and on
in the deployment since 2026-10-06 — and the worker itself does not start
without a primary provider API key in `.env`.
`categories.json` is at v3 (news topics and signals; `games`, `p2e`, `meme` — TAXONOMY.md).

The provider decisions that used to block this phase are settled (§3.1):
Gemini is primary for text, embeddings and vision, with OpenRouter as a
text-only fallback, and the free-tier limits are measured rather than guessed.
The worker still does not start without a primary key in `.env`, so a
deployment with no key ingests into `pending` and stops there.

Exit gate: a week of comparing verdicts against your own judgment
(`node src/cli.js flow review` writes the labels) before enabling enforcement.
Without it there is no basis for trusting the classification.

### Phase 2 — content-based routing ✅ built, delivering to test channels

The resolve stage, lazy media download, the `#unsorted` channel. Classic
forwarding keeps running in parallel. Built (v4.24–v4.58): resolve with
routing by source and `also` rules, the Ukrainian embed template, delivery
records, `flow preview`. On the VPS since 2026-10-06 delivery is on, with
every rule pointing at a staff-only test channel; public channels follow
after the test week.

This is where TheFlow first becomes useful day to day.

### Phase 3 — deduplication, tiers 1 and 2 ✅ built, thresholds open

Exact entity matching, then embeddings with a per-category window. The `linked`
mechanism for posts that arrive late. Built (v4.45, v4.48), with the delta
call that edits a delivered message; the HIGH/LOW thresholds wait for
cross-source posts to calibrate on (§6.8).

Removes the main pain: duplicate spam.

### Phase 4 — entity extraction ✅ built

Promo codes, links, amounts and events into structured JSON: regex candidates
confirmed by the model, every value anchored to the original text (v4.50).

### Phase 5 — digests and feedback ✅ built, reactions deferred

Built on the existing `CronScheduler`. Labels from `flow review` become
few-shot examples (v4.51), now stored in the portable knowledge base
(phase 6). The scheduled digest goes to `digest_destinations`. Reaction
capture (§5.7) is optional and deferred.

### Phase 6 — news intake 🔶 steps 1–3 built

Large news outlets as sources, delivering only what matters to the reader —
[theflow/NEWS_INTAKE.md](theflow/NEWS_INTAKE.md). Built: the knowledge base
(`knowledge_examples`, portable through `flow knowledge export|import`),
discovery through news sitemaps and the WordPress API, and headline triage
(`discovered_items`, a reader profile in the git-ignored `triage.json`,
`flow triage stats|review`). The test week runs on the VPS since
2026-10-06; next, article text for what passed (step 4).

### Phase 1.5 — vision for screenshots (was phase 6) ✅ implemented

Transcription of image-only posts on selected sources, so that screenshots of
tweets and announcements stop being invisible to the pipeline. See
[theflow/VISION.md](theflow/VISION.md).

`VisionStage` runs inside the worker, between ingest and enrichment — never
during ingest, which makes no outbound calls. It takes photos and
image-documents (a screenshot sent as a file, to dodge Telegram's
compression), downscales, hashes perceptually, and reuses a near-identical
image's transcription instead of paying for it twice. The result lands in
`posts.text_ocr` before enrichment runs, so a failed enrichment retry does not
re-transcribe. Enabled per source with `flow.vision.enabled`, off everywhere
by default.

Originally placed last, to avoid tuning transcription quality and classification
quality simultaneously with no way to tell which one produced a bad result. It
moved to 1.5 because vision is required, not optional, and because storing
`text_ocr` separately from `text_en` answers the same question the ordering was
meant to answer — see [theflow/ROADMAP.md](theflow/ROADMAP.md) §4.

`has_media` is already recorded at ingest, and `image_hash` is filled by
`scripts/backfill-image-hash.js`. Their per-source ratio is what decides which
channels get `vision.enabled`.

## Out of scope

- **Scraping Twitter / X.** Twitter is a consumer of the output (material to
  publish), not a source. Reddit and news sites **are** sources (ROADMAP §7,
  §14).
- **Scraping pages that refuse an honest bot.** Paywalls, 401/403 and
  CAPTCHAs are never worked around; such outlets give headlines only
  (NEWS_INTAKE.md §1).
- **Publishing anywhere externally.** TheFlow delivers to your own channels;
  what happens next is your decision.
- **Replacing classic forwarding.** Both modes coexist permanently.
- **A vector database.** At a scale of a few thousand vectors, brute-force
  cosine in plain JavaScript takes single-digit milliseconds. No new
  infrastructure is needed.
- **Numeric "importance" as a drop criterion.** See TAXONOMY.md.

## Open questions

| Question | State |
|---|---|
| Display language | English as canonical is settled. Enrichment returns a one-line `summary_uk`; a post not in Ukrainian is **delivered in Ukrainian** through a separate `translate()` call made only for routed posts (v4.57.0, DELIVERY.md «Translation») — inside the enrichment call the model translated half a post or nothing |
| Quota against real volume | ~~Verify provider RPD before phase 1~~ **Measured (v4.30.0).** Free-tier limits are per model: the complete/vision model allows RPD 500 / RPM 15, the embedding model RPD 1000 / RPM 100. A text post costs one complete call plus one embedding, a screenshot post two complete calls — roughly 250–500 posts a day. As predicted, the daily limit binds first, and it resets on Pacific midnight |
| Similarity thresholds | Can only be tuned on real data. This is the direct argument for phase 0 |
| Deduplication window | Differs per category: a promo code is current for hours, market analysis for days |
| Moving to a paid tier | Free tiers are fine while tuning. Thanks to the gateway, switching later is an adapter swap rather than a pipeline rewrite |
| Vision provider | ~~May be a third provider~~ **Decided (v4.25.0–v4.30.0).** The same Gemini model serves complete and vision, so both draw on one budget, as the provider itself counts them. The capability seam stays: a separate vision provider is a config change, not a code change |
| AI-assisted screening | **Built for news sources (v4.54–v4.56):** headline triage in batches, worker-side, against a reader profile ([theflow/NEWS_INTAKE.md](theflow/NEWS_INTAKE.md)). Extending it to classic sources stays open (ROADMAP §13.8) |

The **engineering** open questions — batch claiming, embedding identity, the
delivery template, retention, stall detection — are tracked separately in
[theflow/ROADMAP.md](theflow/ROADMAP.md) §13.

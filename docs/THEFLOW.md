# TheFlow

> **Status:** Phase 0 (persistence without AI) is implemented. Phase 1 (LLM
> gateway and enrichment, shadow mode) is implemented but **dormant** — it
> only runs once a primary provider API key is configured. Phase 1.5 and
> phases 2–5 are still specification only. This file is the entry point;
> detailed specs and the per-task status live in `docs/theflow/`, in
> particular [ROADMAP.md](theflow/ROADMAP.md) §2–3 and
> [CHANGELOG.md](CHANGELOG.md).

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
| [theflow/ROADMAP.md](theflow/ROADMAP.md) | **The work plan.** Current state, per-phase task tables with files and effort, exit gates, sequencing |

## Phases

Each phase is useful on its own and does not require the next one.

> The ordered task breakdown, with files, effort and exit gates, lives in
> [theflow/ROADMAP.md](theflow/ROADMAP.md). Two phases were added there after this
> list was written — **0.5 (foundation: migrations, schema generalization)** and
> **3.5 (Reddit and news adapters)** — and **vision moved from phase 6 to phase
> 1.5**, straight after the gateway. The former phase 6 is retired.

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
  `flow` is managed declaratively through `Sources.json` (the seeder merges
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

### Phase 1 — gateway plus enrichment in shadow mode ✅ implemented, dormant

`LLMGateway` (provider registry, RPM/RPD limits, cache, circuit breaker,
priority queue, fallback matrix), `categories.json` v1, and the enrichment
worker are all built — see [theflow/ROADMAP.md](theflow/ROADMAP.md) §3 for the
full breakdown per task. Verdicts are written to `posts`, but **routing
ignores them**, and the worker itself does not start without a primary
provider API key in `.env`.

**Still open before this phase is actually running:** the provider decisions
in §11/§3.1 — which Gemini and OpenRouter model ids, whether the OpenRouter
account exposes embeddings, a vision provider, and measured RPD/RPM.

Exit gate: a week of comparing verdicts against your own judgment before
enabling enforcement. Without it there is no basis for trusting the
classification.

### Phase 2 — content-based routing

The resolve stage, lazy media download, the `#unsorted` channel. Classic
forwarding keeps running in parallel.

This is where TheFlow first becomes useful day to day.

### Phase 3 — deduplication, tiers 1 and 2

Exact entity matching, then embeddings with a per-category window. The `linked`
mechanism for posts that arrive late.

Removes the main pain: duplicate spam.

### Phase 4 — entity extraction

Promo codes and events into structured JSON: regex candidates confirmed by the
model, validated against the original text.

Requires phases 1 through 3 to be settled, otherwise extraction runs over
unsorted noise.

### Phase 5 — digests and feedback

Built on the existing `CronScheduler`, which already emits synthetic messages
onto the same bus. Reactions to posts write labels into the database, which
later become few-shot examples.

### Phase 1.5 — vision for screenshots (was phase 6)

Transcription of image-only posts on selected sources, so that screenshots of
tweets and announcements stop being invisible to the pipeline. See
[theflow/VISION.md](theflow/VISION.md).

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
  publish), not a source. Reddit and open news feeds **are** planned as sources —
  see [theflow/ROADMAP.md](theflow/ROADMAP.md) §7.
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
| Display language | English as canonical is settled. If posts should be read in Ukrainian, the same enrichment call can return both `text_en` and `summary_uk` — a few extra output tokens, no additional request |
| Quota against real volume | The full stream now reaches the AI, not the remainder after keyword filtering. Roughly 200+ posts per day times 2 requests is 400–600 per day. The daily limit will bind before the per-minute one; verify provider RPD before phase 1 |
| Similarity thresholds | Can only be tuned on real data. This is the direct argument for phase 0 |
| Deduplication window | Differs per category: a promo code is current for hours, market analysis for days |
| Moving to a paid tier | Free tiers are fine while tuning. Thanks to the gateway, switching later is an adapter swap rather than a pipeline rewrite |
| Vision provider | May be a **third** provider, separate from text and embeddings — the gateway routes per capability. Free vision tiers exist and suit the tuning period. Limits are established in [theflow/ROADMAP.md](theflow/ROADMAP.md) §3.1 |
| AI-assisted screening | Raised, not specified: cheap AI triage of the incoming stream, potentially covering classic sources too. It is a gateway consumer like any other and runs worker-side — ingestion makes no outbound calls. See [theflow/ROADMAP.md](theflow/ROADMAP.md) §13.8 |

The **engineering** open questions — batch claiming, embedding identity, the
delivery template, retention, stall detection — are tracked separately in
[theflow/ROADMAP.md](theflow/ROADMAP.md) §13.

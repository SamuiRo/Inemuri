# TheFlow

> **Status:** phases 0–5 and 1.5 are built and live on the VPS since
> 2026-10-06, delivering to staff-only test channels for a test week before
> public ones; phase 6 (news intake) has steps 1–3. Open: deduplication
> threshold calibration (ROADMAP §6.8), phase 6 step 4 (article text) and
> poll intervals, reactions (§5.7, deferred). Per-task status:
> [theflow/ROADMAP.md](theflow/ROADMAP.md).

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
  parse -> text_replacements -> regex stage (blacklist, noise, repost…) -> INSERT posts (pending)
  news source with triage: -> discovered_items (pending) instead
                                                     |
  ------------------------------ seam: everything below reads from the database
                                                     |
STAGE 2 — ENRICH WORKER (one tick, in this order, rate limited)
  triage headlines -> passes become posts
  vision (sources that enable it) -> text_ocr
  enrich + embed -> enriched
  deduplicate (tiers 1–2) -> cluster, link_role, maybe suppressed
  delta call for linked posts -> adds / corrects / denies
                                                     |
  ------------------------------ seam
                                                     |
STAGE 3 — DELIVERY (own timer, off unless FLOW_DELIVERY_ENABLED)
  resolve destinations -> translate -> lazy media -> render -> send / edit / reply
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

Each phase is useful on its own and does not require the next one. The task
breakdown with versions is [theflow/ROADMAP.md](theflow/ROADMAP.md).

| Phase | What it gives | State |
|---|---|---|
| 0 — persistence | `flow` flag per source, `posts` table, regex stage, idempotent ingest. A corpus to tune prompts and thresholds on — useful even without AI | Built |
| 0.5 — foundation | Migrations, platform-neutral schema, media resolver seam, tests, `flow stats` | Built |
| 1 — enrichment | LLM gateway (Gemini primary, OpenRouter text fallback), `categories.json`, enrich worker, `flow review` labels | Built; starts only with a provider key |
| 1.5 — vision | Screenshots transcribed into `text_ocr` ([VISION.md](theflow/VISION.md)) | Built; off on every source |
| 2 — routing and delivery | Resolve by topic, signal or source, `#unsorted`, Ukrainian template, translation, lazy media, `flow preview` | Built; delivering to staff test channels |
| 3 — deduplication | Tiers 1–2, clusters, the `linked` mechanism and the delta call that edits a delivered message | Built; thresholds uncalibrated, tier 3 not built |
| 3.5 — feeds | Reddit, RSS/Atom, news sitemaps, WordPress API | Built; Reddit needs OAuth credentials |
| 4 — extraction | Promo codes, links, amounts, events, each anchored to the source text | Built |
| 5 — feedback and digests | Few-shot from labels, scheduled digest, history search | Built; reactions deferred |
| 6 — news intake | Knowledge base, discovery, headline triage ([NEWS_INTAKE.md](theflow/NEWS_INTAKE.md)) | Steps 1–3 built; article fetch next |

Classification exit gate: verdicts compared with your own judgment
(`flow review`) often enough to route on — not a fixed number of days.

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
| Similarity thresholds | Can only be tuned on cross-source pairs from the live corpus (ROADMAP §6.8) |
| Market news volume | Materiality rules, corroboration and a daily cap — after the test week (NEWS_INTAKE.md §5) |
| AI screening of classic sources | Headline triage exists for news; extending it to Telegram sources is open (ROADMAP §13.8) |
| Moving to a paid tier | Free tiers are fine while tuning; switching is a config change thanks to the gateway |

Settled and recorded where they live: display language (canonical English,
delivery in Ukrainian through a separate `translate()` — DELIVERY.md),
quota (measured free-tier limits — LLM_GATEWAY.md), vision provider (the same
Gemini model — VISION.md).

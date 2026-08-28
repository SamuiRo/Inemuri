# TheFlow

> **Status:** specification written before any code. Nothing here is implemented yet.
> This file is the entry point; detailed specs live in `docs/theflow/`.

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

## Pipeline

```text
STAGE 1 — INGEST (synchronous, fast, no outbound network)
  parse -> text_replacements -> regex stage -> INSERT posts (pending)
                                                     |
  ------------------------------ seam: everything below reads from the database
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
| [theflow/LLM_GATEWAY.md](theflow/LLM_GATEWAY.md) | Provider contract, fallback matrix, response schemas, caching |

## Phases

Each phase is useful on its own and does not require the next one.

### Phase 0 — persistence without AI

The `posts` table, ingestion writing everything raw, the `flow.enabled` flag on
sources. No AI calls at all.

Produces a corpus of real data for tuning prompts and thresholds offline.
**Useful even if the AI plan is abandoned entirely** — post history is needed
for search and digests in any scenario.

Without this phase, similarity thresholds and category definitions have to be
guessed.

### Phase 1 — gateway plus enrichment in shadow mode

`LLMGateway` with one provider, `categories.json`, the enrichment worker.
Verdicts are written to `posts`, but **routing ignores them**.

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

## Out of scope

- **Scraping Twitter / X.** Sources stay on Telegram. Twitter is a consumer of
  the output (material to publish), not a source.
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

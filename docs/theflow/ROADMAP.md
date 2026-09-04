# TheFlow — work plan

> Related: [../THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
> [DATA_MODEL.md](DATA_MODEL.md) · [TAXONOMY.md](TAXONOMY.md) ·
> [DEDUPLICATION.md](DEDUPLICATION.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md) ·
> [VISION.md](VISION.md)

The other documents in this directory say **what** TheFlow is. This one says
**what to build next, in what order, and how to know a step is finished**.

Effort marks are rough: `S` ≈ half a day, `M` ≈ 1–2 days, `L` ≈ 3–5 days of
focused work.

## 1. Where the work actually stands

Verified against the code and `database/pot.sqlite`, not against the docs.

| Component | State |
|---|---|
| `Source.flow` JSON column, `getFlowConfig()` / `isFlowEnabled()` / `isVisionEnabled()` | done |
| `posts` table — all 31 columns, all 5 indexes | done, present in the live DB |
| `clusters` table | done, present in the live DB |
| `RegexStage` — rejection, candidates, normalized hash | done |
| `FlowIngest` — regex stage → repost window → idempotent insert | done |
| Listener branch in `TelegramSourceListener._filterAndProcess()` | done |
| `scripts/migrate-theflow-phase0.js` | done, already applied |
| `scripts/backfill-image-hash.js` | done, never had input |
| **Sources with `flow.enabled: true`** | **0 of 14** |
| **Rows in `posts`** | **0** |
| Everything from phase 1 onward | not started |

### The blocker

Phase 0 exists as code and as schema, and collects nothing.
`src/config/sources.json` contains no `flow` block at all, so the seeder writes
the default `{ enabled: false }` for every source and the ingest branch is never
taken.

This matters more than it looks. Phase 0 is not a milestone that was reached —
it is a **data-collection instrument that has not been switched on**. Everything
downstream is blocked on the corpus it produces:

- similarity thresholds `HIGH` / `LOW` ([DEDUPLICATION.md](DEDUPLICATION.md)) can
  only be calibrated on real vectors from real traffic;
- the category set and descriptions in `categories.json` are guesses until you
  can see what actually arrives;
- the RPD question in [THEFLOW.md](../THEFLOW.md) ("roughly 200+ posts per day")
  is an estimate, and provider selection in phase 1 depends on the real number;
- whether vision is worth building at all is answered by the share of image-only
  posts per channel — which is exactly what `has_media` plus empty `raw_text`
  measures.

**Turning phase 0 on is task 0, and the corpus needs to run for one to two weeks
before phase 1 starts.** Everything in section 3 below can be built in parallel
while it accumulates — that is the point of doing it first.

## 2. Task 0 — switch phase 0 on (this week)

| # | Task | Files | Effort |
|---|---|---|---|
| 0.1 | Pick the pilot sources and add `"flow": { "enabled": true }` to them | `src/config/sources.json` | S |
| 0.2 | Reseed and verify `flow` landed as parsed JSON, not a string | `npm run seed`, `node src/cli.js list` | S |
| 0.3 | Watch one live cycle: confirm rows appear with a sane `status` distribution | — | S |
| 0.4 | `flow:stats` CLI — the instrument that reads the corpus | `src/cli.js` | M |
| 0.5 | Run `backfill-image-hash.js` once the corpus is non-trivial | `scripts/` | S |

### 0.1 — choosing the pilot set

Do not enable all 14 at once. Pick **3 to 5** channels that between them cover
the cases the pipeline has to handle:

- one high-volume, mostly-text channel — the baseline for volume and repost rate;
- one channel that is heavily reposted by others — the cross-channel dedup case;
- one screenshot-heavy channel — the input to the vision go/no-go decision;
- one non-English channel — the translation-first assumption, measured;
- optionally one low-signal channel — the material `#unsorted` will be made of.

Classic forwarding for these sources stops while they are in flow mode: a flow
source persists to `posts` instead of emitting. Pick channels where a pause in
forwarding is acceptable, or accept that they go quiet during collection.

`mode` is absent for 6 of the 14 entries in `sources.json`; confirm the pilot
sources have an explicit `mode` rather than relying on the default.

### 0.4 — `flow:stats` is not optional

There is currently **no way to look at the corpus** other than opening SQLite by
hand. `node src/cli.js list` reports sources, nothing else. Without a reporting
command the collection period produces a database nobody reads, and phase 1
starts on the same guesses it was supposed to replace.

The command must answer, per channel and in total:

| Question | Query |
|---|---|
| Real daily volume, for the RPD decision | count by day |
| How much the regex stage rejects, and why | histogram over `status` |
| Repost rate | share of `skipped_repost` |
| Is `THEFLOW_MIN_TEXT_LENGTH = 10` right? | length distribution of `raw_text`, and what `skipped_empty` actually caught |
| Is vision worth building? | share of `has_media = true AND length(raw_text) < 200`, **per channel** |
| Are the candidate regexes usable? | how often each `candidates.*` list is non-empty, plus a sample of hits |

The last row deserves attention: `PROMO_RE` is `\b[A-Z0-9]{5,20}\b` filtered to
"contains a digit and a letter". On real text that will also match ticker
symbols, order numbers, and shouty words. The prompt is designed to have the
model confirm candidates, so false positives cost tokens rather than
correctness — but the rate needs to be known before it is priced into phase 1.

**Exit gate for phase 0:** one to two weeks of continuous collection, several
thousand rows, and a `flow:stats` output you have actually read. Then phase 1
starts on measurements instead of assumptions.

## 3. Cross-cutting work — build during the collection window

None of this needs the corpus, and all of it gates a later phase. Doing it while
phase 0 fills is what makes the collection window free.

### 3.1 A test harness (`M`) — do this first

`npm test` is a placeholder that exits 1. That was tolerable while the codebase
was I/O glue with no branching logic to get wrong. It stops being tolerable at
phase 1, because the code being added is exactly the kind that tests pay for:

| Unit | Why it needs a test |
|---|---|
| `RegexStage.evaluate()` | pure function, four rejection paths, five candidate extractors |
| Response schema validation | must reject malformed model output rather than write it |
| Verbatim validation | the entire anti-hallucination guarantee is this one check |
| Cosine similarity, `richness()` | numeric, easy to get subtly wrong, impossible to eyeball |
| Routing resolve | priority order and `when` matching, a pure function over `categories.json` |

Use `node --test` — built into Node 22, no new dependency, and `npm test`
becomes `node --test test/`. The point is not coverage; it is that the units
above are the ones where a silent error corrupts the database rather than
throwing.

### 3.2 Deliveries must return what they sent (`S`)

`clusters.delivered` is specified as `[{platform, channel_id, message_id, sent_at}]`
and the whole `linked` mechanism depends on it — you cannot edit a message whose
ID you never recorded.

Both adapters already return the sent message
(`TelegramDestination.sendMessage()`, `DiscordDestination.sendMessage()`), but
`MessageRouter.sendToDestination()` discards it and returns a boolean. Change it
to return the sent-message identity and propagate that through `routeMessage()`.
This is a small change now and an awkward one after the flow delivery path has
been written on top of the boolean.

### 3.3 `DiscordDestination.editMessage()` (`S`)

Telegram has it (`src/destinations/telegram/TelegramDestination.js:751`).
Discord does not. Phase 3 appends to already-sent messages on both platforms.
Add it with the same signature as the Telegram one, and declare `editMessage()`
on `BaseDestinationAdapter` as an explicitly optional capability so the flow
delivery path can check for it rather than assume it.

### 3.4 `post_feedback` table (`S`)

[TAXONOMY.md](TAXONOMY.md) is right that collecting labels retroactively is
expensive, and the table is a **new** table — plain `sequelize.sync()` creates
it, no migration script needed. Create the model now so that the moment posts
start being delivered in phase 2, the reaction-capture wiring has somewhere to
write. Capture itself lands in phase 2; the table costs nothing today.

### 3.5 Two small defects (`S` together)

- **A case-sensitive blacklist never matches on a flow source.**
  `RegexStage.evaluate()` lowercases the haystack (`raw.toLowerCase()`), but
  `MessageFilter.compileFilter()` keeps the original case in the Set when
  `filters.case_sensitive` is true. A case-sensitive blacklist word containing an
  uppercase letter can therefore never match. Either lowercase both, or carry
  `caseSensitive` into the regex stage.
- **Filename case.** `src/config/app.config.js` imports `./sources.json`, the
  docs and `ARCHITECTURE.md` say `Sources.json`, and the file on disk is
  `sources.json`. Harmless on Windows and macOS, a hard failure on a
  case-sensitive filesystem. Settle on the on-disk name and correct the docs.

## 4. Phase 1 — gateway and enrichment in shadow mode

Starts only after the phase 0 exit gate. Spec: [LLM_GATEWAY.md](LLM_GATEWAY.md),
[TAXONOMY.md](TAXONOMY.md).

| # | Task | Files | Effort |
|---|---|---|---|
| 1.1 | Verify current provider RPD/RPM against the measured volume; pick primary and fallback | — | S |
| 1.2 | `BaseProvider` contract, capability declaration | `src/services/ai/providers/BaseProvider.js` | S |
| 1.3 | `GeminiProvider`, `OpenAICompatProvider` (base-URL parameterized) | `src/services/ai/providers/` | M |
| 1.4 | Response schemas plus validation | `src/services/ai/schemas.js` | M |
| 1.5 | `enrich` prompt with the taxonomy injected, `temperature: 0`, structured output | `src/services/ai/prompts/enrich.js` | M |
| 1.6 | `LLMGateway`: queue, token bucket, TTL cache, RPD counter, priority classes, fallback matrix, tiering | `src/services/ai/LLMGateway.js` | L |
| 1.7 | `categories.json` v1 — written **from what the corpus actually contains** | `src/config/categories.json` | M |
| 1.8 | Enrichment worker: `takePending` → `enrich` → `embed` → validate → update | `src/module/theflow/EnrichWorker.js` | M |
| 1.9 | Wire the worker into `src/inemuri.js` behind `LLM_SHADOW_MODE` | `src/inemuri.js`, `app.config.js`, `.env.example` | S |
| 1.10 | `flow:review` CLI — read verdicts back for the shadow-mode comparison | `src/cli.js` | S |

Notes that change the order of work:

- **1.1 comes first and may change everything after it.** The measured volume
  from `flow:stats` against real provider limits decides whether one free tier
  is viable, whether fallback is mandatory from day one, or whether this starts
  paid. Do not build 1.6 before knowing.
- **1.7 depends on the corpus, not on taste.** Writing `categories.json` before
  reading a few thousand real posts is how you end up with five categories that
  never match anything and one that catches 80% of the traffic.
- **The fallback matrix is the hard part of 1.6.** A single `catch` that
  switches provider on any error burns the fallback quota in an hour. Each row
  of the matrix in [LLM_GATEWAY.md](LLM_GATEWAY.md) is a distinct branch, and
  the local RPD counter is what makes the switch happen before the wall rather
  than after it.
- Fallback and tiering are separate mechanisms with separate config. Conflating
  them means escalating to the expensive model on every `429`.
- `model_used` and `taxonomy_version` are written on **every** verdict. There is
  no debugging a month of drift without them.

**Exit gate:** a week of shadow mode comparing verdicts against your own
judgment on the same posts, using `flow:review`. Routing stays off until the
classification is trustworthy. No shortcut here — enabling enforcement on an
untested taxonomy produces a stream you stop reading in three days.

## 5. Phase 2 — content-based routing

Spec: [TAXONOMY.md](TAXONOMY.md), [ARCHITECTURE.md](ARCHITECTURE.md) §3.

| # | Task | Files | Effort |
|---|---|---|---|
| 2.1 | Resolve stage: `topic` + `signal_type` + `confidence` → destinations | `src/module/theflow/ResolveStage.js` | M |
| 2.2 | `#unsorted` destination, mandatory, wired to every fallthrough | `categories.json` | S |
| 2.3 | Flow delivery path: fetch media lazily by `channel_id` + `message_id`, then send | `src/module/theflow/FlowDelivery.js` | M |
| 2.4 | Record deliveries into `clusters.delivered` (needs 3.2) | | S |
| 2.5 | `status` transitions: `enriched` → `routed` / `unsorted` | | S |
| 2.6 | Reaction capture writing into `post_feedback` (needs 3.4) | `src/module/theflow/` | M |

- Lazy media is as much the point of this phase as routing is: a post that gets
  deduplicated away in phase 3 must never have triggered a video download. The
  re-fetch path — `channel_id` + `message_id` back through GramJS — needs to be
  proven here, before phase 3 depends on it.
- Classic forwarding keeps running untouched for every non-flow source. Do not
  refactor `MessageRouter` to make flow routing "cleaner": the router's contract
  is that `destinations` is already resolved, and the resolve stage fills that
  field. `source.destinations` remains the classic-mode path.
- Everything unmatched goes to `#unsorted`. Nothing is dropped. This is a
  resilience invariant, not a nicety.

**Exit gate:** posts arrive in the right channels, `#unsorted` is small enough to
read daily, and what lands there tells you which category description to fix.

## 6. Phase 3 — deduplication, tiers 1 and 2

Spec: [DEDUPLICATION.md](DEDUPLICATION.md).

| # | Task | Files | Effort |
|---|---|---|---|
| 3.a | Tier 1: exact entity match — code, normalized URL, `text_hash` | `src/module/theflow/Dedup.js` | M |
| 3.b | Tier 2: brute-force cosine over the per-category window | | M |
| 3.c | Cluster lifecycle: create, join, `members_count`, `closed` | | M |
| 3.d | `richness()` and the cheap gate | | S |
| 3.e | Delta call and the `linked` append path, with the caps | `prompts/delta.js` | L |
| 3.f | Decision logging: `s`, tier, `relation`, daily collapse rate per category | | S |
| 3.g | Settle the `skipped_repost` question below | `FlowIngest.js` | M |

### 3.g — a design gap to settle before writing tier 1

`FlowIngest` currently checks `text_hash` **globally**, across all channels, and
marks a match `skipped_repost`. That status is terminal: the row is never
enriched, never assigned a `cluster_id`, and never counted anywhere.

For a repost within one channel that is correct. For the same story appearing
word-for-word on a second channel it is not: that is precisely the tier-1
deduplication case, and "also reported by N more channels" is a feature the spec
asks for. As written, `members_count` will undercount exactly the duplicates
that were cheapest to detect.

Two workable options — pick one before tier 1 is written:

1. Keep the ingest-time check but scope it to the channel, and let stage 3
   tier 1 handle cross-channel hash matches with proper cluster attribution.
2. Keep the global check, and have it attach `cluster_id` and
   `link_role: 'duplicate'` to the skipped row so the count stays honest.

Option 1 is cleaner: it keeps the ingest stage doing one thing and puts all
cluster logic in one place. It costs one more row through enrichment per
cross-channel repost, which the gateway cache absorbs — the normalized text is
identical, so it is a cache hit, not a second call.

### Thresholds

`HIGH = 0.90` and `LOW = 0.75` are **starting points from the spec, not
constants**. Calibrate them against the phase 0 corpus once embeddings exist:
take known-duplicate and known-distinct pairs from real data and look at where
the distributions actually separate. Until tier 3 exists, the gray zone is
treated as a new event and flagged — publishing a duplicate is annoying,
swallowing a real story is worse.

### Non-negotiable

`corrects` and `denies` are **never** suppressed, even when the append cap is
exhausted. A cancelled event with a cheerful announcement still standing is the
single worst failure this system can produce.

## 7. Phases 4–6

Deliberately sketched rather than planned — planning them in detail now would be
planning against thresholds and categories that phases 1–3 will change.

**Phase 4 — entity extraction (`L`).** Regex candidates confirmed by the model,
every verbatim field validated against `raw_text`. It strengthens tier 1
deduplication considerably, which is the argument for doing it after phase 3
rather than before. Requires 1–3 settled, or extraction runs over unsorted noise.

**Phase 5 — digests and feedback (`M`).** Built on the existing `CronScheduler`,
which already emits synthetic messages onto the same bus. The `post_feedback`
table (3.4) and reaction capture (2.6) should already be collecting by then;
this phase is where the labels become few-shot examples.

**Phase 6 — vision (`L`).** Gated on a number, not on enthusiasm: the share of
image-only posts per channel from `flow:stats`. If it is low, phase 6 is not
worth building. Four gates in order, `sharp` for downscale and perceptual hash,
OCR output treated as untrusted data in the prompt, and every OCR-derived entity
carrying `source: "ocr", verified: false` — verbatim validation cannot apply to
text that was never in `raw_text`.

## 8. Sequencing

```text
NOW      task 0 — enable flow on 3–5 sources, build flow:stats
           |
           |  corpus accumulates 1–2 weeks
           |  ── in parallel, none of it needs the corpus ──
           |  3.1 test harness · 3.2 router returns sent ids
           |  3.3 Discord editMessage · 3.4 post_feedback · 3.5 defects
           v
GATE     read flow:stats: real volume, reject rate, image-only share
           |
PHASE 1  provider limits first -> gateway -> categories.json from real data
           |  -> worker -> shadow mode
           v
GATE     one week comparing verdicts by hand
           |
PHASE 2  resolve + #unsorted + lazy media + delivery records
           v
GATE     #unsorted small enough to read daily
           |
PHASE 3  tier 1 -> tier 2 -> clusters -> richness gate -> linked appends
           |  (settle 3.g before writing tier 1)
           v
PHASE 4 extraction   PHASE 5 digests + feedback   PHASE 6 vision (if the number justifies it)
```

## 9. Schema outlook

Worth stating plainly, because "no migrations in this project" is its largest
structural risk: **the `posts` and `clusters` tables already carry the full field
set through phase 5.** Verified against the live database — all 31 columns of
`posts`, including `text_en`, `embedding`, `cluster_id`, `model_used`, and
`taxonomy_version`, exist and are empty.

Consequences:

- phases 1 through 5 add **no columns**, so no further one-off migration scripts
  are needed;
- the only new object is `post_feedback`, a new table, which plain
  `sequelize.sync()` creates;
- if a column does turn out to be needed, it needs a one-off script shaped like
  `scripts/migrate-theflow-phase0.js` — `sync({ alter: true })` rebuilds the
  whole table on SQLite and is not an option on a database holding the corpus.

Back up `database/pot.sqlite` before anything schema-shaped, and never run with
`NODE_ENV=development` — that path uses `force: true` and will recreate tables,
destroying both the sources and the corpus.

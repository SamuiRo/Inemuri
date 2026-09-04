# TheFlow — work plan

> Related: [../THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
> [DATA_MODEL.md](DATA_MODEL.md) · [TAXONOMY.md](TAXONOMY.md) ·
> [DEDUPLICATION.md](DEDUPLICATION.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md) ·
> [VISION.md](VISION.md)

The other documents in this directory say **what** TheFlow is. This one says
**what to build, in what order, and how to know a step is finished**.

Effort marks are rough: `S` ≈ half a day, `M` ≈ 1–2 days, `L` ≈ 3–5 days of
focused work.

## 0. Decisions this plan is built on

Four decisions were settled after the specifications were written. They change
the shape of the plan, not its content.

| Decision | Consequence |
|---|---|
| **Migrations are allowed.** The architecture simply had not needed them before | A real migration runner lands in phase 0.5, and every schema change after it is an ordinary, reviewable step rather than a one-off script |
| **Vision is required**, not conditional | It moves from phase 6 to **phase 1.5**, straight after the gateway. The former phase 6 is retired |
| **Reddit and open news sites are coming** as sources | The schema is generalized **now**, while the corpus is small. The adapters themselves come later, after deduplication works |
| **Providers: Gemini plus OpenRouter** | Fallback is available from day one, and tiering is a model-id change on the same provider. One capability gap needs checking — see 2.1 |

Two further corrections to the previous revision of this plan:

- **The corpus is on the VPS.** The empty `posts` table observed locally is a
  development copy, not the running system. Everything below that reads the
  corpus runs on the VPS; `flow:export` exists so prompt work can happen
  locally.
- **Nothing waits two weeks.** Calibration is not a gate that blocks building —
  it is a checkpoint inside a phase. Thresholds and `categories.json` ship with
  the spec's starting values and get retuned at the checkpoints marked below.

## 1. Phase 0.5 — foundation

Everything here is a prerequisite for something later, and none of it needs AI,
a corpus, or a decision that has not been made. This is the phase to do first
and completely.

### 1.1 Migration runner (`M`)

`sequelize-cli` is in `package.json` but unused, and it fits badly with ESM
(`"type": "module"`) — its migrations are CJS and it wants its own config
loader. A hand-rolled runner is about 80 lines and matches how the rest of this
project is built.

```text
database/migrations/
├── 001-theflow-phase0.js        # adopts the already-applied phase 0 schema
├── 002-generalize-sources.js
└── ...
scripts/migrate.js               # npm run migrate, npm run migrate:status
```

Requirements:

- a `schema_migrations` table (`name` PK, `applied_at`);
- each migration exports `up({ sequelize, queryInterface })`. **Forward-only** —
  no `down()`. A rollback on a database holding an irreplaceable corpus is a
  restore from backup, not a code path;
- the runner takes **one backup per batch** into `database/backups/` before the
  first migration of a run, exactly as `migrate-theflow-phase0.js` does;
- it **refuses to run when `NODE_ENV=development`**, same as the phase 0 script;
- `001` is an **adoption** migration: it detects the phase 0 schema already
  applied on the VPS and records it as applied without touching anything. It
  must be safe to run against both a migrated VPS database and a fresh one;
- `npm run migrate:status` prints applied and pending, and is what you run on
  the VPS before deploying.

Retire `scripts/migrate-theflow-phase0.js` once `001` supersedes it, and drop
the `sequelize-cli` dependency.

**Done when:** `npm run migrate` is a no-op on the VPS database and creates the
full schema on an empty one.

### 1.2 Generalize the schema for non-Telegram sources (`M`)

This is the change that must not be deferred. `posts` is currently
Telegram-shaped in four places, and each one breaks on Reddit or RSS:

| Now | Problem |
|---|---|
| `message_id` INTEGER | Reddit ids are `t3_abc123`; an article's identity is its URL |
| UNIQUE `(channel_id, message_id)` | `channel_id` is a Telegram concept |
| Lazy media re-fetch assumes `channel_id` + `message_id` through GramJS | No such path for an RSS item |
| No `title` field | A news article's title is its highest-signal text, and Telegram has none |

Migration `002-generalize-sources.js`:

| Change | Detail |
|---|---|
| `+ posts.platform` STRING NOT NULL DEFAULT `'telegram'` | Backfilled for existing rows |
| `+ posts.external_id` STRING | Universal item identity. Backfill `= CAST(message_id AS TEXT)` |
| `+ posts.external_url` STRING NULL | Canonical link. For Reddit and news this is also a **tier 1 dedup key** |
| `+ posts.title` TEXT NULL | Article / Reddit title, separate from body |
| `+ posts.author` STRING NULL | Reddit author, article byline |
| `+ posts.media_ref` JSON NULL | Everything stage 3 needs to fetch media later, per platform |
| UNIQUE index `(source_id, external_id)` | Replaces `(channel_id, message_id)` |
| `message_id` becomes nullable, no longer written | Dropped in a later migration once nothing reads it. SQLite is 3.44.2, so `DROP COLUMN` is available when the time comes |

`media_ref` is the field that removes the Telegram assumption from stage 3:

```jsonc
// telegram
{ "kind": "telegram", "channel_id": "-100…", "message_id": 12345, "grouped_id": null }
// reddit / rss
{ "kind": "url", "urls": ["https://…/image.jpg"] }
```

Keep `channel_id` as a denormalized column — it is still the fast lookup key for
Telegram — but stop treating it as part of an item's identity.

`SourceState` needs the same treatment (migration `003`): `last_message_id`
INTEGER only works for Telegram. Add `cursor` JSON, backfill
`{ "last_message_id": <value> }`, and let each adapter define its own cursor
shape — RSS stores a guid plus timestamp, Reddit stores a fullname.

**Done when:** `FlowIngest` writes `platform`, `external_id`, `media_ref`, and
`title`; the Telegram path behaves identically; and nothing in the codebase
reads `posts.message_id`.

### 1.3 Media resolver seam (`S`)

A registry keyed by platform, so stage 3 never learns what a source was:

```js
// src/module/theflow/media/MediaResolver.js
register(platform, resolver)
async resolve(post) -> [{ buffer | path, type, filename }]
```

`TelegramMediaResolver` wraps a GramJS `getMessages` re-fetch by
`media_ref.channel_id` + `media_ref.message_id` and then the existing
`TelegramMediaDownloader`. `UrlMediaResolver` (phase 3.5) fetches
`media_ref.urls` over HTTP.

Writing this now costs half a day and makes phase 3.5 an adapter rather than a
refactor of the delivery path.

### 1.4 Deliveries must return what they sent (`S`)

`clusters.delivered` is specified as `[{platform, channel_id, message_id, sent_at}]`
and the whole `linked` mechanism depends on it — you cannot edit a message whose
id you never recorded.

Both adapters already return the sent message
(`TelegramDestination.sendMessage()`, `DiscordDestination.sendMessage()`), but
`MessageRouter.sendToDestination()` discards it and returns a boolean. Change it
to return the sent-message identity and propagate that through `routeMessage()`.
Small now; awkward once the flow delivery path is written on top of the boolean.

### 1.5 `DiscordDestination.editMessage()` (`S`)

Telegram has it (`src/destinations/telegram/TelegramDestination.js:751`).
Discord does not, and phase 3 appends to already-sent messages on both
platforms. Add it with the same signature, and declare `editMessage()` on
`BaseDestinationAdapter` as an explicitly optional capability so the delivery
path can check for it rather than assume it.

### 1.6 `post_feedback` table (`S`)

New table, so the migration is trivial. Fields per
[DATA_MODEL.md](DATA_MODEL.md): `post_id`, `verdict`
(`good` | `noise` | `wrong_topic` | `missed`), `note`, `created_at`.

It exists this early because `flow:review` (2.7) starts writing labels during
phase 1 shadow mode. That turns a week of manual verdict checking — which you
have to do anyway — into a labelled dataset, at zero extra cost. Collecting
those labels retroactively means re-reading history by hand.

### 1.7 Test harness (`M`)

`npm test` is a placeholder that exits 1. That was tolerable while the codebase
was I/O glue. It stops being tolerable at phase 1, because the code being added
is exactly what tests pay for:

| Unit | Why |
|---|---|
| `RegexStage.evaluate()` | Pure function, four rejection paths, five candidate extractors |
| Response schema validation | Must reject malformed model output rather than write it to the corpus |
| Verbatim validation | The entire anti-hallucination guarantee is this one check |
| Cosine similarity, `richness()` | Numeric, easy to get subtly wrong, impossible to eyeball |
| Routing resolve | Priority order and `when` matching over `categories.json` |
| Quota ledger and circuit breaker | State machines whose failure mode is a burned daily quota |

Use `node --test` — built into Node 22, no new dependency. `npm test` becomes
`node --test test/`. The goal is not coverage; it is that these units fail loudly
instead of silently corrupting the corpus.

### 1.8 `flow:stats` and `flow:export` (`M`)

There is currently no way to read the corpus except opening SQLite by hand.
`node src/cli.js list` reports sources and nothing else.

`flow:stats` — runs on the VPS, answers per source and in total:

| Question | Feeds into |
|---|---|
| Posts per day | 2.1, provider limits |
| Histogram over `status` | Whether the regex stage rejects too much |
| Share of `skipped_repost` | Expected cache hit rate in the gateway |
| Length distribution of `raw_text`, and what `skipped_empty` caught | Whether `THEFLOW_MIN_TEXT_LENGTH = 10` is right |
| Share of `has_media = true AND length(raw_text) < 200`, **per source** | Which sources get `vision.enabled` in 3.x |
| How often each `candidates.*` list is non-empty, with samples | Whether `PROMO_RE` is usable |

That last one matters: `PROMO_RE` is `\b[A-Z0-9]{5,20}\b` filtered to "contains
a digit and a letter", which on real text also matches ticker symbols, order
numbers, and shouty words. False positives cost tokens rather than correctness —
the model confirms candidates, it does not trust them — but the rate needs to be
priced in before phase 1.

`flow:export` — dumps a sanitized sample (`raw_text`, `candidates`, `status`,
`has_media`) to JSONL so prompt and threshold work happens locally without
touching the production database.

### 1.9 Two defects (`S` together)

- **A case-sensitive blacklist never matches on a flow source.**
  `RegexStage.evaluate()` lowercases the haystack (`raw.toLowerCase()`), while
  `MessageFilter.compileFilter()` keeps the original case in the Set when
  `filters.case_sensitive` is true. Carry `caseSensitive` into the regex stage,
  or lowercase both.
- **`sources.json` filename case** — already hit and fixed in production. Make
  the repo and the docs agree with what is deployed so it cannot regress.

### Phase 0.5 exit criteria

- `npm run migrate:status` clean on the VPS;
- a flow source ingests a Telegram post that has `platform`, `external_id`,
  `media_ref`, and no `message_id`;
- `npm test` passes and covers `RegexStage`;
- `flow:stats` output read once, and the pilot source list adjusted from it;
- classic forwarding demonstrably unchanged.

## 2. Phase 1 — gateway and enrichment in shadow mode

Spec: [LLM_GATEWAY.md](LLM_GATEWAY.md), [TAXONOMY.md](TAXONOMY.md).

### 2.1 Provider capability check (`S`) — do this first

Gemini and OpenRouter do not cover the same surface, and the difference decides
the gateway's internals.

| Capability | Gemini | OpenRouter |
|---|---|---|
| `complete` with structured output | `responseSchema` | `response_format: json_schema` — support varies **per model**, verify per model id |
| `vision` | yes | yes, on vision-capable model ids |
| `embed` | yes | **verify** — OpenRouter is a chat-completions gateway and may not expose an embeddings endpoint at all |

If OpenRouter has no embeddings, `embed()` has **exactly one provider**, which
makes deduplication a single point of failure. That is acceptable but must be
handled explicitly rather than discovered in phase 3:

- when `embed()` is unavailable, the worker still writes the verdict and leaves
  `embedding` NULL — the post becomes `enriched`, not `failed`;
- deduplication degrades to tier 1 (exact match), which still works;
- `scripts/backfill-embeddings.js` fills the gaps when the provider returns.

Write down the measured RPD and RPM for each model id you intend to use, against
the real volume from `flow:stats`. This determines whether the free tiers hold.

### 2.2 Provider layer (`M`)

```text
src/services/ai/providers/
├── BaseProvider.js          # complete() / embed() / vision() + capabilities()
├── GeminiProvider.js
└── OpenAICompatProvider.js  # base-URL parameterized; covers OpenRouter and Qwen
```

Each provider declares what it supports:

```js
capabilities() { return { complete: true, embed: true, vision: true }; }
```

The gateway routes each capability to a provider that has it. Vision and text do
not have to come from the same vendor, and with OpenRouter, tiering to a
stronger model is a model-id change rather than a new adapter.

### 2.3 Schemas and validation (`M`)

`src/services/ai/schemas.js` — the `enrich` response schema, plus a validator.

Hand-roll the validator rather than adding `ajv`: the schema is small and fixed,
the interesting checks are custom anyway, and it stays testable. Two layers:

1. **Structural** — required fields present, correct types, and `topic` /
   `signal_type` are members of the **closed enums** from `categories.json`. A
   value outside the enum is a validation failure, never a new category.
2. **Verbatim** — every field claiming to quote the source must appear in
   `raw_text`: promo codes, tickers, links, names. Anything that fails is
   discarded, not corrected.

An invalid response is a failure, not data: the post stays `pending`, `attempts`
increments, `last_error` records why.

### 2.4 Prompts (`M`)

`src/services/ai/prompts/enrich.js` — taxonomy injected from `categories.json`,
`temperature: 0`, structured output on, explicit timeout.

Field order in the schema is load-bearing: **`text_en` first**. The model
normalizes to English, and every field after it describes that canonical
representation. `summary_uk` is optional in the same call — a few output tokens,
no extra request.

Build the untrusted-content delimiter block **now**, even though `text_ocr` is
empty until phase 1.5. Retrofitting it later means changing the prompt after you
have started trusting its output.

### 2.5 `LLMGateway` (`L`)

```js
await gateway.enrich(input, { priority: "critical" })  // -> EnrichResult
await gateway.embed(text,  { priority: "critical" })   // -> Float32Array
await gateway.vision(image, { priority: "normal" })    // -> { text_ocr, description }
```

Internals, each independently testable:

| Part | Note |
|---|---|
| Provider registry | Capability-based routing |
| Token bucket per provider | RPM |
| **Quota ledger** | RPD, **persisted in a table** |
| Circuit breaker per provider | Open on timeout / 5xx / network, periodic probe |
| TTL + size-capped cache | Key = hash of normalized input. Model it on `TelegramDeduplicator` |
| Priority queue, concurrency capped | `critical` / `normal` / `low` |
| Fallback matrix | One branch per row of the table in LLM_GATEWAY.md |

**The quota ledger must be persistent.** An in-memory RPD counter resets on
restart, so after a crash the gateway believes it has a full daily allowance and
drives straight into the wall it was built to avoid. A `provider_quota` table
(`provider`, `day_utc`, `count`, `exhausted_at`) survives restarts. The counter
is **per provider, not per capability** — vision, enrich, and embed all draw on
the same allowance.

Two distinctions that are easy to collapse and expensive to get wrong:

- **Fallback ≠ tiering.** Fallback is the same task on another provider because
  the first is unavailable. Tiering is escalation to a stronger model because
  the result is uncertain. Separate config fields. Conflating them means
  escalating to the expensive model on every `429`.
- **Shed ≠ error.** When quota drops below the reserve, `low` and `normal` work
  is deferred and the caller is told so; the post stays `pending` for a later
  pass. A shed call must never mark a post `failed`.

### 2.6 `categories.json` v1 and the enrichment worker (`M` + `M`)

Write `categories.json` v1 **now**, from the spec's example, and version it at
`1`. It does not need to be right — it needs to exist so verdicts can be
produced and compared. It gets rewritten at the checkpoint below.

`src/module/theflow/EnrichWorker.js`:

```text
timer -> Post.takePending(batch)
      -> [phase 1.5: vision if gated, persisted immediately]
      -> gateway.enrich(raw_text + text_ocr, candidates)
      -> validate (structural, then verbatim)
      -> gateway.embed(text_en)
      -> UPDATE status='enriched', model_used, taxonomy_version, ...
```

Rules:

- `model_used` and `taxonomy_version` on **every** verdict. Without them, a
  month later there is no way to tell a prompt regression from a provider
  switch or an edited category description.
- Attempts are capped; on exhaustion the post becomes `failed` and **stays in
  the table** with `last_error`, replayable after the prompt is fixed.
- The worker imports only `posts` and `LLMGateway` — never Telegram, Discord, or
  the event bus. That boundary is what keeps a later extraction into its own
  process cheap.
- Wire it into `src/inemuri.js` behind `LLM_SHADOW_MODE`, defaulting to true.

### 2.7 `flow:review` (`S`)

The tool that makes shadow mode productive rather than a week of squinting at
SQLite. Shows an enriched post with `raw_text`, `text_en`, `topic`,
`signal_type`, `confidence`, and `model_used`, and takes a one-key verdict that
writes into `post_feedback`.

Those labels are the few-shot examples for phase 5. Nothing else about phase 1
produces them.

### Phase 1 checkpoint and exit

**Checkpoint — after a few hundred enriched posts:** read `#unsorted`-bound
verdicts and everything classified `other`. Whatever keeps landing there is
either a category you need or a description that is too narrow. Rewrite
`categories.json`, bump `version` to 2. `taxonomy_version` in `posts` keeps the
old verdicts interpretable.

**Exit gate:** verdicts you agree with often enough to route on, checked through
`flow:review` — not a fixed number of days. Routing stays off until then;
enabling enforcement on an untested taxonomy produces a stream you stop reading
in three days.

## 3. Phase 1.5 — vision, in shadow

Spec: [VISION.md](VISION.md). Runs inside the enrichment worker, before the
`enrich()` call, never during ingestion.

### 3.1 The gates, in order, cheapest first (`S`)

1. `source.isVisionEnabled()` — off by default; enabling TheFlow does not enable
   vision. Choose the sources from the `flow:stats` image-only share.
2. `length(raw_text) > flow.vision.text_threshold` (≈200) — skip, the image is
   decorative.
3. Perceptual hash already seen recently — cache hit, no call. **The largest
   single saving of the four**; screenshots are reposted as heavily as text.
4. `flow.vision.max_images_per_post` (≈2) — an album of ten is not ten calls.

### 3.2 Local image processing (`M`)

`sharp` is already a dependency (`src/shared/utils.js:177`). Downscale to the
provider's documented optimal dimensions before sending — an image costs
hundreds to thousands of tokens by resolution, and screenshots stay legible
after significant reduction. Compute the dHash on the downscaled grayscale copy.

`scripts/backfill-image-hash.js` already implements dHash; reuse it rather than
writing a second implementation.

### 3.3 Cache and persistence (`S`)

A `vision_cache` table keyed by `image_hash` → `text_ocr`, with a TTL sweep.
Persistent, for the same reason as the quota ledger: a restart must not re-pay
for every screenshot.

**Persist `text_ocr` and `vision_used` immediately after the vision call,
before `enrich()` runs.** If enrichment then fails and the post is retried, the
transcription is already there and is not paid for twice. This is why vision
needs no new status — `text_ocr IS NOT NULL` plus `vision_used` is the marker.

### 3.4 Two hazards, both cheap to close (`S`)

- **Entities from images cannot be verified.** Verbatim validation compares
  against `raw_text`, and OCR text was never there. Every entity extracted from
  a transcription carries `source: "ocr"`, `verified: false`, is marked as
  unverified on delivery, and **never outranks a verified entity in tier 1
  deduplication**. A confidently delivered wrong promo code is worse than no
  promo code.
- **Prompt injection through images.** A screenshot can read "ignore previous
  instructions". OCR output goes into the enrich prompt inside the untrusted
  delimiter block from 2.4, labelled as transcribed content, never as
  instructions. Stakes are low — public channels, no credentials — and the
  mitigation is free.

### Phase 1.5 exit

Vision stays in shadow alongside classification. Because `text_ocr` is stored
separately from `text_en`, you can tell which of the two produced a bad verdict —
which was the original argument for building vision last, and is answered here
by the schema instead of by the ordering. Check transcription quality on a
sample per source, and turn vision off for sources where OCR is noise.

## 4. Phase 2 — content-based routing

Spec: [TAXONOMY.md](TAXONOMY.md), [ARCHITECTURE.md](ARCHITECTURE.md) §3.

| # | Task | Files | Effort |
|---|---|---|---|
| 4.1 | Resolve stage: `topic` + `signal_type` + `confidence` → destinations | `src/module/theflow/ResolveStage.js` | M |
| 4.2 | `#unsorted` destination, wired to every fallthrough | `categories.json` | S |
| 4.3 | Flow delivery: `MediaResolver.resolve(post)` then send | `src/module/theflow/FlowDelivery.js` | M |
| 4.4 | Record deliveries into `clusters.delivered` (needs 1.4) | | S |
| 4.5 | Status transitions `enriched` → `routed` / `unsorted` | | S |
| 4.6 | Reaction capture → `post_feedback` (needs 1.6) | | M |

Resolve is a pure function and is tested as one: rules evaluated in descending
`priority`, first match wins, a single value and an array are equivalent in
`when`, and `confidence` below `flow.min_confidence` forces `#unsorted`
regardless of what matched.

Two things not to get wrong:

- **Lazy media is as much the point as routing.** A post deduplicated away in
  phase 3 must never have triggered a video download. Prove the resolver path
  here, before phase 3 depends on it.
- **Do not refactor `MessageRouter`.** Its contract is that `destinations` is
  already resolved; the resolve stage fills that field, `source.destinations`
  remains the classic-mode path. Classic forwarding keeps running untouched.

**Exit gate:** posts arrive in the right channels, `#unsorted` is small enough to
read daily, and what lands there tells you which category description to fix.

## 5. Phase 3 — deduplication, tiers 1 and 2

Spec: [DEDUPLICATION.md](DEDUPLICATION.md).

| # | Task | Files | Effort |
|---|---|---|---|
| 5.1 | Settle the `skipped_repost` question below | `FlowIngest.js` | M |
| 5.2 | Tier 1: exact match on promo code, normalized URL, `external_url`, `text_hash` | `src/module/theflow/Dedup.js` | M |
| 5.3 | Tier 2: brute-force cosine over the per-category window | | M |
| 5.4 | Cluster lifecycle: create, join, `members_count`, `closed` | | M |
| 5.5 | `richness()` and the cheap gate | | S |
| 5.6 | Delta call and the `linked` append path, with the caps | `prompts/delta.js` | L |
| 5.7 | Decision logging: `s`, tier, `relation`, daily collapse rate per category | | S |
| 5.8 | Threshold calibration from real pairs | | M |

### 5.1 — a design gap to settle before writing tier 1

`FlowIngest` checks `text_hash` **globally**, across all sources, and marks a
match `skipped_repost`. That status is terminal: the row is never enriched,
never assigned a `cluster_id`, never counted.

Within one channel that is correct. For the same story appearing word-for-word
on a second channel it is not — that is precisely the tier 1 case, and "also
reported by N more channels" is a feature the spec asks for. As written,
`members_count` undercounts exactly the duplicates that were cheapest to detect.
This gets worse with news sites, which republish each other verbatim.

Two options; pick one before tier 1 is written:

1. **Scope the ingest-time check to the source**, and let stage 3 tier 1 handle
   cross-source hash matches with proper cluster attribution.
2. Keep the global check, and attach `cluster_id` and `link_role: 'duplicate'`
   to the skipped row so the count stays honest.

Option 1 is cleaner: ingest keeps doing one thing, and all cluster logic lives
in one place. It costs one extra row through enrichment per cross-source repost,
which the gateway cache absorbs — the normalized text is identical, so it is a
cache hit, not a second call.

### 5.8 — thresholds are measured, not assumed

`HIGH = 0.90` and `LOW = 0.75` are starting points from the spec. Calibrate them
once embeddings exist: take known-duplicate and known-distinct pairs from the
corpus and look at where the distributions actually separate. Log the similarity
`s` behind every decision from day one — without it there is nothing to
calibrate against.

The daily collapse rate per category is the main health metric. Too many
collapses means `HIGH` is too low and news is being lost.

### Non-negotiable

`corrects` and `denies` are **never** suppressed, even when the append cap is
exhausted. A cancelled event with a cheerful announcement still standing is the
single worst failure this system can produce.

Until tier 3 exists, the gray zone is treated as a **new event** and flagged.
Publishing a duplicate is annoying; swallowing a real story is worse.

## 6. Phase 3.5 — Reddit and news sources

Deliberately after deduplication. News sites republish each other constantly;
adding them before phase 3 means multiplying the noise the system exists to
remove. With the schema already generalized in 1.2 and the media resolver in
1.3, this phase is adapters and nothing else.

| # | Task | Effort |
|---|---|---|
| 6.1 | `RedditSourceAdapter` — polling, `external_id` = fullname, `external_url` = permalink, `title` populated | M |
| 6.2 | `RssSourceAdapter` — feed polling, `external_id` = guid or URL, cursor in `SourceState.cursor` | M |
| 6.3 | `UrlMediaResolver` for `media_ref.kind: "url"` | S |
| 6.4 | Per-platform rate limiting and polite fetching | S |
| 6.5 | Source config shape for the new platforms in `sources.json` | S |

Notes:

- **No new dependencies needed.** `axios` covers Reddit's JSON endpoints;
  `cheerio` parses RSS and Atom in XML mode as well as HTML.
- **Start with feed content only.** Full-article extraction from the page is a
  separate task with its own failure modes (paywalls, boilerplate, layout
  changes) and should not be bundled into getting the adapter working.
- **`title` is high-signal.** For news and Reddit it usually carries the whole
  event. Feed it to `enrich()` as a distinct field, not concatenated into the
  body.
- Poll politely, respect rate limits and each site's terms, and prefer official
  feeds and APIs over scraping pages.
- Both adapters are polling-only, so the existing `SourceState` cursor pattern
  and `POLLING_CHANNEL_DELAY_MS` apply unchanged.

## 7. Phase 4 — entity extraction

Regex candidates confirmed by the model, every verbatim field validated against
`raw_text`, OCR-derived entities carrying `source: "ocr"`, `verified: false`.

It strengthens tier 1 deduplication considerably — which is the argument for
doing it after phase 3 rather than before — and requires phases 1 through 3 to
be settled, or extraction runs over unsorted noise. Effort: `L`.

## 8. Phase 5 — digests and feedback

Built on the existing `CronScheduler`, which already emits synthetic messages
onto the same bus. By this point `post_feedback` has been collecting since phase
1 through `flow:review` and since phase 2 through reactions; this phase turns
those labels into few-shot examples in the enrich prompt and adds scheduled
digests. Effort: `M`.

A numeric score may be used for **ordering within a digest**. It is never used to
decide whether to deliver — an LLM's numeric score is not reproducible between
calls, and the same post will score 6 and 8 across two runs.

## 9. Sequencing

```text
PHASE 0.5  migrations · schema generalization · media resolver seam
           router returns ids · Discord edit · post_feedback · tests
           flow:stats + flow:export · two defects
              |
              v
PHASE 1    provider capability check FIRST -> providers -> schemas
           -> prompts -> gateway -> categories.json v1 -> worker
           -> shadow mode + flow:review (labels start here)
              |  checkpoint: rewrite categories.json from #unsorted, bump version
              v
PHASE 1.5  vision gates -> downscale + dHash -> cache -> text_ocr
           still in shadow; OCR provenance and injection handling
              |
              v
PHASE 2    resolve -> #unsorted -> lazy media via resolver -> delivery records
              |  gate: #unsorted small enough to read daily
              v
PHASE 3    5.1 first -> tier 1 -> tier 2 -> clusters -> richness gate
           -> linked appends -> threshold calibration
              |
              v
PHASE 3.5  Reddit adapter · RSS adapter · URL media resolver
              |
              v
PHASE 4 extraction        PHASE 5 digests + feedback
```

The former phase 6 is retired: vision is now phase 1.5. Tier 3 LLM adjudication
of the gray zone remains a follow-on task inside phase 3, to be enabled once the
gray-zone volume is known from 5.7's logs.

## 10. What I need from you, and when

| When | What |
|---|---|
| Before phase 0.5 | Current VPS state: `flow:enabled` sources, row count in `posts`, and whether `migrate-theflow-phase0` was applied there |
| Before phase 0.5 | Confirmation that a short forwarding pause on the pilot sources is acceptable while they run in flow mode |
| Before phase 1 | Which OpenRouter model ids you intend to use, and whether OpenRouter exposes embeddings on your account |
| Before phase 1 checkpoint | Your own read of `#unsorted`: which categories are missing, which descriptions are too narrow |
| Before phase 1.5 | Which sources get `vision.enabled`, from the image-only share in `flow:stats` |
| Before phase 2 | The destination channels for the routing matrix, including the `#unsorted` channel |

## 11. Schema and migration discipline

Now that migrations exist, the rules that keep them safe:

- **Forward-only.** No `down()`. Recovery from a bad migration on a database
  holding the corpus is a restore from the backup the runner takes, not a
  reverse migration.
- **Back up before every batch**, into `database/backups/`, as
  `migrate-theflow-phase0.js` already does.
- **Never `sync({ alter: true })` on the VPS.** SQLite has no real `ALTER`, so
  Sequelize rebuilds the whole table — on a table holding the corpus that is a
  copy, a drop, and a rename, with the data at risk in the middle. Explicit
  `ALTER TABLE ... ADD COLUMN` in a migration instead.
- **Never `NODE_ENV=development` against a real database.** That path uses
  `force: true` and recreates tables, destroying both the sources and the
  corpus. Both the runner and the app should refuse it.
- **Declared column types matter on SQLite.** A `JSON` column declared as `TEXT`
  comes back as a raw string despite `DataTypes.JSON` on the model — the phase 0
  script hit this and documents it. New JSON columns (`media_ref`, `cursor`) get
  a declared `JSON` type.
- **Run `npm run migrate:status` on the VPS before every deploy.** A code change
  that assumes a column the deployed database does not have fails at runtime, in
  the ingest path, which is the one place that must never stop.

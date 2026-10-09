# TheFlow — work plan

> Related: [../THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
> [DATA_MODEL.md](DATA_MODEL.md) · [TAXONOMY.md](TAXONOMY.md) ·
> [DEDUPLICATION.md](DEDUPLICATION.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md) ·
> [VISION.md](VISION.md) · [DELIVERY.md](DELIVERY.md) · [NEWS_INTAKE.md](NEWS_INTAKE.md)

The other documents say **what** TheFlow is. This one tracks **what is built,
what is open, and why** — per task, with the version that shipped it. Section
numbers are stable: code comments cite them (`ROADMAP §6.6`). What each
version changed in detail is in [../CHANGELOG.md](../CHANGELOG.md).

## Open work

| # | Task | Waits for |
|---|---|---|
| — | Test week on the VPS (from 2026-10-06): read the staff channels, `#unsorted`, the status board, `flow triage review` | The operator |
| §6.8 | Dedup threshold calibration | Cross-source pairs in the live corpus |
| §14.4 | Article fetch for what passed triage, plus sampled rejects | — |
| §14.5 | Poll intervals per source from real volume | A week of data |
| NEWS_INTAKE §5 | Market rules: materiality, corroboration, daily cap | Test-week labels |
| §6 | Tier 3: LLM adjudication of the dedup gray zone | Gray-zone volume from `flow dedup` |
| §5.7 | Reaction capture → labels | Optional, deferred; probe first (§13.5) |
| §13.8 | AI screening of classic (Telegram) sources | Not specified |

## 0. Decisions this plan is built on

| Decision | Consequence |
|---|---|
| **Migrations are allowed** | A forward-only runner; every schema change is a reviewable step (§12) |
| **Vision is required**, not conditional | Phase 1.5, straight after the gateway |
| **Reddit and news sites are sources** | The schema was generalized early (§2.4), adapters came after deduplication |
| **Providers: Gemini plus OpenRouter** | Fallback from day one; tiering is a model-id change |

## 1. The deployed system before TheFlow

**Superseded (2026-10-06):** the VPS runs a database built new from the
configs (`npm run setup -- --new`). Findings from the 2026-06-07 backup that
still shape decisions:

- **a. A `listener`-only source has no checkpoint** — what it posts while the
  process is down is lost. For TheFlow that is a hole in the corpus: flow
  sources should run `polling` or `both`. (Two pilot sources still run pure
  `listener`; accepted by the operator 2026-10-03, `flow preflight` warns.)
- **b. Everything went to one destination** — the firehose TheFlow exists to
  split. The topic channels now exist (§5.1).
- **c. Hand-kept blacklists described signal types** (winner announcements,
  streams) — hence `giveaway_result` and `stream` (appendix A).

### 1.2 One polling source that did not advance

One polling source's checkpoint had not moved since 2026-05-01 — a dead
channel or broken polling. The status board now answers it: a dead channel
shows up as silent.

## 2. Phase 0.5 — foundation · done

| # | Task | Version | Notes |
|---|---|---|---|
| 2.1 | `scripts/estimate-volume.js` — messages/day per source from the checkpoint delta | v4.3.1 | One-off; needs a Telegram session. `--save-baselines` covers listener sources on a re-run |
| 2.2 | Migration runner: `scripts/migrate.js`, `schema_migrations`, backup per run, refuses `development` | v4.4.0 | `sequelize-cli` dropped |
| 2.3 | `ecosystem.config.cjs`, [DEPLOYMENT.md](../DEPLOYMENT.md) | v4.9.1, v4.59.2 | Deployed 2026-10-06 |
| 2.4 | Platform-neutral `posts` (migrations 002, 003) | v4.5.0 | Identity is `(source_id, external_id)`; `message_id` dropped in 014 |
| 2.5 | Media resolver seam (`src/module/theflow/media/`) | v4.6.0 | `UrlMediaResolver` added in phase 3.5 |
| 2.6 | `sendToDestination()` returns `{ platform, channel_id, message_id, sent_at }`; adapter `capabilities`, `editMessage()`; `post_feedback` (004) | v4.7.0 | |
| 2.7 | `node --test` harness | v4.8.0 | Now `scripts/run-tests.js` on a throwaway database |
| 2.8 | `flow stats`, `flow export`; `case_sensitive` reaches the regex stage | v4.9.0 | |
| 2.9 | Pilot sources enabled | v4.30.1 | Chosen by filter-tuning material, not volume |

## 3. Phase 1 — gateway and enrichment · done

Spec: [LLM_GATEWAY.md](LLM_GATEWAY.md), [TAXONOMY.md](TAXONOMY.md).

| # | Task | Version |
|---|---|---|
| 3.1 | Provider capability check | v4.25.0, v4.30.0 |
| 3.2 | Providers: `BaseProvider`, `GeminiProvider`, `OpenAICompatProvider` | v4.11.0 |
| 3.3 | Schemas and structural + verbatim validation (`schemas.js`, no `ajv`) | v4.10.0 |
| 3.4 | Enrich prompt with the nonced untrusted block | v4.10.0 |
| 3.5 | `LLMGateway`: capability routing, RPM bucket, persistent RPD ledger (005), breaker, cache, priority queue, fallback matrix, tiering, shedding | v4.12.0 |
| 3.6 | `categories.json` v1 and `EnrichWorker` | v4.10.0, v4.12.0 |
| 3.7 | `flow review` | v4.13.0 |

### 3.1 What the capability check decided

- **Gemini is primary for text, vision and embeddings; OpenRouter is a
  text-only fallback.** OpenRouter's `/embeddings` exist and stay unused: a
  fallback vector would sit in another model's space, invisible to dedup and
  search; a `null` can be backfilled by the same model.
- **`text-embedding-004` was shut down on 2026-01-14** and failed silently
  (404 after the quota bump). Default: `gemini-embedding-2` pinned at 768
  dimensions; `task_type` is not sent.
- **Gemini resets RPD at Pacific midnight**, so the ledger takes a per-provider
  time zone (`quotaTimeZone`).
- **Free-tier limits are per model** and only visible in AI Studio:
  `gemini-2.5-flash` and Flash 3.x have RPD 20, so the default is
  `gemini-3.5-flash-lite` (RPD 500, RPM 15) for enrich and vision; the ledger
  counts per `provider:model`.
- Still open: an OpenRouter complete model id with `json_schema` support and a
  key — `LLM_FALLBACK=openrouter` has none; accepted by the operator
  (2026-10-03): when Gemini's quota runs out, TheFlow waits for the reset.

### 3.6 Fixes the live runs forced

- **v4.43.1** — no Gemini enrich call had ever succeeded: `responseSchema`
  rejected `["string","null"]` unions (HTTP 400). `GeminiProvider` translates
  the schema; replay with `flow requeue`.
- **v4.44.1** — a per-minute 429 was read as the daily quota (only `quotaId`
  tells them apart), the bucket allowed 2×RPM in the first minute, retries
  ignored `retryDelay`, a gate refusal burned an attempt.
- **v4.57.2** — a provider-reported daily quota is now final for the day; a
  quota error that survives retries is deferred, never an attempt.

Classification exit gate: verdicts you agree with often enough to route on,
measured through `flow review` — not a fixed number of days.

## 4. Phase 1.5 — vision · done (v4.25.1–v4.29.0)

Spec: [VISION.md](VISION.md). Off on every source. Where the build departed
from the plan:

- **The cache matches by Hamming distance (≤ 10), not hash equality** — a
  recompressed repost lands 4–7 bits away, so an exact key would miss nearly
  every repost.
- **Provenance has three outcomes** — in the text → verified; only in OCR →
  kept, `verified: false`; neither → discarded. Otherwise every screenshot
  code would have been dropped.
- **Media types and the album cap apply before download**, so vision never
  pulls a video to discard it.
- **A shed returns the claim** (`Post.releaseClaim()`); before, a few sheds
  made a post `failed` on its first real error.
- Image documents (`image/png|jpeg|webp`, ≤ 20 MB) are transcribed, format
  checked by magic bytes before decoding.

## 5. Phase 2 — content-based routing · done, test channels configured

Spec: [TAXONOMY.md](TAXONOMY.md), [DELIVERY.md](DELIVERY.md).

| # | Task | State |
|---|---|---|
| 5.1 | Destination channels | Done 2026-10-06: test channels in the staff category; public channels after the test week |
| 5.2 | Resolve stage (`ResolveStage.js`) | v4.24.0; `when.source` and `also` rules v4.58.0 |
| 5.3 | `#unsorted` on every fallthrough, with the reason | v4.47.0 |
| 5.4 | Flow delivery: render, lazy media, send; the template | v4.47.0; Ukrainian embed template v4.58.0; translation v4.57.0 |
| 5.5 | Deliveries recorded in `clusters.delivered`, `posts.delivery` (013) | v4.47.0 |
| 5.6 | `enriched` → `routed` / `unsorted` | v4.47.0 |
| 5.7 | Reaction capture → `post_feedback` | **Deferred** (operator, 2026-10-02): `flow review` is the label source; revisit after the §13.5 probe |

Two rules that held: **lazy media is as much the point as routing** (a
duplicate never triggers a download), and **`MessageRouter` was not
refactored** — resolve fills `destinations`, classic forwarding is untouched.

Exit gate: posts arrive in the right channels, `#unsorted` is small enough to
read daily, and what lands there says which description to fix.

## 6. Phase 3 — deduplication, tiers 1 and 2 · done, thresholds open

Spec: [DEDUPLICATION.md](DEDUPLICATION.md).

| # | Task | State |
|---|---|---|
| 6.1 | Scope of the ingest-time repost check | v4.45.0 — per source (below) |
| 6.2 | Tier 1: verified promo code, normalized URL, `external_url`, `text_hash`, ticker + date | v4.45.0, v4.50.0 |
| 6.3 | Tier 2: cosine over the per-signal window, other sources only | v4.45.0 |
| 6.4 | Cluster lifecycle | v4.45.0 |
| 6.5 | `richness()` and the cheap gate | v4.45.0 |
| 6.6 | Delta call; edits, corrections and denials of delivered messages | v4.48.0 |
| 6.7 | Decision log `posts.dedup` (011), `flow dedup` | v4.45.0 |
| 6.8 | **Threshold calibration** | **Open** |

### 6.1 — the repost check is per source

A global `text_hash` check marked the same text on a *second* channel
`skipped_repost` — a terminal status, never clustered, so "also reported by
N" undercounted exactly the cheapest duplicates. The ingest check is scoped to
the source; cross-source copies are enriched (the gateway cache makes the call
free) and join the event in tier 1.

Also settled in v4.45.0: **tier 2 skips the post's own source** by default
(`DEDUP_TIER2_SAME_SOURCE`) — on the one-source pilot it merged nine pairs at
s 0.90–0.95, all wrong (the same channel template, different items);
**boilerplate URLs** (in ≥ 3 posts of a source in 14 days) are not keys;
**`closed`** is relative to the oldest undecided post, so a backfill can join
clusters of its own time.

### 6.6 — keeping a delivered message current

`prompts/delta.js`, `LLMGateway.delta()` (`normal`, cached by the pair) and
`dedup/DeltaStage.js`: `same` → duplicate, suppressed (never for `security`);
`adds` → linked; `corrects` / `denies` → `correction`, `denies` closes the
cluster. Delivery handles updates before new posts each tick (DELIVERY.md).

### 6.8 — thresholds are measured

`HIGH = 0.90` and `LOW = 0.75` are starting points. Calibrate on
known-duplicate and known-distinct cross-source pairs
(`flow dedup --pairs 30`) and see where the distributions separate; the daily
collapse rate per signal is the health metric — too many collapses means
`HIGH` is too low and news is being lost. With delivery on, `flow dedup
--reset` is refused once a cluster is delivered, so new thresholds apply to
new posts only.

### Non-negotiable

Never suppressed, whatever the gate or the cap says:

- `corrects` and `denies` — a cancelled event with a cheerful announcement
  still standing is the worst failure this system can produce;
- anything with `signal_type: security` — a second report may name the
  contract to stay away from;
- the gray zone, until tier 3 exists: a **new event**, flagged.

## 7. Phase 3.5 — Reddit and news sources · done (v4.49.0)

| # | Task | Where |
|---|---|---|
| 7.1 | Reddit and RSS/Atom polling; `external_id` = fullname / guid or URL; cursor in `SourceState.cursor` | `FeedPoller.js`, `parsers.js` |
| 7.2 | Source config shape: `platform: "rss" \| "reddit"` | `Sourceseeder.js` |
| 7.3 | `UrlMediaResolver` for `media_ref.kind: "url"` | `theflow/media/` |
| 7.4 | Per-host rate limiting and polite fetching | `http.js` |

`src/sources/feeds/`: pure parsers (RSS 2.0, Atom, the Reddit listing),
`http.js` (per-host throttle — 7 s Reddit, 2 s elsewhere; conditional GET;
size cap; `RedditAuth` app-only OAuth), `FeedPoller.js` (per-source schedule,
cursor in `SourceState.cursor`, first poll is a baseline). Feed content only —
no page fetching (that is §14.4). `title` is a separate enrich field and part
of the verbatim check.

**Reddit answers 403 to unauthenticated requests** (found 2026-09-30), so it
needs `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`; without them a source logs
one warning and retries every 6 h. The OAuth path is tested against fakes
only.

## 8. Phase 4 — entity extraction · done (v4.50.0)

Enrich prompt v2: `links[]` with a closed `role`, `amounts[]`, a real `event`,
promo-code expiry. **A normalized value is kept only with its exact words**
(`date_text`, `expires_text`), which are checked verbatim; a malformed
optional item goes to `discarded` instead of failing the post. The model gets
the publication date to resolve dates without a year. Tier 1 gained the
ticker + date key. Older verdicts re-extract with
`flow requeue --status enriched --prompt-below 2`.

## 9. Phase 5 — digests and feedback · done (v4.51.0), reactions deferred

- **Few-shot from labels** (`FewShot.js`): `good` labels, diverse by signal,
  and `wrong_topic` labels with a note, as data in a nonced block; re-read
  hourly; the set's hash is part of the cache key. Since v4.52.0 it reads the
  knowledge base (§14.1).
- **Digest** (`digest/Digest.js`) on `CronScheduler`: canonical posts only,
  not `other`, not below `min_confidence`, not ads, not `giveaway_result` /
  `stream` / `meme`. A deterministic score orders within a section — never
  decides inclusion; `security` is its own section, first.

### 9.1 History search · done (v4.46.0)

`search/HistorySearch.js`: keyword mode over FTS5 `posts_fts` (012) — every
word a quoted prefix, bm25 with title and `text_en` above `raw_text`, no
provider call, works with the quota spent; semantic mode — one `low` embedding,
cosine over the 20 000 most recent vectors of the same model (a 30-day window
found nothing on a history-heavy corpus). Results collapse by cluster. Two
surfaces: `/search` (through `EventBus.request`) and `flow search`.

## 10. Order of what remains

```text
test week -> triage.json tuned, market rules (NEWS_INTAKE §5)
          -> public channels, games/steam routing (HANDOFF)
cross-source posts accumulate -> §6.8 thresholds -> tier 3 if the gray zone is large
§14.4 article fetch -> §14.5 poll intervals
```

## 11. What the operator decides

Day-to-day next steps are in [../HANDOFF.md](../HANDOFF.md). Decisions that
belong to the operator and are still open:

- after the test week: the triage profile, the market cap and corroboration
  rules, which channels go public and with which roles;
- where `tools` goes, and whether esports results become a topic of their own
  or stay `other`;
- Telegram sources for the game channels that wait for one;
- whether to give `LLM_FALLBACK` a model and key, and whether the two pilot
  `listener` sources should switch to `both`.

## 12. Migration discipline

- **Forward-only.** Recovery is a restore from the backup the runner takes.
- **Back up before every batch**, into `database/backups/`.
- **Never `sync({ alter: true })` against a real database.** SQLite has no
  real `ALTER`, so Sequelize rebuilds the table — copy, drop, rename, with the
  corpus at risk in the middle. Explicit `ALTER TABLE … ADD COLUMN` instead.
- **Never `NODE_ENV=development` against a real database.** That path uses
  `force: true` and recreates tables.
- **Declare JSON columns as `JSON`.** A `TEXT` column comes back as a raw
  string despite `DataTypes.JSON` on the model.
- **`npm run migrate:status` before every deploy**, with the service stopped.
  Code that assumes a missing column fails in the ingest path.

## 13. Engineering decisions

Recorded so the reasoning is not re-derived.

**13.1 — claiming: no `enriching` status.** After a crash such rows would stay
claimed forever and need a sweep. Instead: the tick is a chained `setTimeout`
(no overlap by construction); `Post.claimPending(limit)` is one
`UPDATE … SET attempts = attempts + 1 WHERE id IN (…) AND status='pending'`,
so a process killed mid-call counts toward the cap rather than restart-looping
on the same row; `instances: 1`, `exec_mode: "fork"` in pm2, or a second
worker doubles every AI call.

**13.2 — embedding identity.** `embedding_model` and `embedding_dim` on
`posts` and `clusters`; not `model_used`. Vectors are unit length at write
(cosine = dot product), little-endian `Float32Array` with
`buffer.length === dim * 4` checked on read; tier 2 and search never compare
across models; the output dimension is pinned in config.

**13.3 — worker constants** (`ENRICH_TICK_MS`, `ENRICH_BATCH_SIZE`,
`ENRICH_MAX_ATTEMPTS`, cache and reserve) are in LLM_GATEWAY.md
§Configuration. The brake is the token bucket and the RPD ledger, not the
timer.

**13.4 — delivery** is a pure full re-render on every edit, segments with
rebased entity offsets, corrections as a new message (DELIVERY.md). Only
`#unsorted` shows `confidence`, `model_used`, `taxonomy_version`.

**13.5 — reactions probe (open, optional).** Before §5.7: subscribe to
`UpdateMessageReactions` on an own channel and see whether the user client
receives it. If yes, a minimal mapping (👍 `good`, 👎 `noise`, ❓
`wrong_topic`); if not, a reply carrying a keyword (`reply_to_msg_id` links
the post). `missed` cannot be a reaction. `flow review` stays primary.

**13.6 — command surface.** Daily, database-backed tools are `src/cli.js
flow …` subcommands; `scripts/` is for one-off work (migrations, backfills,
`estimate-volume.js`).

**13.7 — history search** got a phase: §9.1.

**13.8 — AI screening of the incoming stream (open).** Headline triage
covers news sources. Extending cheap screening to Telegram sources is not
specified. Whatever it becomes, it runs **worker-side** (ingest makes no
outbound calls) and competes for the same RPD as enrichment.

**13.9 — retention: keep everything** (v4.51.1). `raw_text` is an invariant
and the corpus is the product; an embedding is ~3 KB. Review point: 500k posts
or 2 GB (`FLOW_STORAGE_REVIEW_ROWS`, `FLOW_STORAGE_REVIEW_GB`) — `flow stats`
and `flow health` print the size, crossing it warns at startup.

**13.10 — stall detection** (v4.44.0). `FlowHealth.js`: `enrich_failing`,
`enrich_stalled` (old `pending`, no progress, quota left), `ingest_silent`;
alerts on transitions to `health_destinations`; `flow health` in a terminal.
"Oldest pending" alone is the wrong signal — a provider rejecting every call
turns posts `failed`, not `pending`.

**13.11 — `posts.entities`.** Telegram formatting is MTProto entities with
absolute offsets (GramJS `parseMode` is unreliable for user accounts), so the
original entities are stored at ingest — they cannot be recovered later
without re-fetching.

## 14. Phase 6 — news intake and the knowledge base · steps 1–3 done

Spec: [NEWS_INTAKE.md](NEWS_INTAKE.md). The rule it rests on: **triage on the
headline first, fetch the article after** — a news sitemap gives 200–400
articles a day per outlet, over 90% irrelevant.

| # | Task | State |
|---|---|---|
| 14.1 | `knowledge_examples` (015): portable labels, export/import, backfill; few-shot reads it | v4.52.0 |
| 14.2 | Discovery through `sitemap` and `wpjson` (`sources.feed`, 016); `.xml.gz`, sitemap index → freshest child | v4.53.0 |
| 14.3 | `discovered_items` (017) + triage: deny-list rule, batched model over headlines, 5% of rejects sampled for review | v4.54.0; profile git-ignored v4.55.0 |
| 14.4 | **Article fetch** for what passed (JSON-LD `articleBody` → `<p>`), plus the sampled rejects | **Open** |
| 14.5 | Silent-source alert; poll intervals from real data | Alert done as the status board (v4.58.0, every source); **intervals open** |

## Appendix A — why the taxonomy looks as it does

The spec's first example (`games · market · crypto · tools · other`) did not
fit the 14 original channels: three quarters were Steam drops, airdrop
farming and crypto trading. v1 was drafted from them — topics `steam`,
`airdrop`, `crypto`, `tools`, `other` — and v2/v3 added news and gaming topics
(TAXONOMY.md, Versioning).

**`security`** (hacks, exploits, drains, rug pulls, phishing, compromised
accounts) is a **signal, not a topic** — an exchange hack is `crypto` +
`security`, a Steam scam wave `steam` + `security`. It is distinct from
`outage` ("the service is down" vs "funds or accounts are at risk"). Rules:
never suppressed by dedup, a short 6 h window, and, when it gets a channel,
its own rule at the highest priority across every topic. Three of the
original channels named scam reporting in their titles.

**`giveaway_result` and `stream`** exist because several sources kept
separate blacklists for exactly them: classified once and routed nowhere,
they let those lists shrink.

One tension to keep in mind: a discount post is noise on one source and the
definition of `tools` on another. That is a per-source `flow.topics`
restriction, not a description problem.

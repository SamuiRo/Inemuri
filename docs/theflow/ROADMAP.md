# TheFlow — work plan

> Related: [../THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
> [DATA_MODEL.md](DATA_MODEL.md) · [TAXONOMY.md](TAXONOMY.md) ·
> [DEDUPLICATION.md](DEDUPLICATION.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md) ·
> [VISION.md](VISION.md)

The other documents in this directory say **what** TheFlow is. This one says
**what to build, in what order, and how to know a step is finished**.

Effort marks are rough: `S` ≈ half a day, `M` ≈ 1–2 days, `L` ≈ 3–5 days.

## 0. Decisions this plan is built on

| Decision | Consequence |
|---|---|
| **Migrations are allowed.** The architecture had simply not needed them | A migration runner lands in phase 0.5; every schema change after it is an ordinary reviewable step |
| **Vision is required**, not conditional | It moves from phase 6 to **phase 1.5**, straight after the gateway. The former phase 6 is retired |
| **Reddit and open news sites are coming** as sources | The schema is generalized **now**, while the corpus is small. Adapters come later, after deduplication |
| **Providers: Gemini plus OpenRouter** | Fallback exists from day one; tiering is a model-id change. One capability gap needs checking — see 3.1 |

## 1. Actual state of the deployed system

Read from the VPS backup of 2026-06-07 (`pot.sqlite`, `sources.json`,
`cronjob.config.json`, `cronjobs.js`). The `.env` files in that backup were not
opened.

**The VPS runs a pre-TheFlow version.** Its database has three tables —
`sources`, `sqlite_sequence`, `source_states`. There is no `flow` column, no
`posts`, no `clusters`, and no migration has ever been applied there. The
TheFlow phase 0 code exists only in the repository.

That is a cleaner starting point than a partially migrated production database,
and it changes one thing in the plan: on the VPS, migration `001` **creates** the
phase 0 schema; on the development copy, which already has it, the same
migration **adopts** it. Both paths must work from the same file.

### 1.1 The 14 sources

All active. 8 polling, 6 listener (`mode` absent in `sources.json` defaults to
`listener`).

| Cluster | Sources |
|---|---|
| Steam / games | Source J `listener`, Source N `polling`, Source D `listener`, Source L `listener` |
| Crypto / trading | Source G `polling`, Source I `polling`, Source A `listener`, Source K `listener`, Source F `polling` |
| Airdrops / farming | Source M `polling`, Source H `listener`, Source B `polling`, Source C `polling` |
| Mixed | Source E `polling` |

Five facts from this data that change the plan:

**a. Listener-only sources have no checkpoint.** `SourceState.getOrCreate()` is
called only on the polling path (`TelegramSourceListener.js:148`), and the
backup confirms it: state rows exist for the 8 polling sources and for none of
the 6 listener ones. While the process is down, a listener source loses those
messages permanently — there is nothing to resume from.

For classic forwarding that is a missed forward. For TheFlow it is a hole in the
corpus, which is worse, because the corpus is the thing being built.
**Every flow source should run `polling` or `both`, never pure `listener`.**

**b. Everything goes to one destination.** All 14 sources route to the same
Telegram chat `-100XXXXXXXXXX` and the same Discord channel
`XXXXXXXXXXXXXXXXXXX`. That single firehose *is* the problem TheFlow exists to
solve — and it means the phase 2 routing matrix has no channels to route into
yet. Creating them is a prerequisite, not a detail.

**c. The blacklists describe the taxonomy already.** Four sources carry
hand-maintained blacklists, and their contents are consistent: giveaway results
(`<filter>`, `<filter>`, `<filter>`, `<filter>`), contests
and discounts (`<filter>`, `<filter>`, `<filter>`), streams (`<filter>`,
`<filter>`), release announcements (`<filter>`,
`<filter>`).

These are not per-channel quirks — they are **signal types you do not want**,
maintained by hand in four separate places. This is direct evidence for the
taxonomy in appendix A, and one of the clearest wins TheFlow can deliver: one
`giveaway_result` signal replaces four hand-kept blacklists.

**d. `case_sensitive` is `false` on all 14 sources.** The case-sensitivity
mismatch flagged in the previous revision of this plan is therefore **latent,
not active** — it cannot bite until someone sets `case_sensitive: true`. It
drops from "defect" to "hardening", and moves to 2.8.

**e. No source uses keywords.** Every `filters.keywords` is empty. The decision
to disable the whitelist for flow sources costs nothing here, and the blacklists
carry over into the regex stage unchanged.

Two smaller items worth cleaning up in passing: the `[Sponsored]…[/Sponsored]`
and `@techchannel` replacement pair is copy-pasted into 12 sources and almost
certainly never matches anything; and Source J carries an empty-pattern
replacement (`"pattern": ""` with `is_regex: true`), which is junk config even
though it is a harmless no-op.

### 1.2 Measure the real volume today, without waiting

`source_states.last_message_id` is a Telegram per-channel sequence number. The
backup pins its value for 8 channels at 2026-06-07:

| Source | `last_message_id` at 2026-06-07 |
|---|---|
| Source G | 12283 |
| Source B | 8196 |
| Source M | 5027 |
| Source F | 4353 |
| Source C | 3789 |
| Source N | 3031 |
| Source I | 2745 |
| Source E | 2675 |

This backup is the most recent one, so there is no second snapshot to diff
against — but none is needed. **GramJS can read the current last message id for
each channel directly**, and each row carries its own baseline date in
`updatedAt`. One pass gives real messages-per-day per channel, today:

```text
messages/day  =  (current_id - baseline_id) / days_since(row.updatedAt)
```

Using each row's own `updatedAt` rather than the backup date matters — the rows
were written between 2026-05-01 and 2026-06-07, so a single shared denominator
would understate the busy channels and wildly overstate Source M. Task 2.1 does
this.

The figure counts every message in the channel, deleted and service messages
included, so it is an upper bound rather than an exact post count. For sizing a
provider tier that is the right direction to be wrong in.

One anomaly the same table already shows: **Source M has not advanced since
2026-05-01**, more than a month before the backup, while every other polling
source updated within two days of it. Either the channel is dead or polling for
it is broken. Worth checking before it is considered for the pilot.

## 2. Phase 0.5 — foundation

Everything here is a prerequisite for something later, and none of it needs AI,
a corpus, or an unmade decision. Do it first and completely.

### 2.1 Volume estimate (`S`) — do this before anything else

`scripts/estimate-volume.js` — for each source, read the current last message id
from Telegram (`getMessages` with `limit: 1`), diff it against that source's
`source_states` row, divide by the days since that row's `updatedAt`, and print
messages/day per channel plus the total.

It answers "how much traffic will reach the AI" in one run, from data that
already exists — no waiting, no second snapshot, no TheFlow running.

Three details that decide whether the number is usable:

- **Per-row baselines.** Each `source_states` row has its own `updatedAt`; do not
  divide everything by the backup date.
- **Listener sources have no row.** Six of the fourteen produce no estimate this
  way. Take their current id now as a fresh baseline and re-run the script in a
  few days, or accept that the eight polling sources are a representative
  sample — they include the three busiest channels.
- **Rate limiting.** Fourteen `getMessages` calls with the existing
  `POLLING_CHANNEL_DELAY_MS` pause between them. This is a script, not a hot
  path.

Multiply the result by 2 requests per post (`enrich` + `embed`), subtract what
the regex stage rejects and what the cache absorbs, and compare against the RPD
of the model ids from 3.1. That comparison is the whole input to the provider
decision.

### 2.2 Migration runner (`M`)

`sequelize-cli` is in `package.json`, unused, and fits badly with ESM — its
migrations are CJS and it wants its own config loader. A hand-rolled runner is
about 80 lines and matches how the rest of the project is built.

```text
database/migrations/
├── 001-theflow-phase0.js       # create on the VPS, adopt on the dev copy
├── 002-generalize-sources.js
├── 003-source-cursor.js
└── ...
scripts/migrate.js              # npm run migrate, npm run migrate:status
```

Requirements:

- `schema_migrations` table (`name` PK, `applied_at`);
- each migration exports `up({ sequelize, queryInterface })`. **Forward-only**,
  no `down()` — recovery on a database holding the corpus is a restore from
  backup, not a reverse migration;
- **one backup per batch** into `database/backups/` before the first migration
  of a run, as `migrate-theflow-phase0.js` already does;
- refuses to run under `NODE_ENV=development`;
- `npm run migrate:status` prints applied and pending — run it on the VPS before
  every deploy.

**Migration `001` is the existing script, wrapped, not rewritten.**
`scripts/migrate-theflow-phase0.js` is already idempotent, already takes its own
backup, and already refuses development mode. It handles the VPS case (create)
and the dev case (adopt) correctly today. Wrap it, record it in
`schema_migrations`, and delete the standalone `npm run migrate:theflow` script.

Drop the `sequelize-cli` dependency.

### 2.3 Deploy the current code to the VPS (`M`)

The VPS is several versions behind, on pre-TheFlow code. Nothing else in this
plan can be verified against production until that is closed, and there is no
deployment documentation in the repository at all.

The service runs under pm2. Order matters and is not negotiable:

```bash
pm2 stop inemuri            # 1. stop first — see below
cp database/pot.sqlite ~/pot.sqlite.2026-09-04   # 2. back up off-box too
git pull && npm ci          # 3. deploy code
npm run migrate:status      # 4. inspect, then apply
npm run migrate
pm2 start inemuri           # 5. start
pm2 logs inemuri --lines 100
```

**Stop pm2 before migrating.** Two failure modes otherwise, both nasty: the
running process holds the SQLite file while `ALTER TABLE` runs, and pm2 restarts
on crash — so a process that fails against a half-applied schema restarts into
the same failure in a loop, writing garbage to the log and hammering Telegram
reconnects.

Then verify classic forwarding **before** any source is switched to flow mode.

Two pm2 details worth pinning down in an `ecosystem.config.cjs`:

- **The file must be `.cjs`.** The project is `"type": "module"`, and pm2 loads
  an `ecosystem.config.js` as CommonJS — it fails on an ESM project.
- **`cwd` must be the app root.** `dotenv` resolves `.env` relative to
  `process.cwd()`, so `pm2 start src/inemuri.js` from the wrong directory starts
  a process with no Telegram credentials and no obvious reason why.

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "inemuri",
    script: "src/inemuri.js",
    cwd: "/path/to/Inemuri",
    env: { NODE_ENV: "production" },
    time: true,
  }],
};
```

`NODE_ENV` is set explicitly there because the development path uses
`force: true` and recreates tables. Add `pm2 save` and `pm2 startup` so a reboot
brings it back.

Write the whole procedure into `docs/DEPLOYMENT.md` as part of this task. A
migration that runs after the new code has started is a runtime failure in the
ingest path — the one place that must never stop.

### 2.4 Generalize the schema for non-Telegram sources (`M`)

The change that must not be deferred. `posts` is Telegram-shaped in four places,
and each breaks on Reddit or RSS:

| Now | Problem |
|---|---|
| `message_id` INTEGER | Reddit ids are `t3_abc123`; an article's identity is its URL |
| UNIQUE `(channel_id, message_id)` | `channel_id` is a Telegram concept |
| Lazy media re-fetch assumes `channel_id` + `message_id` via GramJS | No such path for an RSS item |
| No `title` field | A news headline is the highest-signal text there is; Telegram has none |

Migration `002-generalize-sources.js`:

| Change | Detail |
|---|---|
| `+ posts.platform` STRING NOT NULL DEFAULT `'telegram'` | Backfilled |
| `+ posts.external_id` STRING | Universal item identity. Backfill `CAST(message_id AS TEXT)` |
| `+ posts.external_url` STRING NULL | Canonical link. For Reddit and news also a **tier 1 dedup key** |
| `+ posts.title` TEXT NULL | Headline, separate from body |
| `+ posts.author` STRING NULL | Reddit author, article byline |
| `+ posts.media_ref` JSON NULL | What stage 3 needs to fetch media later, per platform |
| UNIQUE `(source_id, external_id)` | Replaces `(channel_id, message_id)` |
| `message_id` nullable, no longer written | Dropped in a later migration once nothing reads it. SQLite on the VPS is 3.44.2, so `DROP COLUMN` is available |

`media_ref` is what removes the Telegram assumption from stage 3:

```jsonc
{ "kind": "telegram", "channel_id": "-100…", "message_id": 12345, "grouped_id": null }
{ "kind": "url", "urls": ["https://…/image.jpg"] }
```

Keep `channel_id` as a denormalized column — it is still the fast Telegram
lookup key — but stop treating it as part of an item's identity.

Migration `003-source-cursor.js`: `SourceState.last_message_id` INTEGER is
Telegram-only. Add `cursor` JSON, backfill `{ "last_message_id": <value> }`, and
let each adapter define its own cursor shape — RSS stores a guid plus timestamp,
Reddit stores a fullname.

**Done when:** `FlowIngest` writes `platform`, `external_id`, `media_ref`, and
`title`; Telegram behaves identically; nothing reads `posts.message_id`.

### 2.5 Media resolver seam (`S`)

```js
// src/module/theflow/media/MediaResolver.js
register(platform, resolver)
async resolve(post) -> [{ buffer | path, type, filename }]
```

`TelegramMediaResolver` re-fetches by `media_ref` through GramJS `getMessages`,
then reuses `TelegramMediaDownloader`. `UrlMediaResolver` arrives in phase 3.5.
Half a day now turns phase 3.5 into an adapter instead of a refactor of the
delivery path.

### 2.6 Delivery, edit, and feedback plumbing (`S` each)

- **Deliveries must return what they sent.** `clusters.delivered` is
  `[{platform, channel_id, message_id, sent_at}]`, and the `linked` mechanism
  cannot edit a message whose id was never recorded. Both adapters already
  return the sent message; `MessageRouter.sendToDestination()` discards it and
  returns a boolean. Return the identity and propagate it.
- **`DiscordDestination.editMessage()`.** Telegram has it
  (`src/destinations/telegram/TelegramDestination.js:751`); Discord does not, and
  phase 3 appends on both. Declare `editMessage()` on `BaseDestinationAdapter` as
  an explicitly optional capability so the delivery path can check rather than
  assume.
- **`post_feedback` table.** New table, trivial migration. It exists this early
  because `flow:review` (3.7) starts writing labels during phase 1 shadow mode,
  turning verdict-checking you have to do anyway into a labelled dataset.

### 2.7 Test harness (`M`)

`npm test` exits 1. That was tolerable while the codebase was I/O glue; it stops
being tolerable at phase 1.

| Unit | Why |
|---|---|
| `RegexStage.evaluate()` | Pure function, four rejection paths, five candidate extractors |
| Schema validation | Must reject malformed model output rather than write it to the corpus |
| Verbatim validation | The entire anti-hallucination guarantee is this one check |
| Cosine similarity, `richness()` | Numeric, easy to get subtly wrong, impossible to eyeball |
| Routing resolve | Priority order and `when` matching over `categories.json` |
| Quota ledger, circuit breaker | State machines whose failure mode is a burned daily quota |

`node --test` — built into Node 22, no new dependency. `npm test` becomes
`node --test test/`. The goal is not coverage; it is that these units fail loudly
instead of silently corrupting the corpus.

### 2.8 `flow:stats`, `flow:export`, and hardening (`M`)

`flow:stats` (runs on the VPS) — per source and total: posts per day, histogram
over `status`, share of `skipped_repost`, length distribution of `raw_text`,
share of `has_media = true AND length(raw_text) < 200` (which decides vision per
source), and how often each `candidates.*` list is non-empty with samples.

That last one matters: `PROMO_RE` is `\b[A-Z0-9]{5,20}\b` filtered to "contains
a digit and a letter", which on real text also matches tickers, order numbers,
and shouty words. False positives cost tokens rather than correctness — the model
confirms candidates, it does not trust them — but the rate must be priced in.

`flow:export` — sanitized JSONL sample for local prompt work.

Hardening, same task: carry `caseSensitive` into `RegexStage` (latent bug, see
1.1d); drop the copy-pasted no-op replacements and the empty pattern in Source J.

### 2.9 Enable the pilot (`S`)

Concrete recommendation from 1.1, all polling so restarts cannot punch holes:

| Source | Why |
|---|---|
| **Source G** | Highest message id — the volume baseline |
| **Source B** | Second highest, airdrop domain, a likely screenshot channel |
| **Source N** | Steam drops with the richest blacklist — the `promo_code` / `freebie` case |
| **Source E** | Giveaway noise — the material `#unsorted` will be made of |
| **Source C** *(optional)* | Overlaps Source B and Source M — the cross-source repost case |

Leave the Steam listener channels forwarding classically. If a screenshot-heavy
channel turns out to be listener-mode, switch it to `both` rather than
`polling` — that keeps latency and gains a checkpoint.

Do **not** include Source M until the stale checkpoint from 1.2 is explained.

### Phase 0.5 exit criteria

- VPS running current code, `npm run migrate:status` clean, classic forwarding
  verified unchanged;
- `flow:volume` has produced real messages/day per channel;
- a flow post ingests with `platform`, `external_id`, `media_ref`, no
  `message_id`;
- `npm test` passes and covers `RegexStage`;
- the pilot sources are producing rows and `flow:stats` has been read once.

## 3. Phase 1 — gateway and enrichment in shadow mode

Spec: [LLM_GATEWAY.md](LLM_GATEWAY.md), [TAXONOMY.md](TAXONOMY.md).

### 3.1 Provider capability check (`S`) — first

| Capability | Gemini | OpenRouter |
|---|---|---|
| `complete` structured output | `responseSchema` | `response_format: json_schema` — support varies **per model id**, verify each |
| `vision` | yes | yes, on vision-capable model ids |
| `embed` | yes | **verify** — OpenRouter is a chat-completions gateway and may not expose embeddings at all |

If OpenRouter has no embeddings, `embed()` has exactly one provider and
deduplication becomes a single point of failure. Acceptable, but handled
explicitly rather than discovered in phase 3:

- when `embed()` is unavailable the worker still writes the verdict and leaves
  `embedding` NULL — the post becomes `enriched`, not `failed`;
- deduplication degrades to tier 1, which still works;
- `scripts/backfill-embeddings.js` fills the gaps when the provider returns.

Vision is checked in the same pass, and may land on a **third provider**: the
gateway routes per capability, so a vendor used for nothing but `vision()` is an
ordinary configuration. Free vision tiers exist and are the right choice while
the gates are being tuned. Record per candidate: RPD, maximum input resolution
and bytes, accepted formats, and whether a per-transcription confidence signal
is returned — see [VISION.md](VISION.md) §"Choosing a vision provider".

Record measured RPD and RPM per model id against the real volume from 2.1.

### 3.2 Provider layer (`M`)

```text
src/services/ai/providers/
├── BaseProvider.js          # complete() / embed() / vision() + capabilities()
├── GeminiProvider.js
└── OpenAICompatProvider.js  # base-URL parameterized: OpenRouter, Qwen, others
```

Each provider declares `capabilities()`; the gateway routes each capability to a
provider that has it. Vision and text need not come from the same vendor, and
with OpenRouter, tiering to a stronger model is a model-id change.

### 3.3 Schemas and validation (`M`)

`src/services/ai/schemas.js`. Hand-roll the validator rather than adding `ajv`:
the schema is small and fixed, the interesting checks are custom anyway, and it
stays testable.

1. **Structural** — required fields, correct types, and `topic` / `signal_type`
   are members of the **closed enums** from `categories.json`. A value outside
   the enum is a validation failure, never a new category.
2. **Verbatim** — every field claiming to quote the source must appear in
   `raw_text`: promo codes, tickers, links, names. Failures are discarded, not
   corrected.

An invalid response is a failure, not data: the post stays `pending`, `attempts`
increments, `last_error` records why.

### 3.4 Prompts (`M`)

`prompts/enrich.js` — taxonomy injected from `categories.json`,
`temperature: 0`, structured output, explicit timeout.

Field order is load-bearing: **`text_en` first**. The model normalizes to
English and every later field describes that canonical representation.
`summary_uk` is optional in the same call — a few output tokens, no extra
request.

Build the untrusted-content delimiter block **now**, while `text_ocr` is still
empty. Retrofitting it after you have started trusting the output is worse.

### 3.5 `LLMGateway` (`L`)

```js
await gateway.enrich(input,  { priority: "critical" })
await gateway.embed(text,    { priority: "critical" })
await gateway.vision(image,  { priority: "normal" })
```

| Part | Note |
|---|---|
| Provider registry | Capability-based routing |
| Token bucket per provider | RPM |
| **Quota ledger** | RPD, **persisted in a table** |
| Circuit breaker per provider | Open on timeout / 5xx / network, periodic probe |
| TTL + size-capped cache | Key = hash of normalized input; model it on `TelegramDeduplicator` |
| Priority queue, concurrency capped | `critical` / `normal` / `low` |
| Fallback matrix | One branch per row of the table in LLM_GATEWAY.md |

**The quota ledger must be persistent.** An in-memory RPD counter resets on
restart, so after a crash the gateway believes it has a full allowance and drives
into the wall it was built to avoid. A `provider_quota` table (`provider`,
`day_utc`, `count`, `exhausted_at`) survives restarts. The counter is **per
provider, not per capability** — enrich, embed, and vision share one allowance.

Two distinctions that are cheap to keep and expensive to lose:

- **Fallback ≠ tiering.** Fallback is the same task on another provider because
  the first is unavailable; tiering is escalation to a stronger model because the
  result is uncertain. Separate config. Conflating them means escalating to the
  expensive model on every `429`.
- **Shed ≠ error.** Below the reserve threshold, `low` and `normal` work is
  deferred and the caller is told; the post stays `pending`. A shed call must
  never mark a post `failed`.

### 3.6 `categories.json` v1 and the enrichment worker (`M` + `M`)

Write `categories.json` v1 now, from **appendix A** — which is derived from the
real channel mix and the existing blacklists, not from the spec's generic
example. Version it `1`. It does not need to be right; it needs to exist so
verdicts can be produced and compared.

`src/module/theflow/EnrichWorker.js`:

```text
timer -> Post.takePending(batch)
      -> [phase 1.5: vision if gated, persisted immediately]
      -> gateway.enrich(raw_text + title + text_ocr, candidates)
      -> validate (structural, then verbatim)
      -> gateway.embed(text_en)
      -> UPDATE status='enriched', model_used, taxonomy_version, ...
```

- `model_used` and `taxonomy_version` on **every** verdict — without them, a
  month later there is no telling a prompt regression from a provider switch.
- Attempts capped; on exhaustion the post becomes `failed` and **stays** with
  `last_error`, replayable after the prompt is fixed.
- The worker imports only `posts` and `LLMGateway` — never Telegram, Discord, or
  the event bus. That boundary keeps a later extraction into its own process
  cheap.
- Wired into `src/inemuri.js` behind `LLM_SHADOW_MODE`, default true.

### 3.7 `flow:review` (`S`)

Shows an enriched post — `raw_text`, `text_en`, `topic`, `signal_type`,
`confidence`, `model_used` — and takes a one-key verdict into `post_feedback`.
It makes shadow mode productive instead of a week of squinting at SQLite, and it
is the only thing in phase 1 that produces the few-shot examples phase 5 needs.

### Phase 1 checkpoint and exit

**Checkpoint, after a few hundred verdicts:** read everything classified `other`
or headed for `#unsorted`. Whatever keeps landing there is either a missing
category or a description that is too narrow. Rewrite `categories.json`, bump
`version` to 2; `taxonomy_version` keeps the old verdicts interpretable.

**Exit gate:** verdicts you agree with often enough to route on, measured through
`flow:review` — not a fixed number of days. Routing stays off until then.

## 4. Phase 1.5 — vision, in shadow

Spec: [VISION.md](VISION.md). Runs inside the enrichment worker, before
`enrich()`, never during ingestion.

**Gates, cheapest first (`S`):** `source.isVisionEnabled()`, off by default and
chosen from the image-only share in `flow:stats` → `length(raw_text) >
vision.text_threshold` (≈200) skips decorative images → perceptual hash already
seen (**the largest single saving**; screenshots are reposted as heavily as
text) → `vision.max_images_per_post` (≈2).

**Local processing (`M`).** `sharp` is already a dependency
(`src/shared/utils.js:177`). Downscale to the provider's optimal dimensions
before sending — an image costs hundreds to thousands of tokens by resolution,
and screenshots stay legible after significant reduction. Compute the dHash on
the downscaled grayscale copy, reusing the implementation already in
`scripts/backfill-image-hash.js`.

**Cache and persistence (`S`).** A `vision_cache` table keyed by `image_hash` →
`text_ocr`, with a TTL sweep; persistent for the same reason as the quota
ledger. **Persist `text_ocr` and `vision_used` immediately after the vision call,
before `enrich()` runs** — if enrichment then fails and retries, the
transcription is not paid for twice. This is why vision needs no new status:
`text_ocr IS NOT NULL` plus `vision_used` is the marker.

**Two hazards, both free to close (`S`).**

- *Entities from images cannot be verified.* Verbatim validation compares against
  `raw_text`, and OCR text was never there. Every entity from a transcription
  carries `source: "ocr"`, `verified: false`, is marked unverified on delivery,
  and **never outranks a verified entity in tier 1 deduplication**. A
  confidently delivered wrong promo code is worse than none.
- *Prompt injection through images.* OCR output goes into the enrich prompt
  inside the untrusted delimiter block from 3.4, labelled as transcribed
  content, never as instructions.

**Exit:** vision stays in shadow alongside classification. Because `text_ocr` is
stored separately from `text_en`, you can tell which of the two produced a bad
verdict — the concern that originally pushed vision to last is answered by the
schema instead of by the ordering. Check transcription quality per source and
disable vision where OCR is noise.

## 5. Phase 2 — content-based routing

Spec: [TAXONOMY.md](TAXONOMY.md), [ARCHITECTURE.md](ARCHITECTURE.md) "Stage 3 — Flow".

| # | Task | Files | Effort |
|---|---|---|---|
| 5.1 | **Create the destination channels** — see 1.1b; today there is exactly one | — | S |
| 5.2 | Resolve stage: `topic` + `signal_type` + `confidence` → destinations | `ResolveStage.js` | M |
| 5.3 | `#unsorted`, wired to every fallthrough | `categories.json` | S |
| 5.4 | Flow delivery: `MediaResolver.resolve(post)` then send | `FlowDelivery.js` | M |
| 5.5 | Record deliveries into `clusters.delivered` (needs 2.6) | | S |
| 5.6 | Status transitions `enriched` → `routed` / `unsorted` | | S |
| 5.7 | Reaction capture → `post_feedback` (needs 2.6) | | M |

Resolve is a pure function and is tested as one: rules in descending `priority`,
first match wins, a single value equals a one-element array in `when`, and
`confidence` below `flow.min_confidence` forces `#unsorted` regardless of what
matched.

Two things not to get wrong:

- **Lazy media is as much the point as routing.** A post deduplicated away in
  phase 3 must never have triggered a video download. Prove the resolver path
  here, before phase 3 depends on it.
- **Do not refactor `MessageRouter`.** Its contract is that `destinations` is
  already resolved; the resolve stage fills that field, `source.destinations`
  remains the classic path. Classic forwarding keeps running untouched.

**Exit gate:** posts arrive in the right channels, `#unsorted` is small enough to
read daily, and what lands there tells you which description to fix.

## 6. Phase 3 — deduplication, tiers 1 and 2

Spec: [DEDUPLICATION.md](DEDUPLICATION.md).

| # | Task | Effort |
|---|---|---|
| 6.1 | Settle the `skipped_repost` question below | M |
| 6.2 | Tier 1: exact match on promo code, normalized URL, `external_url`, `text_hash` | M |
| 6.3 | Tier 2: brute-force cosine over the per-category window | M |
| 6.4 | Cluster lifecycle: create, join, `members_count`, `closed` | M |
| 6.5 | `richness()` and the cheap gate | S |
| 6.6 | Delta call and the `linked` append path, with the caps | L |
| 6.7 | Decision logging: `s`, tier, `relation`, daily collapse rate per category | S |
| 6.8 | Threshold calibration from real pairs | M |

### 6.1 — settle before writing tier 1

`FlowIngest` checks `text_hash` **globally**, across all sources, and marks a
match `skipped_repost` — a terminal status: never enriched, never assigned a
`cluster_id`, never counted.

Within one channel that is correct. For the same story appearing word-for-word
on a second channel it is not — that is precisely the tier 1 case, and "also
reported by N more channels" is a feature. As written, `members_count`
undercounts exactly the duplicates that were cheapest to detect. The overlap
between Source B, Source C, and Source M makes this immediate, and
news sites in phase 3.5 make it severe.

1. **Scope the ingest-time check to the source**, and let stage 3 tier 1 handle
   cross-source hash matches with proper cluster attribution.
2. Keep the global check, and attach `cluster_id` and `link_role: 'duplicate'`
   to the skipped row so the count stays honest.

Option 1 is cleaner: ingest keeps doing one thing and all cluster logic lives in
one place. It costs one extra row through enrichment per cross-source repost,
which the gateway cache absorbs — identical normalized text is a cache hit, not
a second call.

### 6.8 — thresholds are measured

`HIGH = 0.90` and `LOW = 0.75` are starting points. Calibrate on known-duplicate
and known-distinct pairs from the corpus and see where the distributions
actually separate. Log the similarity `s` behind every decision from day one —
without it there is nothing to calibrate against. The daily collapse rate per
category is the health metric: too many collapses means `HIGH` is too low and
news is being lost.

### Non-negotiable

Three things are never suppressed, whatever the dedup gate or the append cap
says:

- `corrects` and `denies` — a cancelled event with a cheerful announcement still
  standing is the worst failure this system can produce;
- **anything with `signal_type: security`** — a second channel reporting the same
  exchange hack may be the one that names the contract to stay away from, and a
  `denies` on a hack rumour is exactly the retraction you must see;
- the gray zone, until tier 3 exists: it is treated as a **new event** and
  flagged. Publishing a duplicate is annoying, swallowing a real story is worse.

Security is also where first-wins is at its most valuable and its most
dangerous: the fastest report of a hack is the one you want, and it is also the
one most likely to be a rumour. That combination is precisely what the
`linked` / `corrects` / `denies` mechanism exists for — publish immediately,
and let the correction always through.

## 7. Phase 3.5 — Reddit and news sources

After deduplication, deliberately: news sites republish each other constantly,
and adding them earlier multiplies the noise the system exists to remove. With
the schema generalized in 2.4 and the resolver seam in 2.5, this is adapters and
nothing else.

| # | Task | Effort |
|---|---|---|
| 7.1 | `RedditSourceAdapter` — polling; `external_id` = fullname, `external_url` = permalink, `title` populated | M |
| 7.2 | `RssSourceAdapter` — feed polling; `external_id` = guid or URL, cursor in `SourceState.cursor` | M |
| 7.3 | `UrlMediaResolver` for `media_ref.kind: "url"` | S |
| 7.4 | Per-platform rate limiting and polite fetching | S |
| 7.5 | Source config shape for the new platforms | S |

- **No new dependencies.** `axios` covers Reddit's JSON endpoints; `cheerio`
  parses RSS and Atom in XML mode as well as HTML.
- **Feed content only at first.** Full-article extraction from the page has its
  own failure modes — paywalls, boilerplate, layout drift — and should not be
  bundled into getting the adapter working.
- **`title` is high-signal.** For news and Reddit it usually carries the whole
  event. Pass it to `enrich()` as a distinct field, not concatenated into the
  body.
- Poll politely, respect rate limits and each site's terms, prefer official feeds
  and APIs over scraping.
- Both are polling-only, so the existing cursor pattern and
  `POLLING_CHANNEL_DELAY_MS` apply unchanged.

## 8. Phase 4 — entity extraction

Regex candidates confirmed by the model, every verbatim field validated against
`raw_text`, OCR-derived entities carrying `source: "ocr"`, `verified: false`.
Strengthens tier 1 considerably — the argument for doing it after phase 3 — and
requires 1–3 settled, or extraction runs over unsorted noise. `L`.

## 9. Phase 5 — digests and feedback

Built on the existing `CronScheduler`, which already emits synthetic messages
onto the same bus (`cronjobs.js` shows the shape). By then `post_feedback` has
been collecting since phase 1 via `flow:review` and since phase 2 via reactions;
this phase turns those labels into few-shot examples and adds scheduled digests.
`M`.

A numeric score may order posts **within** a digest. It is never used to decide
whether to deliver: an LLM's numeric score is not reproducible between calls, and
the same post will score 6 and 8 across two runs.

## 10. Sequencing

```text
PHASE 0.5  volume estimate -> migration runner -> deploy VPS + migrate
           schema generalization -> resolver seam -> delivery ids -> Discord edit
           post_feedback -> tests -> flow:stats/export -> enable pilot
              |
              v
PHASE 1    provider capability check FIRST -> providers -> schemas -> prompts
           -> gateway -> categories.json v1 (appendix A) -> worker
           -> shadow mode + flow:review (labels start here)
              |  checkpoint: rewrite categories.json, bump version
              v
PHASE 1.5  vision gates -> downscale + dHash -> cache -> text_ocr; still shadow
              |
              v
PHASE 2    create destination channels -> resolve -> #unsorted
           -> lazy media via resolver -> delivery records
              |  gate: #unsorted small enough to read daily
              v
PHASE 3    6.1 first -> tier 1 -> tier 2 -> clusters -> richness gate
           -> linked appends -> threshold calibration
              |
              v
PHASE 3.5  Reddit adapter · RSS adapter · URL media resolver
              |
              v
PHASE 4 extraction        PHASE 5 digests + feedback
```

The former phase 6 is retired — vision is phase 1.5. Tier 3 LLM adjudication of
the gray zone stays a follow-on inside phase 3, enabled once 6.7's logs show the
gray-zone volume.

## 11. What I need from you, and when

| When | What |
|---|---|
| Now | Why Source M's checkpoint has not advanced since 2026-05-01 — dead channel or broken polling |
| Before 2.3 | The app root path on the VPS, for `ecosystem.config.cjs` and `docs/DEPLOYMENT.md` |
| Before 2.9 | Confirmation that forwarding may pause on the pilot sources, and which channel is the screenshot-heavy one |
| Before phase 1 | The OpenRouter model ids you intend to use, and whether your account exposes embeddings |
| Before the phase 1 checkpoint | Your own read of `#unsorted`: which categories are missing, which descriptions are too narrow |
| Before phase 2 | The new destination channels, including `#unsorted` and a `security` channel — today there is only the one firehose chat |

Answered already, recorded here so the plan does not ask twice: the service runs
under pm2 (`pm2 start inemuri`), the 2026-06-07 backup is the most recent one
(so 2.1 estimates volume through GramJS rather than through a second snapshot),
and `security` is a required category (appendix A).

## 12. Migration discipline

- **Forward-only.** Recovery is a restore from the backup the runner takes.
- **Back up before every batch**, into `database/backups/`.
- **Never `sync({ alter: true })` against a real database.** SQLite has no real
  `ALTER`, so Sequelize rebuilds the whole table — a copy, a drop, and a rename,
  with the corpus at risk in the middle. Explicit `ALTER TABLE … ADD COLUMN`
  inside a migration instead.
- **Never `NODE_ENV=development` against a real database.** That path uses
  `force: true` and recreates tables, destroying sources and corpus alike.
- **Declared column types matter on SQLite.** A `JSON` column declared `TEXT`
  comes back as a raw string despite `DataTypes.JSON` on the model — the phase 0
  script hit this and documents it. `media_ref` and `cursor` get a declared
  `JSON` type.
- **`npm run migrate:status` on the VPS before every deploy.** Code that assumes
  a column the deployed database lacks fails at runtime in the ingest path — the
  one place that must never stop.

## 13. Open questions still to close

§11 tracks what is needed **from you**; [../THEFLOW.md](../THEFLOW.md) tracks the
product-level questions (display language, thresholds, paid tier). This section
tracks the **engineering** ones: things unanswered in the documents, not merely
unimplemented. Each is a decision to make or a fact to measure, and the grouping
says when it starts blocking work.

**Closed here, recorded so it is not reopened:** the gateway stays a **module**,
not a service. Several consumers is the argument for a module; the criterion for
extraction is a second *process*, and the conditions that would create one are
now written down in [LLM_GATEWAY.md](LLM_GATEWAY.md) §"A module, not a service".
The shared quota ledger that a service would have provided is provided by the
`provider_quota` table instead, which is shared by any process opening the same
database file.

### Decisions that shape the schema — close before phase 1

| # | Question | Why it cannot wait |
|---|---|---|
| 13.1 | **Batch claiming.** `Post.takePending()` is a bare `SELECT … WHERE status='pending'` with no lease. What stops the next timer tick from taking rows that are still in flight — an in-process guard plus a non-overlapping timer, or an `enriching` status with a stale-reclaim rule? | The failure mode is paying twice for the same rows. An `enriching` status is a migration and a change to the validated `POST_STATUSES` enum, so it is cheaper before the corpus grows |
| 13.2 | **Embedding identity.** `embedding` is specified as "Float32Array as a BLOB" and nothing else. Dimension differs per provider (768 / 1536 / 3072), so a fallback or a model change silently splits the corpus into incomparable halves | Otherwise discovered in phase 3, during threshold calibration, with months of vectors already written. Needs `embedding_model` and `embedding_dim` on `posts`, and a tier-2 rule that only compares vectors produced by the same model |
| 13.3 | **Worker configuration constants.** Batch size, tick interval, the cap on `attempts`, the quota reserve threshold, cache TTL and size cap | `CLAUDE.md` forbids reading `process.env` outside `app.config.js`, and LLM_GATEWAY.md lists only the `LLM_*` variables. Unlisted, they get invented inline in five files |

### Contracts to write — close before phase 2

| # | Question | Why it cannot wait |
|---|---|---|
| 13.4 | **What a delivered flow post looks like.** Which text is sent (`text_md` as-is, `text_en`, `summary_uk`), whether a header carries `topic` / `signal_type`, how an unverified OCR entity is marked, how the append block is formatted, where "also reported by N" goes | Three documents impose requirements on this template and none defines it: VISION.md requires unverified entities to be marked on delivery, DEDUPLICATION.md requires an addition block and a full rewrite path, DATA_MODEL.md offers `members_count` for the "also reported" line |
| 13.5 | **Reaction capture (5.7).** Which GramJS update carries reactions on a channel a user account owns, whether it is readable at all, and the emoji → `good` / `noise` / `wrong_topic` / `missed` mapping | Estimated `M` with no feasibility check behind it. If reactions are not readable, `flow:review` is the only label source and phase 5 changes shape. Worth a capability check of the same kind as 3.1 |
| 13.6 | **Command surface.** `flow:volume`, `flow:stats`, `flow:export`, `flow:review` — subcommands of `src/cli.js` (which already has `seed` / `list` / `toggle` / `clear`) or standalone scripts? 2.1 names `scripts/estimate-volume.js`, the phase 0.5 exit criteria name `flow:volume` | Two conventions in one plan. Pick one before the first of them is written |

### Scope questions — no deadline, but open

| # | Question | State |
|---|---|---|
| 13.7 | **History search.** Listed as a gateway consumer with a priority class (LLM_GATEWAY.md) and given an index (`(topic, signal_type, posted_at)` in DATA_MODEL.md), but it has no phase, no task and no specification | Either give it a phase or drop it from the consumer table. A consumer with a quota claim and no owner budgets RPD for work nobody is building |
| 13.8 | **AI-assisted screening of the incoming stream.** Distinct from enrichment: cheap triage over everything, potentially including classic sources, in place of or ahead of keyword filtering | Raised, not specified. Whatever it becomes: it runs **worker-side** — stage 1 makes no outbound calls — and it is a gateway consumer at `low` priority, competing for the same RPD as enrichment. Cost it against 2.1 before committing to it |
| 13.9 | **Retention.** `posts` keeps `raw_text`, `text_en` and an embedding BLOB per row, forever, on a VPS. No pruning, archival or `VACUUM` policy exists | Not urgent at a few hundred posts a day, but it should be a decision rather than an oversight. State a review point — 500k rows, or 2 GB of database |
| 13.10 | **Stall detection.** If every provider is down for a day, posts accumulate as `pending` and nothing says so; the only signal is running `flow:stats` by hand | The core invariant is that AI *may* fail, so something has to notice: oldest `pending` age above a threshold, printed on a schedule or pushed to a Telegram channel |

### Documentation debt

Cross-references and statements that contradict the settled decisions, worth one
cleanup pass: DATA_MODEL.md still describes the Telegram-shaped `posts` table
that 2.4 replaces and marks `post_feedback` as phase 5 although 2.6 pulls it into
phase 0.5; DEDUPLICATION.md's dedup-window table predates `security`,
`giveaway_result` and `stream`; the main `README.md` and `docs/ARCHITECTURE.md`
still say TheFlow is "planned, not implemented" and refer to phases 1–6.
**2.4 is not done until DATA_MODEL.md matches the schema it leaves behind.**

## Appendix A — `categories.json` v1, drafted from the real sources

The spec's example (`games · market · crypto · tools · other`) does not fit the
14 channels. Three quarters of them are Steam drops, airdrop farming, and crypto
trading, and "airdrop farming" is neither `games` nor `crypto` analysis. The
blacklists (1.1c) name the signal types you already reject by hand.

**Topics**

| Topic | Covers | Sources |
|---|---|---|
| `steam` | Steam and game drops, sales, inventory, releases, patches | Source J, Source N, Source D, Source L |
| `airdrop` | Testnets, retrodrops, farming tasks, allocations, snapshots | Source M, Source H, Source B, Source C, Source G |
| `crypto` | Listings, on-chain specifics, market moves, analysis | Source I, Source A, Source K, Source F |
| `tools` | Free offers, service discounts, non-obvious technical solutions | any |
| `other` | Fits nothing above → `#unsorted` | — |

**Signals** — the spec's eight, plus three the real stream demands:

`promo_code · freebie · analysis · event · launch · patch · outage · opinion ·
security · giveaway_result · stream`

**`security` — hacks, exploits, and scams.** Platform and exchange breaches,
contract exploits and drains, rug pulls, phishing waves, compromised accounts,
stolen-funds reports, "do not interact with X" warnings.

It is a **signal, not a topic**, and that is the whole argument for two axes: an
exchange hack is `crypto` + `security`, a Steam trading scam wave is `steam` +
`security`, a breached SaaS provider is `tools` + `security`. One topic could
not hold those together, and three separate topics would fragment the routing.

It is distinct from `outage`, which the spec already has. `outage` is "the
service is down"; `security` is "funds or accounts are at risk". They fail
differently, they age differently, and only one of them is urgent enough to
ignore the confidence threshold.

Three rules follow, and all three should be in place the day `security` is
added to the enum:

1. **Its own routing rule at the highest priority**, matching
   `signal_type: security` across *every* topic, before any topic-specific rule.
2. **Never suppressed by deduplication** — same class as `corrects` and `denies`
   (§6).
3. **A short dedup window, 6 h**, matching `outage`. A hack is news for hours,
   not days, and a fresh report about the same exchange a week later is a
   different incident.

That this matters is visible in the source list: three of the fourteen channels
are named Source I, Source A, and Source K. Scam and breach reporting
is already a large share of the incoming stream — it is currently mixed into the
same firehose as giveaway spam.

`giveaway_result` and `stream` earn their place differently: four sources
maintain separate blacklists for exactly them (`<filter>`, `<filter>`,
`<filter>`, `<filter>`, `<filter>`, `twitch.tv`). As signal types
they are classified once and routed nowhere, and those four hand-kept lists can
shrink. That is the first concrete thing TheFlow gives back.

**Dedup windows** — `promo_code` and `freebie` 24 h, `event` / `launch` /
`patch` 48 h, `analysis` / `opinion` 72 h, `outage` and `security` 6 h. Per
[DEDUPLICATION.md](DEDUPLICATION.md), and per topic in `categories.json` with a
per-source override through `flow.dedup_window_hours`.

**Routing** cannot be written until the channels in 5.1 exist. Until then,
`unsorted_destinations` is the only entry, which is also the correct shadow-mode
configuration. When those channels are created, `security` is the one that
justifies a channel of its own before any other: it is the category where a
missed post has a cost beyond annoyance.

One tension to resolve at the phase 1 checkpoint: Source I blacklists
`<filter>` / `<filter>`, while `tools` is *defined* as discounts and free offers.
Discounts are noise on one source and signal on another. That is a per-source
`flow.topics` restriction, not a category description problem — which is exactly
what the field is for.

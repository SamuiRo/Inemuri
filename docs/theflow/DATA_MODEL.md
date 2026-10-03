# TheFlow — data model

> Related: [THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DEDUPLICATION.md](DEDUPLICATION.md)

Two new tables plus one new column on the existing `Source` model.
ORM is Sequelize, as in the rest of the project (`src/module/teapot/models/`).

## Source — new `flow` column

```js
flow: {
  type: DataTypes.JSON,
  allowNull: true,
  defaultValue: {
    enabled: false,          // false = classic forwarding, current behavior
    topics: null,            // null = all topics; or ["games", "market"]
    min_confidence: 0.6,     // below this the post goes to #unsorted, not to the bin
    dedup_window_hours: null,// null = inherit from the category
    vision: {                // see VISION.md
      enabled: false,        // enabling TheFlow does not enable vision
      text_threshold: 200,   // skip images when the post already has this much text
      max_images_per_post: 2
    }
  },
  comment: 'TheFlow settings for this source'
}
```

`enabled: false` by default means **existing sources do not change behavior at
all** until they are explicitly switched over.

## posts

The central table. One row per incoming message.

| Field | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | |
| `source_id` | INTEGER | FK to `sources`. `SET NULL` on source delete — post history is kept |
| `platform` | STRING NOT NULL | `telegram` \| `reddit` \| `rss` \| … Default `'telegram'`. Migration `002` |
| `external_id` | STRING | Universal item identity: Telegram message id as text, Reddit fullname (`t3_…`), an article's URL. **UNIQUE with `source_id`.** Migration `002` |
| `external_url` | STRING | Canonical link. For Reddit and news also a tier 1 dedup key. Migration `002` |
| `channel_id` | STRING | Denormalized fast Telegram lookup key. No longer part of an item's identity |
| `grouped_id` | STRING | Album ID when the post is part of a group |
| `posted_at` | DATE | Publication time at the source, not ingestion time |
| `title` | TEXT | Headline, separate from the body. Carries the whole event for news and Reddit; Telegram has none. Migration `002` |
| `author` | STRING | Reddit author, article byline. Migration `002` |
| `raw_text` | TEXT | **Original, in the source language.** Never overwritten |
| `text_md` | TEXT | Markdown rendering with entities, for reading and export |
| `entities` | JSON | **Original MTProto entities**, as a plain array `[{ className, offset, length, url?, language? }]` — exactly what `TelegramDestination.buildFormattingEntities` consumes. Telegram formatting is offsets, not Markdown. Offsets index the text *before* replacements. Written by `FlowIngest`; added by migration `002`; see [DELIVERY.md](DELIVERY.md) |
| `text_hash` | STRING | Hash of the normalized text — cheap dedup before embeddings |
| `has_media` | BOOLEAN | Media is not downloaded at this stage, only flagged |
| `media_ref` | JSON | What stage 3 needs to fetch media later, per platform: `{ kind: "telegram", channel_id, message_id, grouped_id }` or `{ kind: "url", urls: [...] }`. Written when `has_media`. Migration `002` |
| `image_hash` | STRING | Perceptual hash of the first image. Filled by `scripts/backfill-image-hash.js` (not at ingest), used by the vision cache (see VISION.md) |
| `text_ocr` | TEXT | Text transcribed from images. Merged with `raw_text` as input to enrichment |
| `vision_used` | BOOLEAN | Whether a vision call was actually made, for quota attribution |
| `text_en` | TEXT | **Canonical representation.** Every stage below operates on this |
| `lang` | STRING | Detected source language (ISO 639-1) |
| `topic` | STRING | Axis 1 of the taxonomy. Closed enum from `categories.json` |
| `signal_type` | STRING | Axis 2 of the taxonomy. Closed enum |
| `confidence` | FLOAT | 0..1. Below threshold routes to `#unsorted` |
| `analysis` | JSON | `entities` (project, tickers), `extracted` (promo_codes with reward / anchored expiry, links with role, amounts, event with anchored dates — each quoted item carries `source` and `verified`), `summary_uk`, `why_interesting`, `is_ad`, `discarded` and `unverified` from validation, `prompt_version` (3 since v4.57.0, 2 since v4.50.0; absent = 1); `text_uk` and `text_uk_model` — the Ukrainian translation, written by delivery for a routed post not in Ukrainian (DELIVERY.md) |
| `candidates` | JSON | What the regex stage found, kept for audit and re-runs |
| `embedding` | BLOB | Float32Array as a BLOB, **normalized to unit length at write time** so cosine is a plain dot product. Little-endian; `buffer.length === embedding_dim * 4` |
| `embedding_model` | STRING | Which model produced the vector, e.g. `gemini:text-embedding-004`. **Not** `model_used`, which is the enrichment model |
| `embedding_dim` | INTEGER | Vector dimension. Differs per provider and per configured output size |
| `cluster_id` | INTEGER | NULL means not yet assigned to an event |
| `link_role` | STRING | `canonical` \| `linked` \| `duplicate` \| `correction` |
| `adds` | JSON | What this post adds over the canonical one (see DEDUPLICATION.md) |
| `delivery` | JSON | The delivery log: `outcome` (`routed`/`unsorted`), resolve's `reason` and `rule`, `delivered[]` identities, `partial`, `media_error`; or `skipped` (`too_old`, `no_destinations`, `cluster_already_delivered`); or `failed` with `attempts` and `error`. NULL = not handled. Migration `013` |
| `dedup` | JSON | The deduplication decision log: `decision` (`new`/`join`), `tier`, `s` (nearest other-source similarity), `s_same_source`, `nearest_post_id`, `key` (tier 1), `gray`, `gate` (richness and new entities), `cluster_id`, `t`, `at`; `{error}` if the stage failed on the post. NULL = not deduplicated yet. Migration `011` |
| `status` | STRING | See the status table below |
| `model_used` | STRING | Which model produced the verdict. **Required** |
| `taxonomy_version` | INTEGER | `categories.json` version at verdict time, to separate model regression from a category description you changed |
| `attempts` | INTEGER | Enrichment attempt counter |
| `last_error` | TEXT | Last error — diagnostics without digging through logs |
| `createdAt` / `updatedAt` | DATE | Sequelize timestamps |

### Statuses

```text
pending ---> enriched ---> routed
   |             |
   |             +---> suppressed   (duplicate that adds nothing)
   |             +---> unsorted     (low confidence or unknown category)
   |
   +---> skipped_blacklist
   +---> skipped_empty
   +---> skipped_noise
   +---> skipped_shouty            (short all-caps, per source)
   +---> skipped_short             (shorter than filters.min_length, per source)
   +---> skipped_repost             (same text from the same source in the window)
   +---> failed                     (attempts exhausted; kept for review)
```

`failed` does not mean discarded. The row stays in the database with
`last_error` and can be replayed after the prompt or provider is fixed.

### Indexes

| Index | Purpose |
|---|---|
| `(source_id, external_id)` UNIQUE | Idempotent ingestion, platform-neutral, protects against double insertion in `both` mode. Replaces `(channel_id, message_id)` — migration `002` |
| `(channel_id)` | Denormalized fast Telegram lookup |
| `(status, createdAt)` | The worker's main query |
| `text_hash` | Cheap deduplication |
| `(cluster_id)` | Collecting cluster members |
| `(topic, signal_type, posted_at)` | Digests and history search (ROADMAP §9.1) |
| `(embedding_model)` | Tier 2 compares only vectors produced by the same model |

## clusters

One row per event that one or more channels wrote about.

| Field | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | |
| `canonical_post_id` | INTEGER | The first published post about the event |
| `topic` / `signal_type` | STRING | Copied from the canonical post, for queries without a join |
| `centroid` | BLOB | The canonical post's vector. Same format as `posts.embedding` |
| `embedding_model` / `embedding_dim` | STRING / INTEGER | Which model the centroid belongs to. Vectors from different models are never compared. Migration `011` |
| `members_count` | INTEGER | "Also reported by N more channels" |
| `richness` | FLOAT | Informativeness of the current canonical version (see DEDUPLICATION.md) |
| `delivered` | JSON | `[{platform, channel_id, message_id, sent_at}]`, so sent messages can be edited |
| `appends_count` | INTEGER | How many additions were appended. The cap keeps the message readable |
| `first_seen_at` / `last_seen_at` | DATE | Bounds of the event's active window |
| `closed` | BOOLEAN | Window closed; no new posts join |

`delivered` is an array because one post may have gone to several destinations,
and each one has to be edited.

## post_feedback

Created in **phase 0.5** (ROADMAP 2.6), not phase 5: `flow:review` starts writing
labels during phase 1 shadow mode, which turns verdict-checking you have to do
anyway into a labelled dataset. Collecting this feedback retroactively is
expensive.

| Field | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | |
| `post_id` | INTEGER | FK to `posts.id`, `SET NULL` — `missed` has no post, and label history is kept |
| `verdict` | STRING NOT NULL | `good` \| `noise` \| `wrong_topic` \| `missed` (validated) |
| `note` | TEXT | Optional |
| `created_at` | DATE NOT NULL | Rows are immutable — no `updatedAt` (`timestamps: false`) |

Table and `PostFeedback` model land in migration `004-post-feedback`.
Labels come from your reaction to a post in the channel (emoji, forward).
They later become few-shot examples for the prompt.

## knowledge_examples

The knowledge base (NEWS_INTAKE.md §3): self-contained labelled examples. Each
row carries a snapshot of what was labelled — text, classification, taxonomy
version, source name — so labels survive pruning `posts` and move between
instances through `flow knowledge export|import`. `post_feedback` stays the
review event log; few-shot reads this table. The full field table and the
exchange format are in [NEWS_INTAKE.md](NEWS_INTAKE.md) §3.2 and §3.5.

Key points: `uid` (UUID, UNIQUE) is the identity across instances;
`content_hash` groups labels of the same content (the latest wins); `level` is
`post` · `headline` · `article`; `verdict` uses the `post_feedback` vocabulary;
`post_id` (`SET NULL`) and `feedback_id` (UNIQUE) are local links that are never
exported. Rows are immutable — `created_at` only.

Model `KnowledgeExample`, table created in migration `015-knowledge-examples`.

## discovered_items

Candidates of news sources with `feed.triage: true` (NEWS_INTAKE.md §2.2,
§6): every new article lands here, only what triage passes becomes a post.
Short-lived — swept after `FLOW_TRIAGE_RETENTION_DAYS` (14).

| Field | Purpose |
|---|---|
| `source_id`, `external_id` | Identity, UNIQUE together — a repeat of the same item is a no-op |
| `url`, `title`, `teaser`, `author`, `keywords`, `image_urls`, `published_at` | The feed item as the parser gave it; a pass becomes a post exactly like this |
| `section` | First path segment of the URL (`business`, `health`, `sports`) |
| `status` | `pending` → `passed` · `rejected` · `failed` (no answer after `maxAttempts`) |
| `decided_by`, `reason`, `area` | `rule` (`section:sports`) or `llm` (short reason, area of the profile) |
| `profile_version`, `model_used` | Which `triage.json` and which model decided — for calibration |
| `sampled` | A model reject flagged for review |
| `post_id` | The post a pass became (`SET NULL`); null on a pass = promotion failed, retried |
| `review_verdict` | The operator's label from `flow triage review`; null = not reviewed |
| `attempts`, `last_error` | Failures of the triage call or of promotion |

Model `DiscoveredItem`, table created in migration `017-discovered-items`.

## Migration

The project now has a migration runner (`database/migrations/` plus
`npm run migrate` / `npm run migrate:status`) — ROADMAP §2.2. Migrations are
`NNN-name.js` files, each exporting `up({ sequelize, queryInterface })`,
forward-only, applied in numeric order and recorded in a `schema_migrations`
table. The runner takes one backup into `database/backups/` before the first
migration of a run and refuses `NODE_ENV=development` (that path uses
`force: true` and recreates tables). `database/` is git-ignored except
`database/migrations/`.

### `001-theflow-phase0`

Establishes the schema on this page. On a pre-TheFlow database (the VPS) it
**creates** it; on a copy that already ran the earlier one-off script it
**adopts** it — every step is idempotent:

1. Add the `flow` column to `sources` — **declared type `JSON`, not `TEXT`**.
   Sequelize v6 on SQLite decides whether to parse a value as JSON from the
   column's declared DDL type; a `TEXT` column comes back as a raw string
   despite `DataTypes.JSON` on the model. A manual
   `ALTER TABLE sources ADD COLUMN flow JSON DEFAULT '...'` is used rather than
   `sync({ alter: true })`, which rebuilds the whole table on SQLite. If a
   mistyped column already exists it is dropped and re-added.
2. Backfill `flow` with the default object for existing rows.
3. `sequelize.sync()` creates the new `posts` and `clusters` tables — a plain
   `sync()` is sufficient for tables that do not yet exist.
4. Verify: expected tables present, sources preserved.

Verification after migration:

```bash
node src/cli.js list
```

If the sources are still listed and `flow` reads as `{enabled: false}`, the
migration succeeded and behavior is unchanged.

### `002-generalize-sources`

Makes `posts` platform-neutral while the corpus is small (ROADMAP §2.4). All
`ADD COLUMN` plus index add/remove — no table rebuild:

- adds `platform`, `external_id`, `external_url`, `title`, `author`,
  `media_ref`, `entities`, `embedding_model`, `embedding_dim`;
- backfills `platform = 'telegram'`, `external_id = CAST(message_id AS TEXT)`,
  and a Telegram `media_ref` for rows with media. `entities` cannot be
  backfilled — phase-0 rows never stored it;
- drops `UNIQUE (channel_id, message_id)`, adds `UNIQUE (source_id,
  external_id)` and plain indexes on `(channel_id)` and `(embedding_model)`.

`message_id` keeps its NOT NULL and stays populated for Telegram (FlowIngest
always has it); nothing reads it. A later migration DROPs it outright once a
non-Telegram adapter exists — SQLite 3.44 on the VPS has `DROP COLUMN`.

### `003-source-cursor`

Adds `source_states.cursor` JSON and backfills
`{ "last_message_id": <value> }` from the existing checkpoint. The Telegram
adapter keeps reading `last_message_id`; RSS/Reddit adapters (phase 3.5) store
their own cursor shape.

### `011-dedup`

Adds `posts.dedup` (JSON), `clusters.embedding_model` and
`clusters.embedding_dim`, and an index on `clusters (closed, last_seen_at)`.
All `ADD COLUMN` / `CREATE INDEX IF NOT EXISTS`, idempotent.

### `012-posts-fts`

Creates `posts_fts`, an FTS5 virtual table over `text_en`, `raw_text` and
`title` with `content='posts'` (the index only; text stays in `posts`), the
triggers `posts_fts_ai` / `_ad` / `_au` (the update trigger fires only on
those three columns), and builds the index from existing rows. Used by history
search (ROADMAP §9.1). `db:bootstrap` does not create it — `sync()` knows only
models — so a fresh install gets it from `npm run migrate`.

### `013-post-delivery`

Adds `posts.delivery` (JSON), the delivery log. Plain `ADD COLUMN`.

### `014-drop-post-message-id`

Drops `posts.message_id` (after dropping any index that still covers it).
The Telegram message id lives on in `external_id` and `media_ref`; a Reddit
fullname or an RSS guid could never have fit an `INTEGER NOT NULL` column.
Migration `002` skips its `message_id` backfill when the column is absent, so
a database bootstrapped from the current models still migrates.

### `015-knowledge-examples`

Creates `knowledge_examples` and backfills every `post_feedback` label that
still has its post (`flow knowledge backfill` reruns it). Idempotent through
the UNIQUE `feedback_id`.

### `016-source-feed`

Adds `sources.feed` JSON NULL — `{ "discovery": "rss" | "sitemap" |
"wpjson" }`, how an `rss` source finds new articles (NEWS_INTAKE.md §2.1).
NULL is a plain RSS/Atom feed, so existing sources need no backfill.

### `017-discovered-items`

Creates `discovered_items` (above). Idempotent.

### Fresh installs

`src/inemuri.js` and `src/cli.js` still call `database.sync()` on boot, which
on a brand-new database creates every table from the models — already at the
latest shape. `npm run migrate` then runs the idempotent migrations, which
find everything present and simply record themselves in `schema_migrations`.

## `image_hash` is not written at ingest

`DATA_MODEL` lists `image_hash` as "recorded from phase 0", but ingestion must
make **no outbound network calls** (ARCHITECTURE.md invariant) and a perceptual
hash needs the image bytes. So at ingest only `has_media` is set; `image_hash`
stays `NULL` and is filled by `scripts/backfill-image-hash.js` (dHash via
`sharp`, rate-limited, resumable, picks `has_media = true AND image_hash IS
NULL`).

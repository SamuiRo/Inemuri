# TheFlow — data model

> Related: [THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DEDUPLICATION.md](DEDUPLICATION.md)

The SQLite schema as the migrations leave it. Models live in
`src/module/teapot/models/` (Sequelize). The models are the reference for
column types; this page says what each field is for.

## Source — `flow` and `feed`

```js
flow: {                    // JSON, default below; the seeder merges a partial block
  enabled: false,          // false = classic forwarding
  topics: null,            // null = all topics; or ["games", "markets"]
  min_confidence: 0.6,     // below this the post goes to #unsorted
  dedup_window_hours: null,// null = the signal's window from categories.json
  vision: { enabled: false, text_threshold: 200, max_images_per_post: 2 }  // VISION.md
}
feed: null                 // rss sources: { discovery: "rss" | "sitemap" | "wpjson", triage?: true }
```

Other `sources` columns: `platform`, `channel_id`, `channel_name`,
`is_active`, `mode`, `poll_interval_min`, `extra_media_types`,
`text_replacements`, `filters`, `destinations` (README "Sources").

## source_states

One row per source: `last_message_id` (Telegram checkpoint), `cursor` (JSON —
`{ ts, seen, etag, lastModified, url }` for feeds), `baseline_set_at`,
`last_seen_at` (when the source last published, any mode — the status board).

## posts

The central table. One row per ingested item of a flow-enabled source.

| Field | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | |
| `source_id` | INTEGER | FK to `sources`, `SET NULL` on delete — history is kept |
| `platform` | STRING NOT NULL | `telegram` \| `reddit` \| `rss` |
| `external_id` | STRING | Item identity: Telegram message id as text, Reddit fullname (`t3_…`), article URL. **UNIQUE with `source_id`** |
| `external_url` | STRING | Canonical link; for Reddit and news also a tier 1 dedup key |
| `channel_id` | STRING | Denormalized Telegram lookup key, not part of identity |
| `grouped_id` | STRING | Album id |
| `posted_at` | DATE | Publication time at the source |
| `title` | TEXT | Headline (news, Reddit); Telegram has none |
| `author` | STRING | Reddit author, byline |
| `raw_text` | TEXT | Plain text in the source language **after `text_replacements`** — the model's input and what verbatim validation checks. Never overwritten |
| `text_md` | TEXT | Markdown rendering with entities |
| `entities` | JSON | Original MTProto entities `[{ className, offset, length, url?, language? }]`. Offsets index the text *before* replacements; delivery clips them (DELIVERY.md) |
| `text_hash` | STRING | Hash of the normalized text — repost check and tier 1 |
| `has_media` | BOOLEAN | Media is flagged at ingest, never downloaded there |
| `media_ref` | JSON | What lazy media needs: `{ kind: "telegram", channel_id, message_id, grouped_id }` or `{ kind: "url", urls }` |
| `image_hash` | STRING | Perceptual hash of the first image — filled by the vision stage or `scripts/backfill-image-hash.js`, never at ingest (it needs the bytes) |
| `text_ocr` | TEXT | Text transcribed from images; enrichment input next to `raw_text` |
| `vision_used` | BOOLEAN | A vision call was actually made |
| `text_en` | TEXT | **Canonical English.** Embeddings, dedup and search work on it |
| `lang` | STRING | Source language (ISO 639-1) |
| `topic`, `signal_type` | STRING | The two taxonomy axes, closed enums from `categories.json` |
| `confidence` | FLOAT | 0..1 |
| `analysis` | JSON | `entities` (project, tickers); `extracted` (promo codes with reward and anchored expiry, links with role, amounts, event with anchored dates — quoted items carry `source` and `verified`); `summary_uk`, `why_interesting`, `is_ad`; `discarded`, `unverified` from validation; `prompt_version`; `fewshot` (hash of the example set); `text_uk`, `text_uk_model` — the Ukrainian translation written by delivery |
| `candidates` | JSON | What the regex stage found |
| `embedding` | BLOB | Little-endian Float32Array, **unit length at write time** (cosine = dot product); `length === embedding_dim * 4` |
| `embedding_model`, `embedding_dim` | STRING, INTEGER | Which model made the vector. Vectors of different models are never compared |
| `cluster_id` | INTEGER | The event; NULL = not deduplicated yet |
| `link_role` | STRING | `canonical` \| `linked` \| `duplicate` \| `correction` |
| `adds` | JSON | The delta call's answer: `relation`, `adds[]` (`kind`, `text`, `text_uk`), `confidence`, `model_used`; after delivery `applied_at` and per-message results |
| `dedup` | JSON | Decision log: `decision`, `tier`, `s`, `s_same_source`, `nearest_post_id`, `key`, `gray`, `gate`, `cluster_id`, `at`; `{ error }` on failure |
| `delivery` | JSON | Delivery log: `outcome` (`routed`/`unsorted`), `reason`, `rule`, `delivered[]`, `partial`, `media_error`; or `skipped` (`too_old`, `no_destinations`, `cluster_already_delivered`); or `failed` with `attempts`, `error` |
| `status` | STRING | Below |
| `model_used` | STRING | Model behind the verdict. Always set |
| `taxonomy_version` | INTEGER | `categories.json` version at verdict time |
| `attempts`, `last_error` | INTEGER, TEXT | Enrichment attempts (incremented at claim) and the last error |
| `createdAt`, `updatedAt` | DATE | |

### Statuses

```text
pending ──> enriched ──> routed       (delivered to a topic channel)
   │            ├──────> unsorted     (delivered to #unsorted, with the reason)
   │            └──────> suppressed   (duplicate that adds nothing)
   ├──> skipped_blacklist | skipped_empty | skipped_noise | skipped_shouty
   │    | skipped_short | skipped_repost        (regex stage, never enriched)
   └──> failed                                  (attempts exhausted; replay with flow requeue)
```

`failed` posts are still delivered to `#unsorted` with reason `model_failed`.

### Indexes

`(source_id, external_id)` UNIQUE · `(channel_id)` · `(status, createdAt)` ·
`text_hash` · `(cluster_id)` · `(topic, signal_type, posted_at)` ·
`(embedding_model)`. Full-text search uses `posts_fts` (FTS5 over `text_en`,
`raw_text`, `title`, kept in sync by triggers).

## clusters

One row per event.

| Field | Purpose |
|---|---|
| `canonical_post_id` | The post the delivered message is rendered from |
| `topic`, `signal_type` | Copied from the canonical post |
| `centroid`, `embedding_model`, `embedding_dim` | The canonical post's vector and its model |
| `members_count` | "Also reported by N" |
| `richness` | Informativeness of the canonical version (DEDUPLICATION.md) |
| `delivered` | `[{ platform, channel_id, message_id, sent_at, … }]` — every sent copy, so each can be edited |
| `appends_count` | Additions edited in so far (cap 3) |
| `first_seen_at`, `last_seen_at`, `closed` | Active window; a closed cluster takes no new members |

## Other tables

| Table | Purpose |
|---|---|
| `post_feedback` | Review event log: `post_id` (`SET NULL`), `verdict` (`good` \| `noise` \| `wrong_topic` \| `missed`), `note`, `created_at`. Immutable rows. Written by `flow review` |
| `knowledge_examples` | Self-contained labelled examples, portable between instances — fields in [NEWS_INTAKE.md](NEWS_INTAKE.md) §3.2. Few-shot and triage examples read it |
| `discovered_items` | Triage candidates of news sources: identity (`source_id`, `external_id`), the feed item, `section`, `status` (`pending` → `passed` · `rejected` · `failed`), `decided_by`, `reason`, `area`, `profile_version`, `model_used`, `sampled`, `post_id`, `review_verdict`, `attempts`, `last_error`. Swept after `FLOW_TRIAGE_RETENTION_DAYS` (14) |
| `provider_quota` | LLM gateway ledger: `provider` (`provider:model`), `day_utc` (the provider's quota day), `count`, `exhausted_at` |
| `vision_cache` | Transcriptions by perceptual hash: `image_hash`, `text_ocr`, `description`, `legible`, `model`; TTL `VISION_CACHE_TTL_HOURS` |
| `discord_resources` | discordapp provisioning state: `guild_id`, `kind`, `key` → `discord_id`, `content_hash`, `parent_id`, `archived_at`, `archived_from` |
| `status_messages` | The status board's message per destination: `platform`, `channel_id` → `message_id` |
| `schema_migrations` | Applied migrations |

## Migrations

`database/migrations/NNN-name.js`, each exporting
`up({ sequelize, queryInterface })`, forward-only and idempotent; applied in
order by `npm run migrate`, which backs up first and refuses
`NODE_ENV=development`. Rules: explicit `ALTER TABLE … ADD COLUMN`, never
`sync({ alter: true })` (SQLite rebuilds the table); JSON columns are declared
`JSON`, not `TEXT` — Sequelize on SQLite parses JSON by the declared DDL type.

`sources` and `source_states` predate migrations and are created by
`database.sync()` (`npm run db:bootstrap`), so migrations cannot start from an
empty file. `npm run setup` runs both in the right order.

| # | Change |
|---|---|
| 001 | `sources.flow`; `posts`, `clusters` |
| 002 | `posts` made platform-neutral: `platform`, `external_id`, `external_url`, `title`, `author`, `media_ref`, `entities`, `embedding_model`, `embedding_dim`; UNIQUE `(source_id, external_id)` |
| 003 | `source_states.cursor` |
| 004 | `post_feedback` |
| 005 | `provider_quota` |
| 006 | `sources.poll_interval_min` |
| 007 | `sources.extra_media_types` |
| 008 | `vision_cache` |
| 009 | `discord_resources` |
| 010 | `discord_resources.parent_id` |
| 011 | `posts.dedup`; `clusters.embedding_model`, `embedding_dim`; index `clusters (closed, last_seen_at)` |
| 012 | `posts_fts` (FTS5) and its triggers — `db:bootstrap` cannot create it |
| 013 | `posts.delivery` |
| 014 | drop `posts.message_id` |
| 015 | `knowledge_examples`, backfilled from `post_feedback` |
| 016 | `sources.feed` |
| 017 | `discovered_items` |
| 018 | `source_states.last_seen_at`; `status_messages` |

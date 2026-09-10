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
| `source_id` | INTEGER | FK to `sources` |
| `channel_id` | STRING | Duplicated for fast lookups without a join |
| `message_id` | INTEGER | Telegram message ID. Unique together with `channel_id` |
| `grouped_id` | STRING | Album ID when the post is part of a group |
| `posted_at` | DATE | Publication time at the source, not ingestion time |
| `raw_text` | TEXT | **Original, in the source language.** Never overwritten |
| `text_md` | TEXT | Markdown rendering with entities, for delivering the post as-is |
| `text_hash` | STRING | Hash of the normalized text — cheap dedup before embeddings |
| `has_media` | BOOLEAN | Media is not downloaded at this stage, only flagged |
| `image_hash` | STRING | Perceptual hash of the first image. Recorded from phase 0, used by the vision cache (see VISION.md) |
| `text_ocr` | TEXT | Text transcribed from images. Merged with `raw_text` as input to enrichment |
| `vision_used` | BOOLEAN | Whether a vision call was actually made, for quota attribution |
| `text_en` | TEXT | **Canonical representation.** Every stage below operates on this |
| `lang` | STRING | Detected source language (ISO 639-1) |
| `topic` | STRING | Axis 1 of the taxonomy. Closed enum from `categories.json` |
| `signal_type` | STRING | Axis 2 of the taxonomy. Closed enum |
| `confidence` | FLOAT | 0..1. Below threshold routes to `#unsorted` |
| `analysis` | JSON | Entities, extracted codes, summary, why it is interesting |
| `candidates` | JSON | What the regex stage found, kept for audit and re-runs |
| `embedding` | BLOB | Float32Array stored as a BLOB |
| `cluster_id` | INTEGER | NULL means not yet assigned to an event |
| `link_role` | STRING | `canonical` \| `linked` \| `duplicate` \| `correction` |
| `adds` | JSON | What this post adds over the canonical one (see DEDUPLICATION.md) |
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
   +---> skipped_repost
   +---> failed                     (attempts exhausted; kept for review)
```

`failed` does not mean discarded. The row stays in the database with
`last_error` and can be replayed after the prompt or provider is fixed.

### Indexes

| Index | Purpose |
|---|---|
| `(channel_id, message_id)` UNIQUE | Idempotent ingestion, protects against double insertion in `both` mode |
| `(status, createdAt)` | The worker's main query |
| `text_hash` | Cheap deduplication |
| `(cluster_id)` | Collecting cluster members |
| `(topic, signal_type, posted_at)` | Digests and history search |

## clusters

One row per event that one or more channels wrote about.

| Field | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | |
| `canonical_post_id` | INTEGER | The first published post about the event |
| `topic` / `signal_type` | STRING | Copied from the canonical post, for queries without a join |
| `centroid` | BLOB | Canonical (or averaged) vector used for comparison |
| `members_count` | INTEGER | "Also reported by N more channels" |
| `richness` | FLOAT | Informativeness of the current canonical version (see DEDUPLICATION.md) |
| `delivered` | JSON | `[{platform, channel_id, message_id, sent_at}]`, so sent messages can be edited |
| `appends_count` | INTEGER | How many additions were appended. The cap keeps the message readable |
| `first_seen_at` / `last_seen_at` | DATE | Bounds of the event's active window |
| `closed` | BOOLEAN | Window closed; no new posts join |

`delivered` is an array because one post may have gone to several destinations,
and each one has to be edited.

## post_feedback (phase 5)

Not needed before phase 5, but worth designing now — collecting this feedback
retroactively is expensive.

| Field | Type | Purpose |
|---|---|---|
| `post_id` | INTEGER | FK |
| `verdict` | STRING | `good` \| `noise` \| `wrong_topic` \| `missed` |
| `note` | TEXT | Optional |
| `created_at` | DATE | |

Labels come from your reaction to a post in the channel (emoji, forward).
They later become few-shot examples for the prompt.

## Migration

> **Superseded from phase 0.5 onward.** A migration runner
> (`database/migrations/` plus `npm run migrate`) is the first task of phase 0.5 —
> see [ROADMAP.md](ROADMAP.md) §2.2. The section below describes the one-off
> script that established the phase 0 schema; migration `001` adopts it.

**At the time of phase 0 the project had no migrations, and `sequelize.sync()`
without `alter` does not add columns to existing tables.** Both `src/inemuri.js` and `src/cli.js` call
`database.sync()`; in development mode that path uses `force: true`, which
recreates tables.

Implemented as `scripts/migrate-theflow-phase0.js` — run once:

```bash
npm run migrate:theflow      # NODE_ENV must not be "development"
```

It is idempotent (safe to re-run), takes its own backup into
`database/backups/`, and does:

1. **Back up `database/pot.sqlite`** into `database/backups/`.
2. Add the `flow` column to `sources` — **declared type `JSON`, not `TEXT`**.
   Sequelize v6 on SQLite decides whether to parse a value as JSON from the
   column's declared DDL type; a `TEXT` column comes back as a raw string
   despite `DataTypes.JSON` on the model. A manual
   `ALTER TABLE sources ADD COLUMN flow JSON DEFAULT '...'` is used rather than
   `sync({ alter: true })`, which rebuilds the whole table on SQLite. If a
   mistyped column already exists it is dropped and re-added.
3. Backfill `flow` with the default object for existing rows.
4. `database.sync()` creates the new `posts` and `clusters` tables — a plain
   `sync()` is sufficient for tables that do not yet exist.
5. Verify: table list, source count, sample `flow` value.

**Do not run with `NODE_ENV=development`** — `force: true` there destroys
existing sources. The script refuses to run in that mode.

Verification after migration:

```bash
node src/cli.js list
```

If the sources are still listed and `flow` reads as `{enabled: false}`, the
migration succeeded and behavior is unchanged.

## `image_hash` is not written at ingest

`DATA_MODEL` lists `image_hash` as "recorded from phase 0", but ingestion must
make **no outbound network calls** (ARCHITECTURE.md invariant) and a perceptual
hash needs the image bytes. So at ingest only `has_media` is set; `image_hash`
stays `NULL` and is filled by `scripts/backfill-image-hash.js` (dHash via
`sharp`, rate-limited, resumable, picks `has_media = true AND image_hash IS
NULL`).

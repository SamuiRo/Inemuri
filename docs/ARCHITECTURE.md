# Inemuri Architecture

## Directory structure

```text
Inemuri/
├── package.json                           # NPM manifest, scripts, runtime dependencies
├── package-lock.json                      # Locked dependency tree
├── .env                                   # Local runtime secrets and environment overrides
├── .env.example                           # Example runtime configuration
├── .eslintrc.json                         # ESLint configuration
├── .gitignore                             # Git ignore rules
├── README.md                              # Short project description
├── LICENSE                                # Project license
├── SourceBuilder.html                     # Local UI helper for building source configs
├── ecosystem.config.cjs                   # pm2 process definition (see docs/DEPLOYMENT.md)
├── database/
│   ├── pot.sqlite                         # Runtime SQLite database (git-ignored)
│   └── migrations/                        # NNN-name.js schema migrations (npm run migrate)
├── test/                                  # node --test suites (npm test)
├── docs/
│   ├── ARCHITECTURE.md                    # High-level architecture map
│   ├── HANDOFF.md                         # Current state and next steps — read first
│   ├── CHANGELOG.md                       # Per-version record of what shipped and why
│   ├── DEPLOYMENT.md                      # pm2 deploy and migration procedure
│   ├── THEFLOW.md                         # TheFlow spec — Phase 0/1/1.5 implemented, 2+ specified
│   ├── DISCORDAPP.md                      # discordapp spec — Discord server management
│   ├── text_replacements.md               # Text preprocessing and replacement rules
│   ├── media.md                           # Media pipeline, Discord embeds
│   ├── .archive/                          # Retired docs, git-ignored — do not cite
│   └── theflow/                           # TheFlow detailed specs
│       ├── ARCHITECTURE.md                # Pipeline stages, pre-AI regex stage, invariants
│       ├── DATA_MODEL.md                  # posts / clusters tables, migration order
│       ├── DEDUPLICATION.md               # Three dedup tiers, linked mechanism
│       ├── DELIVERY.md                    # Render contract, entity offsets, platform limits
│       ├── LLM_GATEWAY.md                 # Provider contract, fallback matrix
│       ├── ROADMAP.md                     # Work plan: current state, ordering, exit gates
│       ├── TAXONOMY.md                    # Category axes, categories.json, routing
│       └── VISION.md                      # Screenshot transcription, gates, OCR provenance
├── src/
│   ├── cli.js                             # CLI for seeding and managing sources
│   ├── inemuri.js                         # Main application bootstrap
│   ├── assets/
│   │   └── images/
│   │       └── daily.png                  # Image used by the daily crypto report
│   ├── config/
│   │   ├── app.config.js                  # All env vars and hardcoded constants in one place
│   │   ├── appearance.config.json         # UI/theme config used by helper assets
│   │   ├── categories.json                # TheFlow taxonomy v1: topics, signals, routing
│   │   ├── cronjob.config.json            # Runtime destination mapping for cron jobs
│   │   ├── cronjob.config.sample.json     # Example cronjob config
│   │   ├── cronjobs.js                    # Cron job definitions (the `daily` job is also a slash command)
│   │   ├── sources.json                   # Runtime source definitions for seeding
│   │   └── sources.sample.json            # Example source definitions
│   ├── destinations/
│   │   ├── base/
│   │   │   └── BaseDestinationAdapter.js  # Common contract for destination adapters
│   │   ├── discord/
│   │   │   └── DiscordDestination.js      # Formats and sends messages to Discord
│   │   └── telegram/
│   │       └── TelegramDestination.js     # Formats and sends messages to Telegram
│   ├── module/
│   │   ├── cron/
│   │   │   └── CronScheduler.js           # Schedules jobs and emits synthetic messages
│   │   ├── discord/                       # Discord transport, shared
│   │   │   ├── DiscordRest.js             # REST client; delivery uses only this
│   │   │   └── DiscordGateway.js          # Gateway session; discordapp only
│   │   ├── discordapp/                    # discordapp — Discord server management (docs/DISCORDAPP.md)
│   │   │   ├── DiscordApp.js              # Lifecycle: soft start, login retry, per-guild command registration
│   │   │   ├── CommandRegistry.js         # Routes commands/components; access check; always ephemeral
│   │   │   ├── guard.js                   # Pure: who may run what, in which guild
│   │   │   ├── customId.js                # Pure: stateless component ids
│   │   │   └── commands/                  # One file per slash command (index.js lists them)
│   │   ├── eventbus/
│   │   │   └── EventBus.js                # Central event hub between modules
│   │   ├── filters/
│   │   │   └── MessageFilter.js           # Cached text replacements and keyword filtering
│   │   ├── routing/
│   │   │   └── MessageRouter.js           # Routes normalized messages to destinations
│   │   ├── seeders/
│   │   │   └── Sourceseeder.js            # Imports sources.json into the database
│   │   ├── theflow/                       # TheFlow subsystem
│   │   │   ├── RegexStage.js              # Deterministic pre-AI stage: rejection, candidates, text hash
│   │   │   ├── FlowIngest.js              # Stage 1: regex stage -> idempotent INSERT posts
│   │   │   ├── EnrichWorker.js            # Stage 2: drains pending posts through the LLM gateway
│   │   │   └── media/                     # Stage 3 lazy media (seam, not yet wired)
│   │   │       ├── MediaResolver.js       # Registry: media_ref.kind -> resolver
│   │   │       ├── TelegramMediaResolver.js  # Re-fetch by media_ref, reuse TelegramMediaDownloader
│   │   │       └── index.js               # Registers the shipped resolvers
│   │   ├── teapot/
│   │   │   ├── config/                    # Reserved area for teapot module config
│   │   │   ├── models/
│   │   │   │   ├── index.js               # Model exports
│   │   │   │   ├── Source.js              # Source config model and helper methods
│   │   │   │   ├── SourceState.js         # Polling checkpoint model
│   │   │   │   ├── Post.js                # TheFlow: one row per ingested message
│   │   │   │   ├── Cluster.js             # TheFlow: one row per deduplicated event
│   │   │   │   ├── PostFeedback.js        # TheFlow: a human's label on a post
│   │   │   │   └── ProviderQuota.js       # LLM gateway: per-provider daily request ledger
│   │   │   └── sqlite/
│   │   │       └── sqlite_db.js           # Sequelize SQLite connection singleton
│   │   └── telegram/
│   │       └── TelegramClient.js          # Shared GramJS MTProto client singleton
│   ├── services/
│   │   ├── ai/                            # TheFlow LLM layer (phase 1, shadow mode)
│   │   │   ├── LLMGateway.js              # enrich/embed: routing, cache, quota, breaker, queue, fallback
│   │   │   ├── internal.js                # TokenBucket, CircuitBreaker, TtlCache
│   │   │   ├── schemas.js                 # enrich() response schema + structural/verbatim validation
│   │   │   ├── prompts/
│   │   │   │   └── enrich.js              # enrich prompt: taxonomy injection, untrusted block
│   │   │   └── providers/
│   │   │       ├── BaseProvider.js        # contract + capabilities() + HTTP error classification
│   │   │       ├── GeminiProvider.js
│   │   │       └── OpenAICompatProvider.js  # base-URL parameterized (OpenRouter, Qwen, …)
│   │   └── crypto/
│   │       └── CryptoDataService.js       # External crypto market data provider
│   ├── shared/
│   │   ├── message.js                     # Banner and welcome strings
│   │   └── utils.js                       # Logging, sleep, file helpers, image loading
│   └── sources/
│       ├── base/
│       │   └── BaseSourceAdapter.js       # Common contract for source adapters
│       └── telegram/
│           ├── TelegramSourceListener.js  # Orchestration: start/stop, listener/polling routing
│           ├── TelegramMessageParser.js   # Parses GramJS events and raw messages into messageData
│           ├── TelegramMediaDownloader.js # Downloads Telegram media via GramJS client
│           ├── TelegramGroupBuffer.js     # Buffers album messages and flushes them as one group
│           └── TelegramDeduplicator.js    # TTL in-memory set for mode:"both" deduplication
└── node_modules/                          # Installed dependencies (generated)
```

## System overview

Inemuri is a Node.js ES module service that forwards content between platforms and also generates scheduled content. The main runtime is assembled in `src/inemuri.js`, which wires together the database, platform clients, adapters, router, scheduler, and command handler.

The project has three message producers:

1. `TelegramSourceListener` receives Telegram channel messages through MTProto events and/or polling.
2. `CronScheduler` creates synthetic messages from scheduled jobs.
3. discordapp (`src/module/discordapp/`) lets whitelisted Discord users trigger those jobs manually. It is also where Discord server management lives — see [DISCORDAPP.md](DISCORDAPP.md).

All producers eventually emit the same `message.received` event, so the downstream pipeline stays unified.

## Runtime flow

```text
Telegram channels / cron jobs / Discord slash commands
    -> normalized messageData
    -> EventBus ("message.received")
    -> MessageRouter
    -> Destination adapter (Discord / Telegram)
    -> Target channels or chats
```

Detailed flow:

1. `src/inemuri.js` starts the database and connects Telegram. Discord delivery needs no connection — it is REST-only — and discordapp's gateway session starts last, after everything else, and cannot stop the process if it fails.
2. Destination adapters are registered in `MessageRouter`.
3. `TelegramSourceListener` loads active sources from SQLite, builds filter/replacement caches, then starts listener and/or polling mode depending on `Source.mode`.
4. Incoming messages are parsed by `TelegramMessageParser`, optionally buffered as albums by `TelegramGroupBuffer`, filtered and enriched with source metadata, and media is downloaded by `TelegramMediaDownloader` when needed.
5. `EventBus` emits `message.received`, and `MessageRouter` reads `source.destinations` to decide where the message should go.
6. Destination adapters format text/media for their platform limits and send the final payload.

## Core modules

- `EventBus` is the internal communication backbone. Modules do not call each other directly when an event-based handoff is enough.
- `MessageRouter` is the dispatch layer. It knows which destination adapter handles each platform and routes one incoming message to multiple outputs.
- `MessageFilter` compiles text replacements and filters once, caches them, and applies them before routing.
- `TelegramSourceListener` is the orchestration layer for Telegram ingestion. It manages source caches, starts listener and polling modes, and routes incoming messages through the sub-modules below. Polling cycles apply a fixed delay between channels (`POLLING_CHANNEL_DELAY_MS`) to avoid request spikes when many sources are configured.
- `TelegramMessageParser` is a stateless singleton that converts raw GramJS events and message objects into the normalized `messageData` shape used by the rest of the pipeline.
- `TelegramMediaDownloader` encapsulates all GramJS `downloadMedia` calls. It accepts a `messageData` object and returns an array of downloaded file records.
- `TelegramGroupBuffer` accumulates album messages that share a `groupedId` and flushes them as a single combined message after a configurable timeout (`ALBUM_GROUP_TIMEOUT_MS`).
- `TelegramDeduplicator` is a TTL-based in-memory set used in `mode: "both"` to prevent polling from re-processing messages already handled by the MTProto listener.
- `DiscordDestinationAdapter` and `TelegramDestinationAdapter` isolate platform-specific send logic, message formatting, media constraints, and error reporting.
- `CronScheduler` makes scheduled jobs look like any other source by emitting the same event shape as Telegram messages.

## Telegram source internals

`TelegramSourceListener` delegates all sub-concerns to focused collaborators:

```text
handleMessage (MTProto event)  ──┐
                                 ├──> TelegramMessageParser.parseEvent()
_pollChannel (polling cycle)   ──┘         |
                                           v
                                    _routeIncoming()
                                    /             \
                            groupedId?          no group
                                |                   |
                        TelegramGroupBuffer     _filterAndProcess()
                        .add(messageData)            |
                                |            MessageFilter.checkMessageFast()
                        (after timeout)              |
                        _flush() ──────────>  _processFiltered()
                                                     |
                                         TelegramMediaDownloader.download()
                                                     |
                                         EventBus.emit("message.received")
```

Deduplication in `mode: "both"`: when the MTProto listener receives a message, it calls `TelegramDeduplicator.mark()`. When the polling cycle encounters the same message ID, it checks `TelegramDeduplicator.has()` and skips it if found.

## Persistence and configuration

- `.env` stores secrets and runtime parameters such as Telegram credentials, Discord bot token, CoinMarketCap key, and polling settings.
- `src/config/app.config.js` is the single source of truth for all constants — both env-backed values and hardcoded tunables. This includes polling intervals, album group timeout, dedup TTL, channel delay, and downloadable media types.
- `src/config/sources.json` is the declarative source registry. `src/module/seeders/Sourceseeder.js` imports it into SQLite.
- `src/config/categories.json` is the TheFlow taxonomy (topics, signals with per-signal dedup windows, routing rules). Exposed as `CATEGORIES` from `app.config.js`; the enrich schema and the phase 2 resolve stage read it.
- `database/pot.sqlite` is the runtime database.
- `Source` stores source metadata, filters, text replacements, destination mappings, source mode, and the `flow` column (TheFlow settings, default `{ enabled: false }`).
- `SourceState` stores polling checkpoints (`last_message_id`) so polling can resume safely and support deduplication in `both` mode.
- `Post` and `Cluster` are the TheFlow tables (Phase 0). `Post` holds one row per ingested message from a `flow.enabled` source; `Cluster` holds one row per deduplicated event. Created by migration `001-theflow-phase0` (`npm run migrate`).
- `src/config/cronjob.config.json` provides destination mapping for scheduled jobs, while `src/config/cronjobs.js` defines the actual job handlers.

## Configuration constants (app.config.js)

| Constant | Default | Description |
|---|---|---|
| `POLLING_INTERVAL_MS` | from env | Polling cycle interval in milliseconds. |
| `POLLING_FETCH_LIMIT` | from env | Max messages fetched per polling cycle per channel. |
| `POLLING_CHANNEL_DELAY_MS` | `500` | Fixed pause between channel requests within one polling cycle. |
| `ALBUM_GROUP_TIMEOUT_MS` | `5000` | How long to wait for album messages to arrive before flushing the group. |
| `DEDUP_TTL_MS` | `600000` | How long a listener-processed message ID stays in the dedup set. |
| `DEDUP_MAX_SIZE` | `5000` | Max dedup set size before expired entries are evicted. |
| `DOWNLOADABLE_MEDIA_TYPES` | `["photo","video","document","animation"]` | Media types that will be downloaded and re-uploaded to destinations. |
| `THEFLOW_MIN_TEXT_LENGTH` | `10` | Normalized text shorter than this after replacements is stored as `skipped_empty`. |
| `THEFLOW_REPOST_WINDOW_HOURS` | `24` | Exact `text_hash` match within this window is `skipped_repost`. |

## Subsystem: TheFlow

TheFlow is a subsystem of Inemuri — not a separate system — that adds
canonical-language normalization, categorization, entity extraction,
cross-channel event deduplication, and content-based routing on top of the same
ingestion pipeline.

**Phase 0 (persistence without AI) is implemented**: the `flow` column,
`posts` / `clusters` tables, the deterministic regex stage
(`src/module/theflow/RegexStage.js`), and stage-1 ingest
(`src/module/theflow/FlowIngest.js`) wired into
`TelegramSourceListener._filterAndProcess()`. No AI calls yet. Phase 0.5 is
done; phases 2 through 5 are specification apart from the resolve stage
(`src/module/theflow/ResolveStage.js`), which is built and waiting on the
destination channels — [THEFLOW.md](THEFLOW.md) and `docs/theflow/`.

**Phase 1 (LLM gateway + enrichment, shadow mode) is implemented but dormant.**
`src/services/ai/` (the gateway, providers, schema and prompt) and
`src/module/theflow/EnrichWorker.js` are wired into `src/inemuri.js` behind
`ENRICH_WORKER_ENABLED` and a primary-provider API key — with no key set the
worker never starts, and `pending` posts simply accumulate. When it runs, it
drains `pending` → `enriched` (writing `topic` / `signal_type` / `confidence`
/ `analysis` / `model_used` / `taxonomy_version` / `embedding`), and nothing
reads the verdicts — in phase 1 shadow mode is structural, not a flag: the
routing consumer that would act on a verdict does not exist until phase 2.
The provider decisions and the free-tier limits behind them are settled
(ROADMAP §3.1).

**Phase 1.5 (vision) is implemented**, off on every source until
`flow.vision.enabled` is set. `src/module/theflow/VisionStage.js` runs inside
the worker between ingest and enrichment — ingest itself still makes no
outbound calls — and writes `posts.text_ocr` before enrichment, so a retry
never pays for a transcription twice. Near-identical images are matched by
perceptual hash against `vision_cache` (migration `008`) instead of being
sent again.

Two design points that shape the remaining work:

- media download moves from ingestion to the delivery stage, so posts that are
  deduplicated away never trigger a download;
- `MessageRouter` keeps its dispatch logic but stops taking destinations from
  the source — a resolve stage fills that field from the post's category.

Classic per-source forwarding remains available and unchanged. A source only
enters TheFlow when its `flow.enabled` is set to `true` in `sources.json`.

## Operational entrypoints

- `npm start` runs `src/inemuri.js` and starts the full service.
- `npm run seed` imports `sources.json` into the SQLite database.
- `npm run seed:fresh` clears all existing sources and reseeds them.
- `npm run migrate` applies pending schema migrations from `database/migrations/` (`NNN-name.js`, forward-only, one backup per run into `database/backups/`, refuses `NODE_ENV=development`); `npm run migrate:status` lists applied and pending. Migration `001-theflow-phase0` creates the Phase 0 schema on a fresh database and adopts it on one that already has it.
- `node scripts/estimate-volume.js` reads current vs baseline message ids to print messages/day per source (ROADMAP §2.1); one-off, needs a Telegram session.
- `node scripts/backfill-image-hash.js` fills `posts.image_hash` for rows with media (runs outside the ingest hot path).
- `src/cli.js` also provides helper commands for listing, toggling, and clearing sources, plus `flow stats` (corpus stats per source and total), `flow export` (sanitized JSONL sample), and `flow review` (label enriched posts into `post_feedback`).
- `npm test` runs the `node --test` suites under `test/`.
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
├── database/
│   └── pot.sqlite                         # Runtime SQLite database
├── docs/
│   ├── ARCHITECTURE.md                    # High-level architecture map
│   ├── DETAILED_OPTIMIZATION_EXPLANATION.md # Notes about performance-related changes
│   ├── INEMURI_DOCS.txt                   # General project notes
│   ├── USE_EMBED.md                       # Discord embed usage notes
│   ├── description.txt                    # Supporting documentation text
│   └── text_replacements.md               # Text preprocessing and replacement rules
├── src/
│   ├── cli.js                             # CLI for seeding and managing sources
│   ├── inemuri.js                         # Main application bootstrap
│   ├── assets/
│   │   └── images/
│   │       └── daily.png                  # Image used by the daily crypto report
│   ├── config/
│   │   ├── app.config.js                  # All env vars and hardcoded constants in one place
│   │   ├── appearance.config.json         # UI/theme config used by helper assets
│   │   ├── cronjob.config.json            # Runtime destination mapping for cron jobs
│   │   ├── cronjob.config.sample.json     # Example cronjob config
│   │   ├── cronjobs.js                    # Cron job definitions and Discord slash commands
│   │   ├── Sources.json                   # Runtime source definitions for seeding
│   │   └── Sources.sample.json            # Example source definitions
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
│   │   ├── discord/
│   │   │   ├── DiscordClient.js           # Shared discord.js client singleton
│   │   │   └── DiscordCommandHandler.js   # Registers and handles Discord slash commands
│   │   ├── eventbus/
│   │   │   └── EventBus.js                # Central event hub between modules
│   │   ├── filters/
│   │   │   └── MessageFilter.js           # Cached text replacements and keyword filtering
│   │   ├── routing/
│   │   │   └── MessageRouter.js           # Routes normalized messages to destinations
│   │   ├── seeders/
│   │   │   └── Sourceseeder.js            # Imports Sources.json into the database
│   │   ├── teapot/
│   │   │   ├── config/                    # Reserved area for teapot module config
│   │   │   ├── models/
│   │   │   │   ├── index.js               # Model exports
│   │   │   │   ├── Source.js              # Source config model and helper methods
│   │   │   │   └── SourceState.js         # Polling checkpoint model
│   │   │   └── sqlite/
│   │   │       └── sqlite_db.js           # Sequelize SQLite connection singleton
│   │   └── telegram/
│   │       └── TelegramClient.js          # Shared GramJS MTProto client singleton
│   ├── services/
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
3. `DiscordCommandHandler` lets approved Discord users trigger those jobs manually.

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

1. `src/inemuri.js` starts the database, then connects Telegram and Discord clients.
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
- `src/config/Sources.json` is the declarative source registry. `src/module/seeders/Sourceseeder.js` imports it into SQLite.
- `database/pot.sqlite` is the runtime database.
- `Source` stores source metadata, filters, text replacements, destination mappings, and source mode.
- `SourceState` stores polling checkpoints (`last_message_id`) so polling can resume safely and support deduplication in `both` mode.
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

## Operational entrypoints

- `npm start` runs `src/inemuri.js` and starts the full service.
- `npm run seed` imports `Sources.json` into the SQLite database.
- `npm run seed:fresh` clears all existing sources and reseeds them.
- `src/cli.js` also provides helper commands for listing, toggling, and clearing sources.
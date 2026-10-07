> **Role:** Repo map and runtime flow · **Audience:** Anyone finding their way around the code

# Inemuri architecture

Inemuri is a modular monolith: one Node.js ESM process (Node 22+), SQLite
through Sequelize, modules talking through `EventBus`. `src/inemuri.js`
assembles everything.

## Repository map

```text
Inemuri/
├── package.json, package-lock.json
├── eslint.config.js                 # flat ESLint config (npm run lint)
├── ecosystem.config.cjs             # pm2 app (DEPLOYMENT.md)
├── .env.example                     # every environment variable, with defaults
├── SourceBuilder.html               # local editor for sources.json
├── .github/workflows/ci.yml         # lint, bootstrap, migrate, tests on push and PR
├── .claude/skills/                  # Claude Code skills (discord-provisioning tracked; server-* ignored)
├── database/
│   ├── pot.sqlite                   # runtime database (git-ignored)
│   ├── backups/                     # taken by migrate and setup (git-ignored)
│   └── migrations/                  # NNN-name.js, forward-only (tracked)
├── scripts/
│   ├── setup.js                     # npm run setup: bootstrap + migrate + seed (+ knowledge import)
│   ├── bootstrap-schema.js          # npm run db:bootstrap: tables that predate migrations
│   ├── migrate.js                   # npm run migrate / migrate:status
│   ├── run-tests.js                 # npm test: throwaway database, node --test
│   ├── discordapp.js                # check | apply | export | ids from a terminal
│   ├── backfill-image-hash.js       # posts.image_hash for rows with media
│   └── estimate-volume.js           # one-off messages/day per Telegram source
├── test/                            # node --test suites; support/testDatabase.js guards pot.sqlite
├── docs/                            # see "Documents" below
└── src/
    ├── inemuri.js                   # bootstrap and wiring
    ├── cli.js                       # sources and `flow …` commands (README "CLI commands")
    ├── config/
    │   ├── app.config.js            # every env var and constant — nothing else reads process.env
    │   ├── localConfig.js           # loads git-ignored JSON configs, falls back to *.sample.json
    │   ├── categories.json          # TheFlow taxonomy (tracked)
    │   ├── {sources,routing,triage,cronjob.config}.sample.json   # tracked examples of ignored configs
    │   └── discordapp/{servers,messages}/   # server configs and texts (*.sample.* tracked)
    ├── sources/
    │   ├── base/BaseSourceAdapter.js
    │   ├── telegram/                # listener + polling: SourceListener, pollingSchedule (pure),
    │   │                            #   MessageParser, MediaDownloader, GroupBuffer (albums),
    │   │                            #   Deduplicator (mode "both"), TelegramMediaResolver (TheFlow lazy media)
    │   └── feeds/                   # rss / sitemap / wpjson / reddit: FeedPoller, discovery, http,
    │                                #   parsers (pure), UrlMediaResolver (TheFlow lazy media)
    ├── destinations/
    │   ├── base/BaseDestinationAdapter.js   # send, describeSent, capabilities, editMessage(Data), describeChannel
    │   ├── discord/DiscordDestination.js    # always an embed; REST only
    │   └── telegram/TelegramDestination.js  # GramJS user client; MTProto entities
    ├── module/
    │   ├── eventbus/EventBus.js     # emit/on, plus request/handle (request-reply)
    │   ├── routing/MessageRouter.js # message.received → adapters, returns delivered[]
    │   ├── filters/MessageFilter.js # text replacements and keyword/blacklist, compiled and cached
    │   ├── cron/                    # CronScheduler (schedule + `cron.run` on the bus), dailyReport (job)
    │   ├── seeders/Sourceseeder.js  # sources.json → sources table
    │   ├── telegram/TelegramClient.js   # shared GramJS client
    │   ├── discord/                 # DiscordRest (delivery), DiscordGateway (discordapp only)
    │   ├── discordapp/              # Discord server management (DISCORDAPP.md)
    │   ├── status/                  # status board: SourceActivity, collect, StatusBoard
    │   ├── theflow/                 # TheFlow (THEFLOW.md, theflow/ARCHITECTURE.md)
    │   │   ├── RegexStage.js, FlowIngest.js       # stage 1: ingest, no network
    │   │   ├── EnrichWorker.js, VisionStage.js    # stage 2 worker tick
    │   │   ├── ResolveStage.js, FewShot.js, FlowHealth.js, Preflight.js, Storage.js, stats.js
    │   │   ├── dedup/               # DedupCore (pure), DedupStage, DeltaStage
    │   │   ├── delivery/            # render (pure), FlowDelivery
    │   │   ├── triage/              # headline triage: TriageQueue, TriageStage, rules, examples, report
    │   │   ├── knowledge/           # knowledge base: KnowledgeBase, snapshot, exchange
    │   │   ├── media/               # lazy media registry (MediaResolver); resolvers live in sources/
    │   │   ├── digest/Digest.js
    │   │   └── search/HistorySearch.js
    │   └── teapot/
    │       ├── vocabulary.js        # stored enums: post statuses, link roles, verdicts (pure)
    │       ├── sqlite/sqlite_db.js  # Sequelize connection
    │       └── models/              # Source, SourceState, Post, Cluster, PostFeedback, ProviderQuota,
    │                                #   VisionCache, KnowledgeExample, DiscoveredItem, DiscordResource, StatusMessage
    ├── services/
    │   ├── ai/                      # LLM gateway (theflow/LLM_GATEWAY.md): LLMGateway, internal,
    │   │                            #   schemas, prompts/, providers/ (Gemini, OpenAI-compatible)
    │   └── crypto/CryptoDataService.js  # CoinMarketCap data for the daily cron job
    ├── shared/                      # utils (print, printStack, loadImage), image (sharp), text, prompt,
    │                                #   message, time (MINUTE/HOUR/DAY), platformLimits (Discord/Telegram
    │                                #   API limits), destinations (copy/validate destination ids)
    └── assets/images/daily.png
```

## Runtime flow

```text
Telegram (listener/polling) ─┐
Feeds (rss/sitemap/wpjson/reddit) ─┼─> replacements → filters ─┬─ classic: EventBus "message.received" → MessageRouter → adapters
Cron jobs ───────────────────┘                                 └─ flow.enabled: FlowIngest → posts (pending)
                                                                         │
EnrichWorker tick: triage → vision → enrich + embed → dedup → delta ─────┤
FlowDelivery tick: resolve → lazy media → render → MessageRouter ────────┘
```

Startup order in `src/inemuri.js`: database (connect, `sync()`), media
resolvers registered, Telegram client, destination adapters (Discord is REST-only, so a missing token only
disables Discord delivery), Telegram listener, feed poller, cron scheduler
(the daily report, plus the digest job when `digest_destinations` is set;
it answers `cron.run` on the bus, which `/daily` uses), the enrich worker
(only with `ENRICH_WORKER_ENABLED` and a primary provider key), flow health,
flow delivery (only with `FLOW_DELIVERY_ENABLED=true`), the status board
(only with `status_destinations`), the `theflow.search` request handler, and
discordapp last — a failed Discord login never stops the process.

## Core rules

- **Classic forwarding never depends on TheFlow or discordapp.** A source
  without `flow.enabled` goes replacements → filters → media download →
  `message.received` → `MessageRouter`, which reads `source.destinations`.
- **Ingest makes no outbound network calls.** Everything that talks to a
  provider or downloads media for TheFlow runs in a worker tick and reads its
  input from `posts`.
- **Modules meet through `EventBus`.** discordapp asks the core for data with
  `eventBus.request(name, payload)`; the core registers handlers with
  `eventBus.handle()` in `inemuri.js`. Health alerts and the export copy to
  Telegram travel as synthetic `message.received` events.
- **Platform code stays in adapters.** TheFlow, the status board and flow
  health know no platform; `inemuri.js` injects send/edit functions and the
  adapters, and registers the media resolvers (Telegram, URL) on TheFlow's
  registry.
- **Functional core, imperative shell.** Decisions are pure functions that take
  data and return data — `RegexStage`, `ResolveStage`, `DedupCore`, `render`,
  `planClusterUpdate`, `pollingSchedule`, `aggregateFlowStats`, the
  discordapp planner. The classes around them read, write and send. A module
  that measures something has a `collect…` (I/O) and an `assess…` (pure) half.
- **Configuration is data in one place.** Every env var and tunable is in
  `src/config/app.config.js`, every env var is listed in `.env.example` (a test
  checks both directions). API limits of Discord and Telegram are facts, not
  settings: `src/shared/platformLimits.js`.

## Telegram ingestion

`TelegramSourceListener` loads active sources, compiles their replacements
and filters once (`MessageFilter`), and starts each source in its `mode`:
`listener` (MTProto updates), `polling` (one serialized timer for all
sources, README "Polling schedule"), or `both` (listener plus polling, with
`TelegramDeduplicator` so polling skips what the listener already handled).
Albums are buffered by `groupedId` (`TelegramGroupBuffer`) and flushed as one
message. `SourceState` holds the polling checkpoint; a `listener`-only
source has none and loses what was posted while the process was down.

## Status board

`src/module/status/` watches every source and delivery channel, flow or not.
`SourceActivity` records when a source last published
(`source_states.last_seen_at`) from the listener, polling and the feed
poller — throttled and in the background, so ingest never waits.
`collect.js` reads the sources and asks each adapter's `describeChannel()`
when its channel last got a message; `StatusBoard` renders one message and
edits it in place in every `status_destinations` entry (`status_messages`
remembers which message).

## Persistence

SQLite at `database/pot.sqlite`. `sources` and `source_states` are created
by `database.sync()` (they predate migrations); everything else by numbered
migrations — the full list is in [theflow/DATA_MODEL.md](theflow/DATA_MODEL.md#migrations).
Deployment configs are JSON files read through `localConfig.js`
(HANDOFF "Configuration layout").

## Documents

| Document | Covers |
|---|---|
| [HANDOFF.md](HANDOFF.md) | Current state, next steps — read first |
| [README.md](../README.md) | Behaviour, configuration, commands |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Install, deploy, migrate, rollback, pm2 |
| [THEFLOW.md](THEFLOW.md) | TheFlow: decisions, phases, status; specs in `theflow/` |
| [DISCORDAPP.md](DISCORDAPP.md) | discordapp contract |
| [PROVISIONING.md](PROVISIONING.md) | Running a Discord server from config |
| [media.md](media.md) | Media through parse, download, delivery |
| [text_replacements.md](text_replacements.md) | Replacement rules |
| [CHANGELOG.md](CHANGELOG.md), [SESSION_LOG.md](SESSION_LOG.md) | History |

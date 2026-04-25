# Inemuri

Event-driven content and data flow manager for Telegram, Discord, and scheduled jobs.

Inemuri ingests content from configured sources, normalizes it into a shared event pipeline, applies preprocessing and filtering rules, downloads media when needed, and routes the resulting payload to configured destinations. The current implementation centers on Telegram ingestion, Discord and Telegram delivery, and scheduled jobs, but the project is structured as a growing flow manager rather than a single-purpose forwarding bot.

## What Inemuri does

- Ingests and routes content through a unified multi-source pipeline
- Currently supports Telegram sources, scheduled jobs, and Telegram/Discord destinations
- Supports `listener`, `polling`, and `both` source modes
- Applies text replacements before filtering
- Filters messages using keyword and blacklist rules
- Downloads Telegram media and re-uploads it to destination platforms
- Runs scheduled jobs that emit messages through the same pipeline
- Lets whitelisted Discord users trigger selected jobs manually
- Stores source configuration state in SQLite

## Current architecture

Inemuri is a modular monolith running in a single Node.js process. Internally it is event-driven:

```text
Configured source / cron job / Discord command
    -> normalized messageData
    -> EventBus ("message.received")
    -> MessageRouter
    -> destination adapter (Discord / Telegram)
    -> target channel or chat
```

Main runtime components:

- `src/inemuri.js`: application bootstrap
- `src/module/eventbus/EventBus.js`: internal event bus
- `src/module/routing/MessageRouter.js`: destination dispatch
- `src/sources/telegram/TelegramSourceListener.js`: Telegram ingestion
- `src/destinations/discord/DiscordDestination.js`: Discord delivery
- `src/destinations/telegram/TelegramDestination.js`: Telegram delivery
- `src/module/cron/CronScheduler.js`: scheduled jobs
- `src/module/discord/DiscordCommandHandler.js`: slash commands
- `src/module/teapot/sqlite/sqlite_db.js`: SQLite/Sequelize connection

For the full repo map, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Important note about older docs

Some older notes in `docs/` describe a broader or earlier architecture, including Google Sheets-based configuration. The current implementation in this repository is file-based and database-backed:

- source definitions come from `src/config/Sources.json`
- cron destinations come from `src/config/cronjob.config.json`
- runtime state is stored in `database/pot.sqlite`

This README documents the current codebase behavior.

## Quick start

### Prerequisites

- Node.js 22+ recommended
- An existing Telegram user account
- Telegram API credentials (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`)
- A Discord bot token
- Optional: CoinMarketCap API key for the daily crypto report

### 1. Install dependencies

```bash
npm install
```

### 2. Create your environment file

```powershell
Copy-Item .env.example .env
```

Fill in the values in `.env`.

Example:

```env
NODE_ENV="production"
TELEGRAM_SESSION=""
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH="your_hash"
DISCORD_BOT_TOKEN="your_discord_bot_token"
CMC_API_KEY="your_coinmarketcap_key"
DISCORD_COMMAND_WHITELIST="123456789012345678"
POLLING_INTERVAL_MIN="5"
POLLING_FETCH_LIMIT="50"
```

### 3. Configure sources and cron destinations

Use the sample files as references:

- `src/config/Sources.sample.json`
- `src/config/cronjob.config.sample.json`

Runtime files used by the app:

- `src/config/Sources.json`
- `src/config/cronjob.config.json`

### 4. Seed the source configuration into SQLite

```bash
npm run seed
```

If you want to fully replace existing source records:

```bash
npm run seed:fresh
```

### 5. Start the application

```bash
npm start
```

### 6. Save your Telegram session string

On the first Telegram login, the app will prompt for:

- phone number
- password, if 2FA is enabled
- verification code

After a successful login, Inemuri can print a new `TELEGRAM_SESSION` string. Save that value in `.env` so future starts are non-interactive.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes | Runtime mode. Use `production` for normal operation. |
| `TELEGRAM_SESSION` | Yes after first login | Persisted GramJS session string for Telegram authentication. |
| `TELEGRAM_API_ID` | Yes | Telegram API ID from your Telegram developer app. |
| `TELEGRAM_API_HASH` | Yes | Telegram API hash from your Telegram developer app. |
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token used for sending messages and slash commands. |
| `CMC_API_KEY` | Optional | Required for the bundled crypto daily cron job. |
| `DISCORD_COMMAND_WHITELIST` | Optional | Comma-separated list of Discord user IDs allowed to run slash commands. |
| `POLLING_INTERVAL_MIN` | Yes if polling is used | Polling interval, in minutes. |
| `POLLING_FETCH_LIMIT` | Yes if polling is used | Number of Telegram messages fetched per polling cycle. |

### Operational warning

When `NODE_ENV="development"`, the current database sync logic uses `force: true`, which may recreate tables during startup. Use `production` unless you intentionally want destructive dev sync behavior.

## Configuration

### Source configuration

The source registry lives in `src/config/Sources.json`. Each record describes:

- where the message comes from
- how it should be preprocessed
- how it should be filtered
- where it should be delivered
- whether it uses listener, polling, or both modes

Example:

```json
{
  "sources": [
    {
      "platform": "telegram",
      "channel_id": "-1001234567890",
      "channel_name": "My Source Channel",
      "is_active": true,
      "mode": "polling",
      "text_replacements": {
        "enabled": true,
        "patterns": [
          {
            "pattern": "\\[Sponsored\\].*?\\[/Sponsored\\]",
            "replacement": "",
            "is_regex": true,
            "flags": "gis",
            "comment": "Remove sponsored blocks"
          },
          {
            "pattern": "@sourcechannel",
            "replacement": "",
            "is_regex": false,
            "comment": "Remove source mention"
          }
        ]
      },
      "filters": {
        "enabled": true,
        "keywords": ["airdrop", "release"],
        "blacklist": ["spam"],
        "case_sensitive": false
      },
      "destinations": {
        "telegram": ["-1002222222222"],
        "discord": ["123456789012345678"]
      }
    }
  ]
}
```

#### Source fields

| Field | Description |
| --- | --- |
| `platform` | Source platform. The current runtime primarily uses `telegram`, but the model is designed around source platforms rather than a single hardcoded flow. |
| `channel_id` | Telegram chat/channel ID as a string-compatible value. |
| `channel_name` | Friendly name used in logs and routed message metadata. |
| `is_active` | Enables or disables the source. |
| `mode` | `listener`, `polling`, or `both`. |
| `text_replacements` | Preprocessing rules applied before filters. |
| `filters` | Keyword/blacklist rules. |
| `destinations` | Target Telegram/Discord destination IDs. |

### Source modes

- `listener`: listens for MTProto updates only
- `polling`: periodically fetches messages from the source
- `both`: combines listener and polling, with deduplication support

Use `polling` or `both` for channels where listener-only behavior is not reliable enough.

### Text replacements

Text replacements run before filtering and are useful for removing:

- footers
- channel mentions
- ad blocks
- repeated separators
- noisy boilerplate text

The runtime supports:

- simple string replacement
- regex replacement with flags

See [docs/text_replacements.md](docs/text_replacements.md) for detailed examples.

### Cron destinations

Scheduled job destinations live in `src/config/cronjob.config.json`.

Example:

```json
{
  "dailyinfo": {
    "destinations": {
      "telegram": ["-1001234567890"],
      "discord": ["123456789012345678"]
    }
  }
}
```

## Built-in scheduled job

The repository currently includes a daily crypto report job defined in `src/config/cronjobs.js`.

It:

- fetches market data via `CryptoDataService`
- builds a formatted message
- optionally attaches `src/assets/images/daily.png`
- emits the result through the same event pipeline as Telegram messages

There is also a Discord slash command:

- `/daily`: manually triggers the daily report for whitelisted users

## CLI commands

### NPM scripts

| Command | Description |
| --- | --- |
| `npm start` | Starts the full application. |
| `npm run seed` | Seeds sources from `src/config/Sources.json`. |
| `npm run seed:fresh` | Clears all sources and reseeds them. |

### Direct CLI usage

The CLI entrypoint is `src/cli.js`.

Examples:

```bash
node src/cli.js list
node src/cli.js list --active-only
node src/cli.js list --platform telegram
node src/cli.js toggle -1001234567890
node src/cli.js clear --confirm
```

## Media handling

Inemuri can download Telegram media and re-upload it to Discord or Telegram.

Current flow includes:

- media type detection
- grouped message support for Telegram albums
- Discord file-size checks
- optional Discord embed formatting for supported image types

See [docs/USE_EMBED.md](docs/USE_EMBED.md) for notes about embed behavior and media handling.

## Data storage

The runtime database is SQLite:

- file: `database/pot.sqlite`
- ORM: Sequelize

Key models:

- `Source`: source metadata, filters, replacements, destinations, mode
- `SourceState`: polling checkpoint state (`last_message_id`)

`SourceState` is especially important for:

- polling continuity
- first-run baselines
- deduplication support when a source uses `mode: "both"`

## Repository structure

```text
src/
├── inemuri.js                     # bootstrap
├── cli.js                         # source management CLI
├── config/                        # env-backed and JSON config
├── sources/                       # source adapters
├── destinations/                  # destination adapters
├── module/eventbus/               # internal events
├── module/routing/                # routing
├── module/filters/                # filtering and replacements
├── module/discord/                # Discord client and commands
├── module/telegram/               # Telegram client
├── module/cron/                   # cron scheduler
├── module/teapot/                 # database layer
├── services/crypto/               # external data services
└── shared/                        # logging and utility helpers
```

For the full tree, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Troubleshooting

### Telegram login keeps asking for credentials

Make sure you copied the printed session string into `TELEGRAM_SESSION` in `.env`.

### Messages are not being processed or delivered

Check the following:

- the source exists in `src/config/Sources.json`
- you ran `npm run seed`
- `is_active` is `true`
- destination IDs are correct
- the source mode matches your intended behavior

### Polling sources are not picking up new content

Verify:

- `POLLING_INTERVAL_MIN` is set
- `POLLING_FETCH_LIMIT` is set
- the source mode is `polling` or `both`
- `SourceState` has been created in SQLite

### The daily report fails

Check:

- `CMC_API_KEY`
- `src/config/cronjob.config.json`
- destination IDs for `dailyinfo`

### Legacy docs mention Google Sheets

Treat those references as historical design notes. The current code uses JSON config files plus SQLite.

## Additional documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): project structure and runtime architecture
- [docs/text_replacements.md](docs/text_replacements.md): preprocessing and regex replacement rules
- [docs/USE_EMBED.md](docs/USE_EMBED.md): media and Discord embed behavior
- [docs/DETAILED_OPTIMIZATION_EXPLANATION.md](docs/DETAILED_OPTIMIZATION_EXPLANATION.md): optimization notes

## License

ISC

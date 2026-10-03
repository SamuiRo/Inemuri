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
- Manages Discord servers through discordapp: channel export, role panels, AutoMod, and provisioning a whole server from a config file, with nothing ever deleted ([docs/DISCORDAPP.md](docs/DISCORDAPP.md))
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
- `src/module/discord/DiscordRest.js`: Discord REST client used by delivery (no gateway session)
- `src/module/discordapp/DiscordApp.js`: discordapp — Discord server management, slash commands
- `src/module/teapot/sqlite/sqlite_db.js`: SQLite/Sequelize connection

For the full repo map, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Important note about older docs

Some older notes in `docs/` describe a broader or earlier architecture, including Google Sheets-based configuration. The current implementation in this repository is file-based and database-backed:

- source definitions come from `src/config/sources.json`
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

- `src/config/sources.sample.json`
- `src/config/cronjob.config.sample.json`

Runtime files used by the app:

- `src/config/sources.json`
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
| `DISCORD_BOT_TOKEN` | For Discord | Bot token. Without it Discord delivery and discordapp are off; everything else runs. |
| `CMC_API_KEY` | Optional | Required for the bundled crypto daily cron job. |
| `DISCORD_COMMAND_WHITELIST` | Optional | Comma-separated Discord user IDs allowed to run admin commands. **Empty = nobody** (since `v4.31.0`). |
| `DISCORD_GUILD_IDS` | Optional | Comma-separated servers discordapp serves. Empty = every server the bot is in. |
| `DISCORD_APP_ENABLED` | Optional | `false` skips discordapp's gateway session. Delivery is unaffected. Default `true`. |
| `DISCORD_UPLOAD_LIMIT_MB` | Optional | Largest file Discord delivery sends as an attachment. Default `20`. |
| `DISCORD_EXPORT_TELEGRAM_CHAT` | Optional | Telegram chat id or `@username` that also receives `/export-chats` files. Empty = disk only. |
| `POLLING_INTERVAL_MIN` | Yes if polling is used | Polling interval, in minutes. |
| `POLLING_FETCH_LIMIT` | Yes if polling is used | Number of Telegram messages fetched per polling cycle. |

### Operational warning

When `NODE_ENV="development"`, the current database sync logic uses `force: true`, which may recreate tables during startup. Use `production` unless you intentionally want destructive dev sync behavior.

## Configuration

### Source configuration

The source registry lives in `src/config/sources.json`. Each record describes:

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
| `channel_id` | Telegram chat/channel ID as a string-compatible value. It is also the identity the seeder matches on — see [Seeding](#seeding-sources) before changing it on an existing source. |
| `channel_name` | Friendly name used in logs and routed message metadata. |
| `is_active` | Enables or disables the source. |
| `mode` | `listener`, `polling`, or `both`. |
| `poll_interval_min` | Optional. How often to poll this source, in minutes. Omit it to use the global `POLLING_INTERVAL_MIN`. Ignored for `listener`. |
| `extra_media_types` | Optional. Media types to download for this source in addition to the global `DOWNLOADABLE_MEDIA_TYPES`, e.g. `["audio"]`. Additive only. |
| `text_replacements` | Preprocessing rules applied before filters. |
| `filters` | Keyword/blacklist rules, plus the optional `reject_shouty` rule. |
| `destinations` | Target Telegram/Discord destination IDs. Ignored while the source is flow-enabled. |
| `flow` | Optional. Puts the source through TheFlow instead of classic forwarding — see [below](#enabling-a-source-into-theflow). Absent means `{ "enabled": false }`. |

### Feed sources: RSS, Atom, news sitemaps, WordPress and Reddit

Besides Telegram channels, a source can be a news feed or a subreddit. They
are polled (never listened to), go through the same text replacements and
filters, and feed TheFlow or classic forwarding just like a Telegram source.

```json
{
  "platform": "rss",
  "channel_id": "https://store.steampowered.com/feeds/news/app/730/",
  "channel_name": "CS2 news",
  "poll_interval_min": 30,
  "flow": { "enabled": true, "topics": ["steam"] }
}
```

```json
{
  "platform": "reddit",
  "channel_id": "r/cs2",
  "channel_name": "r/cs2",
  "flow": { "enabled": true }
}
```

- `rss`: `channel_id` is the feed URL — RSS 2.0 and Atom are both read.
  `reddit`: `channel_id` is the subreddit (`r/name`, `name`, or its URL).
- `poll_interval_min` defaults to `FEED_POLL_INTERVAL_MIN` (15). `mode` is
  ignored — feeds are always polled.
- The first poll only records what is already there; nothing old is
  ingested or forwarded.
- Only the feed's own content is used (title, summary or content, link,
  images) — pages are not scraped. For TheFlow the title is a separate field;
  for classic forwarding the message is the bold title, the text and the link.
- Requests are polite: a descriptive User-Agent (`FEED_USER_AGENT`), at least
  7 s between Reddit requests and 2 s between requests to any other host,
  conditional GET, Retry-After respected.
- **News sites without a useful feed** stay `"platform": "rss"` and set
  `feed.discovery` (docs/theflow/NEWS_INTAKE.md):

  ```json
  {
    "platform": "rss",
    "channel_id": "https://nypost.com/news-sitemap.xml",
    "channel_name": "NYPost",
    "poll_interval_min": 5,
    "feed": { "discovery": "sitemap" }
  }
  ```

  `sitemap` — `channel_id` is a news sitemap (find it in the site's
  `robots.txt`, `Sitemap:` lines) or an index of sitemaps, whose freshest
  child is read; `.xml.gz` works. Items carry the title, date and keywords,
  no text. `wpjson` — `channel_id` is the root of a WordPress site; the
  WordPress REST API gives the title and the excerpt. Without `feed`, or
  with `"discovery": "rss"`, the source is a plain RSS/Atom feed.
  A large outlet publishes 200–400 articles a day; turn on **headline
  triage** for it: `"feed": { "discovery": "sitemap", "triage": true }` on a
  source with `"flow": { "enabled": true }`. New articles then wait in
  `discovered_items`; sections listed in the triage profile
  (`deny_sections`: sports, betting, shopping…) are dropped at once, the rest
  is judged by the model in batches of ~50 headlines against the reader
  profile, and only what passes becomes a post. The profile is
  `src/config/triage.json` — your own interests, so it is git-ignored: copy
  `triage.sample.json` and describe what you want to read.
  `node src/cli.js flow triage stats` shows what it decided,
  `flow triage review` labels its decisions into the knowledge base.
  Triage runs inside the enrich worker, so without a provider key the
  articles simply wait.
- **Reddit needs OAuth credentials in practice.** Reddit refuses many
  unauthenticated clients (403). Create a "script" app at
  reddit.com/prefs/apps and set `REDDIT_CLIENT_ID` and
  `REDDIT_CLIENT_SECRET`; without them a refused Reddit source logs one
  warning and retries every 6 hours.

### Source modes

- `listener`: listens for MTProto updates only
- `polling`: periodically fetches messages from the source
- `both`: combines listener and polling, with deduplication support

### Rejecting shouty posts

`filters.reject_shouty` drops short all-caps posts — the ritual
`ВСЕМ СПАСИБО. СПОКОЙНОЙ НОЧИ.` or a daily countdown, which change wording
every time and so have no stable substring a blacklist could match.

```json
"filters": {
  "enabled": true, "keywords": [], "blacklist": [], "case_sensitive": false,
  "reject_shouty": { "max_length": 120, "min_caps_ratio": 0.8 }
}
```

Omit it (or pass `null`) to leave the rule off, which is the default; pass
`true` for the defaults shown above. Those thresholds were measured against
real posts, where ritual posts scored 1.00 and the most shouty *useful* post
0.21 — a wide margin. `min_caps_ratio` counts uppercase among letters only, so
digits, emoji and punctuation do not dilute it, and it works for Cyrillic.

The rule is **per source and off by default** because it cannot be safe
globally: a bare promo code (`PS3QWS3ACGDK`) is 100% caps and 12 characters,
exactly the shape it targets. Promo-like tokens are therefore excluded inside
the check as well, so a code survives even on a source where the rule is on —
configuration alone is not relied on for that.

A flow-enabled source records rejected posts as `skipped_shouty` rather than
discarding them, so `flow stats` can show how much the rule is catching.

### Enabling a source into TheFlow

`flow` on a source decides which of the two pipelines it uses. Omit the block
and the source forwards classically, exactly as before TheFlow existed.

```json
"flow": {
  "enabled": true,
  "topics": null,
  "min_confidence": 0.6,
  "dedup_window_hours": null,
  "vision": { "enabled": false, "text_threshold": 200, "max_images_per_post": 2 }
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | Route this source through TheFlow. Default `false`. |
| `topics` | Restrict the source to these topics (`categories.json`), or `null` for all of them. Use it where a topic is signal on one channel and noise on another. |
| `min_confidence` | Below this the verdict goes to `#unsorted` instead of a topic channel. |
| `dedup_window_hours` | Per-source override of the per-topic window. `null` keeps the topic's own. |
| `vision.enabled` | Transcribe screenshots on this source (phase 1.5). Off by default. |
| `vision.text_threshold` | Skip transcription when the post already has more than this many characters — the image is then decorative. |
| `vision.max_images_per_post` | Cap on images transcribed per post, so an album cannot drain the daily quota. |

The seeder merges a partial block with those defaults, so `{"enabled": true}`
is a complete configuration.

**A flow-enabled source stops forwarding.** The two pipelines are exclusive:
its posts are persisted, enriched and (from phase 2) routed by content, and
`destinations` is not used meanwhile. Keep the destinations in the config
anyway — they are what the source returns to when `flow.enabled` goes back to
`false`, and a reseed would otherwise erase them.

Without a provider key the source still ingests: posts accumulate as `pending`
and wait. Enrichment starts the first time the service boots with a key set.

Turning it on is: edit `sources.json` → `npm run seed` → **restart the
service**, since source config is read once at startup. Then
`node src/cli.js flow stats`.

### Seeding sources

`npm run seed` imports `sources.json` into the database, matching each record
on `platform` + `channel_id` — updating that row if it exists, creating one if
it does not. Two consequences are easy to get wrong:

- **`channel_id` is the identity.** The same channel written as `@username`
  where the stored row holds its numeric id is imported as a *second* source,
  and the channel is then polled twice. After seeding, check
  `node src/cli.js list` for duplicates.
- **The file wins on every field it defines**, `destinations` included. A
  source whose destinations were only ever set in the database loses them on
  the next reseed.

`npm run seed:fresh` clears all sources first and reseeds; it drops anything
that exists only in the database.

### Polling schedule

Polling runs on **one** timer, not one per source. Every `POLLING_TICK_MS` the
scheduler polls only the sources whose turn has come — `poll_interval_min` on
the source, or `POLLING_INTERVAL_MIN` when it is unset — serialized with
`POLLING_CHANNEL_DELAY_MS` between channels. Keeping a single serialized cycle
is deliberate: independent per-source timers would let several channels fire at
once, which is the failure mode the delay exists to prevent.

Three details make a mixed set of intervals safe:

- **A deterministic phase offset per source.** Sources sharing an interval
  would otherwise stay synchronized forever — six channels set to daily would
  mean six requests in the same second, every day. The offset is derived from
  the source id, so the schedule survives a restart instead of being reshuffled.
- **A ceiling of `POLLING_MAX_PER_TICK` channels per tick.** Even when
  everything comes due at once — after a restart, or a long `FLOOD_WAIT` — one
  tick stays bounded and the remainder slips to the next. The most overdue
  source goes first, so a short-interval channel cannot starve one that has
  been waiting.
- **Page-by-page catch-up**, capped at `POLLING_MAX_DRAIN_PAGES`. A channel
  polled once a day with `POLLING_FETCH_LIMIT` at 50 would otherwise fall
  permanently behind: it collects 50 messages per tick while more than that
  arrives per day.

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

discordapp adds slash commands and buttons; every reply is visible only to the caller, and admin commands are limited to `DISCORD_COMMAND_WHITELIST`:

- `/daily`: manually triggers the daily report.
- `/export-chats limit:<1–100> [format:md|json|both] [scope:this|all]`: exports the latest messages of every channel and thread the bot can read into `exports/` (git-ignored), and sends the file to Telegram when `DISCORD_EXPORT_TELEGRAM_CHAT` is set. Nothing is attached in Discord — the reply is a summary. Needs the **Message Content** intent enabled for the bot in the Discord Developer Portal; without it Discord returns other people's messages empty, and the reply warns about it. Details: [docs/DISCORDAPP.md](docs/DISCORDAPP.md#feature-export-chats).
- `/provision plan [server:<name>]`: compares the server with its config in `src/config/discordapp/servers/<name>.json` (git-ignored; start from `example.sample.json`) and shows what applying would create, update, adopt, archive or reorder. Changes nothing. Details: [docs/DISCORDAPP.md](docs/DISCORDAPP.md#feature-provisioning-server-as-code). Inviting the bot and the permissions it needs: [docs/DISCORDAPP.md](docs/DISCORDAPP.md#setup).
- `node scripts/discordapp.js check|apply|export <guildId> [config] [--yes]`: the same from a terminal — `check` verifies the bot's setup on a server (role position, permissions, Message Content, commands) and prints the plan; `apply --yes` applies it; `export` writes the server as a config.
- Role panels: buttons that give or take a role, published by provisioning (`rolePanel` messages). Any member can press them; roles with moderation or admin permissions are refused. Categories with `optIn` are visible only to members holding the role.
- Day-to-day use — editing, adding, retiring, taking over an existing server, troubleshooting: [docs/PROVISIONING.md](docs/PROVISIONING.md).
- `/provision export`: writes the server as a config file (`exports/config-<server>.json`, also attached) to start a config from. Changes nothing.
- `/provision apply [server:<name>]`: the same plan with an **Apply** button. Nothing is ever deleted — a channel removed from the config moves into the private archive category. Needs the bot to hold Administrator for the duration: give it a role with Administrator, apply, take the role away.

## CLI commands

### NPM scripts

| Command | Description |
| --- | --- |
| `npm start` | Starts the full application. |
| `npm run seed` | Seeds sources from `src/config/sources.json`. |
| `npm run seed:fresh` | Clears all sources and reseeds them. |
| `npm run db:bootstrap` | Creates missing tables in an empty database. Run **before** `npm run migrate` on a fresh install — migrations cannot bootstrap from nothing. No-op once the tables exist. |
| `npm run migrate` | Applies pending schema migrations (takes a backup first). |
| `npm run migrate:status` | Lists applied and pending migrations. |
| `npm test` | Runs the `node --test` suites under `test/` against a throwaway database in the OS temp dir, never `database/pot.sqlite`. One file: `npm test -- test/x.test.js`. |
| `npm run lint` | ESLint over the project (`lint:fix` to auto-fix). |

### Direct CLI usage

The CLI entrypoint is `src/cli.js`.

Examples:

```bash
node src/cli.js list
node src/cli.js list --active-only
node src/cli.js list --platform telegram
node src/cli.js toggle -1001234567890
node src/cli.js clear --confirm
node src/cli.js flow stats
node src/cli.js flow review
node src/cli.js flow requeue --dry-run
node src/cli.js flow requeue --error "HTTP 400"
node src/cli.js flow requeue --status enriched --model some-model
node src/cli.js flow requeue --status enriched --prompt-below 2
node src/cli.js flow health
node src/cli.js flow dedup
node src/cli.js flow dedup --pairs 30
node src/cli.js flow dedup --reset --run
node src/cli.js flow search hamster airdrop
node src/cli.js flow search --semantic "which teams made the playoffs" --topic steam
node src/cli.js flow preview --ignore-age --limit 5
node src/cli.js flow digest --hours 24
```

`flow requeue` returns posts to the enrich queue — `pending`, `attempts` 0,
verdict and embedding cleared, `text_ocr` kept so vision is not paid for
twice. Default is every `failed` post; `--error` narrows by `last_error`,
`--status`/`--model` pick verdicts that cannot be trusted, `--prompt-below`
re-extracts verdicts made by an older enrich prompt (`analysis.prompt_version`). It reports how many
of them carry `post_feedback` labels for the old verdict.

`flow search` searches the TheFlow corpus: by keywords through SQLite FTS5
(no AI call, Cyrillic included), or with `--semantic` by meaning through one
embedding call — a query in one language finds posts in another. Filters:
`--topic`, `--signal`, `--days`, `--source`, `--limit`. The same search is
the `/search` slash command in discordapp.

`flow digest` previews the scheduled TheFlow digest: one line per event of the
period, grouped by topic with security first, "×N" for how many channels
reported it, and a link to the original. It is sent on `FLOW_DIGEST_CRON`
(default `0 9 * * *`, server time) to `digest_destinations` in `routing.json`,
and not scheduled when that key is absent.

Labels written by `flow review` also feed the enrich prompt as examples: a
`good` label shows a correct verdict, a `wrong` label with a note shows a
mistake and the reviewer's correction.

`flow preview` shows what TheFlow delivery would send, where, rendered for
each platform — without sending. Delivery itself is off until
`FLOW_DELIVERY_ENABLED=true`; posts older than `FLOW_DELIVERY_MAX_AGE_HOURS`
(24) are never sent. `--ignore-age` previews older posts too, for working on
the template.

`flow dedup` reports deduplication (ROADMAP §6): per day and per signal how
many posts started a new event, joined one by tier 1 (exact code, link or
text) or tier 2 (embedding similarity to another source's post), were
suppressed as adding nothing, or were flagged in the gray zone; plus the
similarity histogram against `DEDUP_HIGH`/`DEDUP_LOW`. `--pairs n` prints the
closest pairs around the thresholds with both texts, for calibration;
`--reset --run` recomputes every decision after changing them, and is refused
once anything has been delivered.

`flow health` runs the check the service runs every 10 minutes and exits 1 if
anything is wrong: enrichment failing, a queue that is not draining (while
quota is left), or no flow post for a day. The service sends the same alerts
to `health_destinations` in `routing.json` — set a Telegram chat there, or
they only reach the log. Thresholds are the `FLOW_HEALTH_*` variables in
`.env.example`.

## Media handling

Inemuri can download Telegram media and re-upload it to Discord or Telegram.

Current flow includes:

- media type detection
- grouped message support for Telegram albums
- Discord file-size checks
- optional Discord embed formatting for supported image types

Media crosses three independent stages, each dropping things for its own
reasons: `parseMedia()` classifies, `DOWNLOADABLE_MEDIA_TYPES` in
`src/config/app.config.js` decides what is downloaded, and
`supportedMediaTypes` in `DiscordDestination` decides what may become an
embed image. See [docs/media.md](docs/media.md) — including why an `audio`
file parses but never arrives.

### First run on an empty database

```bash
npm run db:bootstrap   # sync() creates tables from the models
npm run migrate        # applies what sync() does not know about
npm start
```

The order matters and is not interchangeable. **Migrations cannot create the
schema from nothing**: `sources` and `source_states` predate the migration
system and are created by `database.sync()` at application start, not by any
migration — so `npm run migrate` against an empty file fails in migration
`002` at `describeTable("sources")`. `db:bootstrap` fills that gap and is a
no-op once the tables exist.

## Data storage

The runtime database is SQLite:

- file: `database/pot.sqlite`
- ORM: Sequelize

Key models:

- `Source`: source metadata, filters, replacements, destinations, mode
- `SourceState`: polling checkpoint — `last_message_id` for Telegram, `cursor` (`{ ts, seen, etag, lastModified }`) for feed sources

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
├── module/discord/                # Discord transport: REST (delivery) and gateway
├── module/discordapp/             # discordapp: Discord server management
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

- the source exists in `src/config/sources.json`
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

## TheFlow

TheFlow is a subsystem of Inemuri, not a separate product. Inemuri stays the
name of the whole system; TheFlow is the part of it that turns the raw ingested
firehose into a stream of validated posts — translating them to a canonical
language, categorizing them, extracting structured entities, deduplicating
events across channels, and routing by content instead of by source.

**Phase 0 (persistence without AI) is implemented.** A `flow` column on each
source (default `{ enabled: false }`), the `posts` / `clusters` tables, a
deterministic regex stage, and stage-1 ingest. No AI calls yet. Enable it per
source as described in
[Enabling a source into TheFlow](#enabling-a-source-into-theflow), then
`npm run migrate` once. Classic forwarding is unchanged and stays
available per source; sources without `flow.enabled` behave exactly as before.

**Phase 1 (LLM gateway and enrichment, shadow mode) is implemented but
dormant.** The provider layer, `LLMGateway`, `categories.json` v1, and the
enrichment worker all exist and are wired into `src/inemuri.js` — but the
worker only starts once a primary provider API key is set in `.env`; without
one, `pending` posts simply accumulate and nothing else changes. Even running,
routing still ignores its verdicts (`LLM_SHADOW_MODE`). The provider
decisions and their measured free-tier limits are settled — see
[docs/theflow/ROADMAP.md](docs/theflow/ROADMAP.md) §3.

**Phase 1.5 (vision) is implemented.** Screenshots on a source with
`flow.vision.enabled` are transcribed into `posts.text_ocr` between ingest and
enrichment — photos and image documents alike, deduplicated by perceptual hash
so a repost of the same image costs no second call. Off on every source by
default.

Phase 2's resolve stage is built and waiting on destination channels; the rest
of phases 2–5 (content routing, deduplication, entity extraction, digests) is
still specification.

- [docs/CHANGELOG.md](docs/CHANGELOG.md): per-version record of what shipped
- [docs/THEFLOW.md](docs/THEFLOW.md): concept, layering, decisions, phases, current status

## Additional documentation

- [docs/HANDOFF.md](docs/HANDOFF.md): current state and next steps — start here
- [docs/CHANGELOG.md](docs/CHANGELOG.md): per-version record of what shipped and why
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): project structure and runtime architecture
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): pm2 deploy and schema-migration procedure
- [docs/THEFLOW.md](docs/THEFLOW.md): TheFlow specification (Phase 0 and Phase 1 implemented, later phases specified)
- [docs/text_replacements.md](docs/text_replacements.md): preprocessing and regex replacement rules
- [docs/media.md](docs/media.md): media pipeline and Discord embed behavior
- [docs/HANDOFF.md](docs/HANDOFF.md): current state and next steps
- [docs/CHANGELOG.md](docs/CHANGELOG.md): per-version record of what shipped and why

## License

ISC

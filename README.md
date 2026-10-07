# Inemuri

Event-driven content and data flow manager. Inemuri ingests from configured
sources — Telegram channels, RSS/Atom feeds, news sitemaps, the WordPress
API, Reddit — and from scheduled jobs, normalizes everything into one event
pipeline, applies replacements and filters, and delivers to Telegram and
Discord. Two subsystems sit inside it:

- **TheFlow** turns a noisy multilingual stream into validated, categorized,
  deduplicated posts routed by content ([docs/THEFLOW.md](docs/THEFLOW.md)).
- **discordapp** manages Discord servers: slash commands, channel export,
  role panels, AutoMod and provisioning a whole server from a config file
  ([docs/DISCORDAPP.md](docs/DISCORDAPP.md)).

Current state and next steps: [docs/HANDOFF.md](docs/HANDOFF.md). Repo map and
runtime flow: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```text
source / cron job ─> replacements → filters ─┬─ classic: EventBus "message.received" → MessageRouter → Discord / Telegram
                                             └─ TheFlow: posts → enrich → dedup → resolve → delivery
```

## Quick start

Prerequisites: Node.js 22+, a Telegram user account with API credentials
(`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`), a Discord bot token for Discord
delivery, optionally a CoinMarketCap key (daily crypto report) and a Gemini
key (TheFlow).

```bash
npm ci
cp .env.example .env                                    # fill in real values
cp src/config/sources.sample.json src/config/sources.json  # then describe your sources
npm run setup                                           # database: bootstrap + migrate + seed
npm start
```

`.env.example` lists every variable with its default. Keep
`NODE_ENV="production"`: under `development` the database sync uses
`force: true` and recreates tables, destroying configured sources.

On the first Telegram login the app asks for the phone number, the 2FA
password and the code, then prints a `TELEGRAM_SESSION` string — save it in
`.env` so later starts are non-interactive.

`npm run setup` is `npm run db:bootstrap` (tables that predate migrations),
`npm run migrate`, `npm run seed`; `-- --knowledge <file>` also imports a
knowledge base, `-- --new` moves an existing database to `database/backups/`
and starts empty. The order matters: migrations cannot create the schema from
nothing, so `npm run migrate` on an empty file stops with an explanation.
Production install and deploys: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Configuration files

Deployment data is git-ignored (the repository is public). Each file has a
tracked `*.sample.*` with neutral content; a missing file falls back to its
sample with a `[CONFIG]` warning, a malformed one stops the start.

| File | Holds |
|---|---|
| `.env` | Secrets and switches — see `.env.example` |
| `src/config/sources.json` | Sources (below); imported into SQLite by `npm run seed` |
| `src/config/routing.json` | TheFlow destinations: `routing` rules, `unsorted_destinations`, `health_destinations`, `digest_destinations`, `status_destinations` |
| `src/config/triage.json` | Reader profile for headline triage ([NEWS_INTAKE.md](docs/theflow/NEWS_INTAKE.md) §5) |
| `src/config/cronjob.config.json` | Destinations of cron jobs |
| `src/config/discordapp/servers/*.json`, `messages/**` | discordapp server configs and texts |

`src/config/categories.json` (the TheFlow taxonomy) is tracked.

### Main environment variables

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_SESSION`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Telegram user client |
| `TELEGRAM_PREMIUM` | `true` if the sending account has Premium: media captions up to 4096 instead of 1024 |
| `DISCORD_BOT_TOKEN` | Without it Discord delivery and discordapp are off; everything else runs |
| `DISCORD_COMMAND_WHITELIST` | User ids allowed to run admin commands. **Empty = nobody** |
| `DISCORD_GUILD_IDS`, `DISCORD_APP_ENABLED`, `DISCORD_UPLOAD_LIMIT_MB`, `DISCORD_EXPORT_TELEGRAM_CHAT` | discordapp and Discord delivery — [DISCORDAPP.md](docs/DISCORDAPP.md#configuration) |
| `POLLING_INTERVAL_MIN`, `POLLING_FETCH_LIMIT` | Telegram polling defaults |
| `CMC_API_KEY` | The bundled daily crypto report |
| `GEMINI_API_KEY`, `LLM_PRIMARY`, `LLM_FALLBACK`, `OPENROUTER_*` | TheFlow providers ([LLM_GATEWAY.md](docs/theflow/LLM_GATEWAY.md)); without a primary key the enrich worker does not start |
| `FLOW_DELIVERY_ENABLED` | TheFlow delivery; `false` by default (shadow mode) |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit sources (unauthenticated requests get 403) |
| `FLOW_*`, `DEDUP_*`, `STATUS_*`, `FEED_*` | Tuning, all with working defaults — see `.env.example` |

## Sources

A source is one entry in `src/config/sources.json`:

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
          { "pattern": "\\[Sponsored\\].*?\\[/Sponsored\\]", "replacement": "", "is_regex": true, "flags": "gis", "comment": "Remove sponsored blocks" },
          { "pattern": "@sourcechannel", "replacement": "", "is_regex": false }
        ]
      },
      "filters": { "enabled": true, "keywords": ["airdrop", "release"], "blacklist": ["spam"], "case_sensitive": false },
      "destinations": { "telegram": ["-1002222222222"], "discord": ["123456789012345678"] }
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `platform` | `telegram`, `rss` or `reddit` |
| `channel_id` | Telegram chat id, feed URL, or subreddit. It is the identity the seeder matches on — see [Seeding](#seeding-sources) |
| `channel_name` | Name used in logs and in delivered messages |
| `is_active` | Enables or disables the source (default `true`) |
| `mode` | Telegram only: `listener`, `polling` or `both` (default `listener`) |
| `poll_interval_min` | How often to poll this source; default `POLLING_INTERVAL_MIN` (Telegram) or `FEED_POLL_INTERVAL_MIN` (feeds) |
| `extra_media_types` | Media types downloaded in addition to the global list, e.g. `["audio"]` ([media.md](docs/media.md)) |
| `text_replacements` | Applied before filters ([text_replacements.md](docs/text_replacements.md)) |
| `filters` | `keywords` (whitelist), `blacklist`, `case_sensitive`, and the optional `reject_shouty` and `min_length` rules below |
| `destinations` | Classic delivery targets. Ignored while the source is flow-enabled, but kept — the source returns to them when `flow.enabled` goes back to `false` |
| `flow` | Puts the source through TheFlow — see [below](#enabling-a-source-into-theflow) |
| `feed` | Feeds only: `discovery` and `triage` — see below |

### Source modes (Telegram)

- `listener`: MTProto updates only. **No checkpoint** — what is posted while
  the service is down is lost.
- `polling`: periodic fetch from the last checkpoint.
- `both`: listener for latency plus polling as a safety net, deduplicated.

### Feed sources: RSS, Atom, news sitemaps, WordPress and Reddit

Feeds are always polled (`mode` is ignored), go through the same
replacements and filters, and feed TheFlow or classic forwarding.

```json
{ "platform": "rss", "channel_id": "https://store.steampowered.com/feeds/news/app/730/", "channel_name": "CS2 news", "poll_interval_min": 30, "flow": { "enabled": true, "topics": ["steam"] } }
{ "platform": "reddit", "channel_id": "r/cs2", "channel_name": "r/cs2", "flow": { "enabled": true } }
{ "platform": "rss", "channel_id": "https://nypost.com/news-sitemap.xml", "channel_name": "NYPost", "poll_interval_min": 5, "feed": { "discovery": "sitemap", "triage": true }, "flow": { "enabled": true } }
```

- `rss`: `channel_id` is the feed URL (RSS 2.0 or Atom). `feed.discovery`
  changes how new items are found: `sitemap` — a news sitemap or a sitemap
  index (its freshest child is read; `.xml.gz` works), items carry title,
  date and keywords; `wpjson` — the root of a WordPress site, items carry
  title and excerpt. `reddit`: `channel_id` is `r/name`, `name` or its URL.
- The first poll only records what is there; nothing old is ingested.
- Only the feed's own content is used — pages are not fetched. For TheFlow the
  title is a separate field; classic forwarding sends the bold title, the
  text and the link.
- Requests are polite: `FEED_USER_AGENT`, at least 7 s between Reddit
  requests and 2 s between requests to any other host, conditional GET,
  `Retry-After` respected.
- **Headline triage** (`"feed": { "triage": true }`, flow-enabled sources
  only) is for large outlets (200–400 articles a day): new articles wait in
  `discovered_items`, sections in the profile's `deny_sections` are dropped at
  once, the rest is judged by the model in batches of ~50 headlines against
  `src/config/triage.json`, and only what passes becomes a post. It runs in the
  enrich worker, so without a provider key the articles wait.
  `flow triage stats` and `flow triage review` show and label its decisions.
- **Reddit needs OAuth** in practice: create a "script" app at
  reddit.com/prefs/apps and set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`.
  Without them a refused source logs one warning and retries every 6 hours.

### Rejecting shouty posts

`filters.reject_shouty` drops short all-caps posts — rituals such as
`ВСЕМ СПАСИБО. СПОКОЙНОЙ НОЧИ.` or a daily countdown, which change wording
every time and so have no stable substring for a blacklist.

```json
"filters": { "enabled": true, "keywords": [], "blacklist": [], "case_sensitive": false,
             "reject_shouty": { "max_length": 120, "min_caps_ratio": 0.8 } }
```

Off by default (`null` or absent); `true` uses the defaults shown. Measured on
real posts: rituals score 1.00, the most shouty useful post 0.21.
`min_caps_ratio` counts uppercase among letters only, Cyrillic included. It is
per source because a bare promo code (`PS3QWS3ACGDK`) is exactly the shape it
targets; promo-like tokens are excluded inside the check as well, so a code
survives even where the rule is on. A flow source records rejects as
`skipped_shouty`.

### Dropping one-liners

`filters.min_length` drops posts shorter than N characters, counted after
replacements, without links, whitespace collapsed — for channels whose
one-line posts are teasers (`Sifu вийде на iOS та Android 12 жовтня`).

```json
"filters": { "enabled": true, "keywords": [], "blacklist": [], "min_length": 60 }
```

Off by default, per source, both pipelines. A post with a promo-like token is
never dropped (`Перший промокод MECHANISMCITY` is 29 characters and the point
of the channel). A flow source records rejects as `skipped_short`.

### Enabling a source into TheFlow

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
| `enabled` | Route this source through TheFlow. Default `false` |
| `topics` | Restrict the source to these topics (`categories.json`), `null` = all. A post outside the list goes to `#unsorted` |
| `min_confidence` | Below this the verdict goes to `#unsorted` |
| `dedup_window_hours` | Per-source override of the signal's dedup window |
| `vision.enabled` | Transcribe screenshots on this source. Off by default |
| `vision.text_threshold` | Skip transcription when the post already has more characters than this |
| `vision.max_images_per_post` | Cap on images transcribed per post |

The seeder merges a partial block with these defaults, so `{"enabled": true}`
is complete. **The two pipelines are exclusive**: a flow source is persisted,
enriched and routed by content, not forwarded to its `destinations`. Without a
provider key its posts accumulate as `pending`. Source config is read at
startup: edit `sources.json` → `npm run seed` → restart →
`node src/cli.js flow stats`.

### Seeding sources

`npm run seed` matches each record on `platform` + `channel_id`, updating the
row or creating one. It never deletes: a source that exists only in the
database keeps running.

- **`channel_id` is the identity.** The same channel written as `@username`
  where the row holds its numeric id becomes a *second* source, polled twice.
  Check `node src/cli.js list` after seeding.
- **The file wins on every field it defines**, `destinations` included.

`npm run seed:fresh` clears all sources first and drops anything that existed
only in the database.

### Polling schedule

Telegram polling runs on **one** timer. Every `POLLING_TICK_MS` it polls the
sources whose turn has come, serialized with `POLLING_CHANNEL_DELAY_MS`
between channels, so several channels never fire at once.

- **A deterministic phase offset per source**, derived from its id, so
  sources sharing an interval do not stay synchronized, and the schedule
  survives a restart.
- **At most `POLLING_MAX_PER_TICK` channels per tick**, most overdue first,
  so a burst after a restart or a long `FLOOD_WAIT` stays bounded.
- **Page-by-page catch-up**, up to `POLLING_MAX_DRAIN_PAGES`, so a channel
  polled once a day does not fall permanently behind `POLLING_FETCH_LIMIT`.

### Text replacements

Literal or regex substitutions run before filtering, to remove footers,
channel mentions, ad blocks and boilerplate. Details and examples:
[docs/text_replacements.md](docs/text_replacements.md).

## TheFlow

TheFlow is the part of Inemuri that turns the ingested firehose into a stream
of validated posts: canonical English, topic and signal, extracted entities
(codes, links, amounts, events), cross-source deduplication, routing by
content, delivery in Ukrainian. Status, phases and decisions:
[docs/THEFLOW.md](docs/THEFLOW.md).

Routing lives in `routing.json`. Rules match `topic`, `signal_type` or
`source` (channel id or name); the first by `priority` wins, and rules with
`"also": true` add destinations without ending the search
([TAXONOMY.md](docs/theflow/TAXONOMY.md#how-resolve-works)). Everything that
matches nothing, has low confidence, is an ad or failed goes to
`unsorted_destinations` with the reason.

**Health.** The service checks every 10 minutes for failing enrichment, a
queue that is not draining while quota is left, or no flow post for a day,
and alerts `health_destinations` (otherwise only the log). `FLOW_HEALTH_*`
in `.env.example` set the thresholds.

**Status board.** With `status_destinations`, Inemuri keeps one message there
and edits it every `STATUS_INTERVAL_MIN` (60): sources with no new post for
`STATUS_SOURCE_SILENT_HOURS` (72), sources never seen, and delivery channels
with no message for `STATUS_CHANNEL_SILENT_HOURS` (168). It covers every
source, not only flow ones. A deleted status message is posted again.

**Digest.** Sent on `FLOW_DIGEST_CRON` (default `0 9 * * *`, server time) to
`digest_destinations`: one line per event of the period, grouped by topic
with security first, `×N` for how many channels reported it. Not scheduled
without that key.

## discordapp

Every reply is visible only to the caller; admin commands require
`DISCORD_COMMAND_WHITELIST`.

| Command | What it does |
|---|---|
| `/daily` | Runs the daily crypto report now |
| `/search query [mode] [topic] [signal] [days] [limit]` | Searches the TheFlow corpus — keyword (FTS5, no provider call) or semantic |
| `/export-chats limit [format] [scope]` | Latest messages of every readable channel and thread into `exports/`, and to Telegram when `DISCORD_EXPORT_TELEGRAM_CHAT` is set. Needs the Message Content intent |
| `/provision plan [server]` | What applying the server's config would change. Changes nothing |
| `/provision apply [server]` | The same plan with an **Apply** button. Nothing is ever deleted; needs the bot to hold Administrator for the duration |
| `/provision export` | The server as a config file, to start one from |
| Role panel buttons | Give or take a role; open to every member; roles with moderation or admin permissions are refused |

From a terminal: `node scripts/discordapp.js check|apply|export|ids <guildId> [config] [--yes]`.
Setup and the contract: [docs/DISCORDAPP.md](docs/DISCORDAPP.md); running a
server day to day: [docs/PROVISIONING.md](docs/PROVISIONING.md).

## Scheduled jobs

Job handlers are in `src/config/cronjobs.js`, their destinations in
`src/config/cronjob.config.json`:

```json
{ "dailyinfo": { "destinations": { "telegram": ["-1001234567890"], "discord": ["123456789012345678"] } } }
```

The bundled job is a daily crypto report (`CryptoDataService`, optional
`src/assets/images/daily.png`), emitted through the same pipeline as any
message.

## CLI commands

| Command | Description |
| --- | --- |
| `npm start` | Start the service |
| `npm run setup` | Build or update the database from the configs (above) |
| `npm run db:bootstrap` | Create the tables that predate migrations (empty database only) |
| `npm run migrate` / `migrate:status` | Apply pending migrations (backup first) / list them |
| `npm run seed` / `seed:fresh` | Import `sources.json` / clear sources and reimport |
| `npm test` | `node --test` suites on a throwaway database; one file: `npm test -- test/x.test.js` |
| `npm run lint` / `lint:fix` | ESLint |

`node src/cli.js` — sources: `list [--active-only] [--platform p]`,
`toggle <channel_id>`, `clear --confirm`. TheFlow:

| Command | What it does |
|---|---|
| `flow stats` | Corpus per source and total: statuses, lengths, candidates, size |
| `flow export [--out f] [--limit n] [--status a,b]` | Sanitized JSONL sample |
| `flow review [--limit n] [--topic t]` | Label enriched posts (`good` / `noise` / `wrong_topic`); labels feed the enrich prompt |
| `flow requeue` | Back to the enrich queue: `failed` by default; `--error`, `--status`, `--model`, `--prompt-below`, `--dry-run`, `--reset-dedup` |
| `flow health` | The health check; exit 1 on a problem |
| `flow dedup [--pairs n] [--run] [--reset]` | Deduplication report, calibration pairs, backfill, recompute |
| `flow search <words> [--semantic] [--topic] [--signal] [--days] [--source] [--limit]` | Corpus search, as `/search` |
| `flow preview [--id] [--ignore-age] [--limit n] [--translate]` | What delivery would send, rendered per platform; sends nothing |
| `flow digest [--hours n]` | The digest, previewed |
| `flow knowledge stats\|export\|import\|backfill` | The portable knowledge base ([NEWS_INTAKE.md](docs/theflow/NEWS_INTAKE.md) §3.5) |
| `flow triage stats\|review` | Headline triage decisions and labelling |
| `flow preflight` | Deployment readiness; exit 1 on a blocker |

Notes that are easy to get wrong:

- `flow requeue` clears the verdict and embedding but keeps `text_ocr` (vision
  is not paid twice). A re-enriched post stays in its old cluster with the old
  topic unless `--reset-dedup` erases the decisions — refused once anything
  is delivered, as is `flow dedup --reset`.
- `flow preview` skips posts older than `FLOW_DELIVERY_MAX_AGE_HOURS` (24),
  as delivery does; `--ignore-age` shows them, for template work.

## Media

Telegram media is downloaded and re-uploaded to Discord or Telegram: albums
are buffered into one message, Discord file sizes are checked, the first image
becomes the embed picture. Three independent stages decide what arrives —
`parseMedia()`, `DOWNLOADABLE_MEDIA_TYPES` and the Discord adapter's
`supportedMediaTypes`. TheFlow fetches media lazily, only for posts it
delivers. See [docs/media.md](docs/media.md), including why an `audio` file
parses but never arrives.

## Troubleshooting

| Symptom | Check |
|---|---|
| Telegram asks to log in every start | `TELEGRAM_SESSION` in `.env` holds the printed session string |
| A source delivers nothing | It is in `sources.json` and seeded (`node src/cli.js list`), `is_active`, the destination ids are right; a flow source does not use `destinations` |
| A polling source picks up nothing | `mode` is `polling` or `both`; the status board or `node src/cli.js list` shows whether it was seen recently |
| `[CONFIG] … falling back to …sample.json` | The git-ignored config is missing on this machine — copy it ([DEPLOYMENT.md](docs/DEPLOYMENT.md#what-git-pull-does-not-bring)) |
| TheFlow posts stay `pending` | No primary provider key, `ENRICH_WORKER_ENABLED=false`, or the daily quota is spent — `node src/cli.js flow health` |
| The daily report fails | `CMC_API_KEY`, `cronjob.config.json`, the `dailyinfo` destinations |
| `npm run migrate` says "No sources table" | An empty database — [DEPLOYMENT.md](docs/DEPLOYMENT.md#when-migrate-says-no-sources-table) |

## License

See [LICENSE](LICENSE).

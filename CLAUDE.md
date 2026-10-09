# CLAUDE.md

Working notes for Claude Code in this repository.

## What this project is

Inemuri is an event-driven content and data flow manager: it ingests from
configured sources, normalizes into a shared event pipeline, filters, and routes
to destinations. Currently Telegram, RSS/Atom, Reddit and Discord (user
account, [docs/DISCORD_SOURCE.md](docs/DISCORD_SOURCE.md)) ingestion, Telegram
and Discord delivery, cron jobs, and Discord server management (discordapp).
The Discord *source* is not discordapp and not delivery: it reads other
servers through a user account in a child process and shares nothing with them.

Start with [docs/HANDOFF.md](docs/HANDOFF.md) for current state and next
steps, [README.md](README.md) for behavior and configuration, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the repo map and runtime
flow. [docs/CHANGELOG.md](docs/CHANGELOG.md) has the per-version record of
what shipped and why.

## Naming

**Inemuri is the name of the whole system.** Everything else is a part of it.

**TheFlow is a subsystem of Inemuri**, not a separate product or a peer system.
It is the part responsible for producing a stream of validated, categorized,
deduplicated posts. Phases 0–5 and 1.5 are **built** and live on the VPS since
2026-10-06; delivery to staff-only test channels is configured but was never
switched on there (`FLOW_DELIVERY_ENABLED` unset, found 2026-10-08). The
worker starts only with a provider key; delivery is off by default. Phase 6, news intake
([docs/theflow/NEWS_INTAKE.md](docs/theflow/NEWS_INTAKE.md)), has steps 1–3:
the knowledge base, sitemap/WordPress discovery and headline triage. Still
open: dedup threshold calibration, phase 6 step 4 and poll intervals (step 5's
silent-source half is the status board), reactions (deferred).
Per-phase status is in [docs/THEFLOW.md](docs/THEFLOW.md), per task in
`docs/theflow/ROADMAP.md`.

Never describe TheFlow as standing alongside or on top of Inemuri; it is inside it.

**discordapp is the Discord server-management module of Inemuri** — slash
commands, channel export, role panels, server provisioning from config. Call it
discordapp, not "the bot" or "discordbot". It runs in the same process and
talks to the core only through `EventBus`; Discord *delivery* is not part of it
and must never depend on it. See [docs/DISCORDAPP.md](docs/DISCORDAPP.md) for the
contract and [docs/PROVISIONING.md](docs/PROVISIONING.md) for running a server
with it. Real server configs and texts (`src/config/discordapp/servers/*.json`,
`src/config/discordapp/messages/**`) are git-ignored; only `*.sample.*` files
are tracked — never commit a real one. For provisioning work, load the
`discord-provisioning` skill (`.claude/skills/`); per-server skills
(`.claude/skills/server-*/`) are git-ignored and hold that server's
conventions — load the matching one when working on a specific server.

## Documentation

- **All documentation is written in English.** This applies to `README.md`,
  everything under `docs/`, and this file. Everything under `docs/` is now in
  English; there is no migration backlog left.
- Code comments in existing files are Ukrainian. Match the surrounding file
  rather than mixing languages within one file.
- Docs describe the current state; history goes to `docs/CHANGELOG.md` and
  `docs/SESSION_LOG.md`, not into the specs. `docs/theflow/ROADMAP.md`
  section numbers are cited by code comments — keep them stable.
- `docs/.archive/` is git-ignored and holds retired documents. **Do not read it
  for current behaviour and do not cite it** — most of it describes a design
  that was never built (a Google Sheets config provider, a Rule Engine, tables
  that do not exist). `docs/.archive/README.md` records why each was retired.
  The current configuration is JSON config files plus SQLite.

## Versioning

Every commit bumps the version in `package.json`. Choose the increment by what
the change actually is:

| Increment | Example | When |
|---|---|---|
| **Major** (`1.0.0`) | `4.1.7` -> `5.0.0` | A large body of work is complete, or a long run of minor versions has together closed many problems and added substantial improvements |
| **Minor** (`0.1.0`) | `4.1.7` -> `4.2.0` | New modules, new subsystems, new capabilities |
| **Patch** (`0.0.1`) | `4.1.7` -> `4.1.8` | Hotfixes, documentation updates, cleanups, small changes |

Commit messages in this repo follow the existing style: the version followed by
a short description, for example `v4.1.7 fix telegramsourcelistener`.

## Commits

- **Never commit, never push.** The operator does both. Make the changes,
  including the version bump and the CHANGELOG entry, leave them
  uncommitted, and end the work with the commit message to use, in the style
  below. Never force-push or reset anything on the remote.
- Always bump the version in the same change it describes.
- The default branch is `master`.

## Code conventions

- Node.js ESM (`"type": "module"`), Node 22+.
- Singletons are exported as instances where a single shared instance is
  intended (`EventBus`, `MessageFilter`, `TelegramMessageParser`,
  `telegramClient`).
- All constants and environment variables live in `src/config/app.config.js`.
  Do not read `process.env` elsewhere. Every env var it reads is listed in
  `.env.example`, and nothing else is; every line there is active (never
  `# NAME=`) and holds the code's default — `test/env-example.test.js`
  checks all three. A new tunable gets a default in `app.config.js` and the
  same value, uncommented, in `.env.example`.
- Not configuration, but shared constants: Discord/Telegram API limits in
  `src/shared/platformLimits.js`, time units (`MINUTE`, `HOUR`, `DAY`) in
  `src/shared/time.js`, stored enums (post statuses, verdicts) in
  `src/module/teapot/vocabulary.js`. No `86_400_000` or `4096` in modules.
- **Functional core, imperative shell.** Business decisions are pure
  functions of their arguments (no database, network, config import, clock
  or logger inside) and are tested as functions; classes around them do the
  I/O. A measuring module exports `collect…` (I/O) and `assess…`/`build…`
  (pure). Pure modules import vocabularies, not models.
- Logging goes through `print()` from `src/shared/utils.js`, not `console.*`;
  stacks through `printStack(error)` (debug level, `LOG_LEVEL` filters).
- Source adapters extend `BaseSourceAdapter`, destination adapters extend
  `BaseDestinationAdapter`.
- Modules communicate through `EventBus` when an event handoff is enough,
  rather than calling each other directly; a question that needs an answer
  is `eventBus.request(name)` with a `handle(name)` in the core (`/search`,
  `/daily`). TheFlow and the status board import no platform code — the
  composition root (`src/inemuri.js`) injects adapters and media resolvers.

## Operational cautions

- **Never run with `NODE_ENV=development`.** The sync path uses `force: true`
  and will recreate tables, destroying configured sources. Use `production`.
- The runtime database is `database/pot.sqlite`. `npm run migrate` takes its
  own backup into `database/backups/` before applying anything; still back up
  before any manual schema change.
- **Migrations** live in `database/migrations/` (`NNN-name.js`, each exporting
  `up({ sequelize, queryInterface })`, forward-only). `npm run migrate` applies
  pending ones, `npm run migrate:status` lists applied and pending. Both refuse
  `NODE_ENV=development`. Add a schema change as a new numbered migration with
  explicit `ALTER TABLE` — never `sync({ alter: true })` against a real
  database (SQLite rebuilds the whole table). `database/` is git-ignored except
  `database/migrations/`.
- **Migrations cannot bootstrap an empty database.** `sources` and
  `source_states` predate the migration system and are created by
  `database.sync()`, not by a migration, so `npm run migrate` on an empty file
  fails in `002` (since v4.59.0 it stops with an explanation instead). A fresh
  install runs `npm run setup` (bootstrap, migrate, seed from `sources.json`).
- `.github/workflows/ci.yml` runs lint, bootstrap, migrate and tests on push
  and PR. CI has no `.env`, no `sources.json` and no database, which is
  deliberate: it proves a fresh clone starts on the `*.sample.json` fallbacks.
- Tests are `node --test` suites under `test/` (`*.test.js`, no dependency);
  run with `npm test`, which is `scripts/run-tests.js`: it builds a throwaway
  SQLite database in the OS temp dir (bootstrap + migrate), points
  `SQLITE_STORAGE` at it and runs `node --test --test-concurrency=1`. The
  suites that write to SQLite refuse to run against `database/pot.sqlite`
  (`test/support/testDatabase.js`), so run a single file as
  `npm test -- test/x.test.js`, never bare `node --test`. They cover the pure
  layers (regex stage, schemas, prompts, dedup core, resolve, render,
  parsers, discordapp planner) and, through the throwaway database, the
  stages that read and write SQLite (`*-db.test.js`, dedup, triage,
  knowledge, delivery, the enrich worker). CI runs them on push and PR.
- `.env` holds live secrets and is git-ignored. Never commit it or echo its
  contents.
- **The repository is public.** Deployment data never goes into git:
  `src/config/{sources,routing,cronjob.config,triage}.json`, discordapp server
  configs and texts, channel lists and ids, filters and blacklists, the
  operator's interest profile and example posts (those live in the knowledge
  base, imported from a git-ignored JSONL under `database/`). Each has a
  tracked `*.sample.*` with neutral content; tests, docs and
  `categories.json` examples use neutral or public material. Public outlets
  (NYPost, PsyPost, Reuters) are fine as examples.

## Commands

```bash
npm start            # start the service
npm run seed         # seed sources from src/config/sources.json
npm run seed:fresh   # clear all sources and reseed
npm run migrate      # apply pending schema migrations (backs up first)
npm run migrate:status  # list applied and pending migrations
npm run setup        # new or existing DB: bootstrap + migrate + seed; -- --new, -- --knowledge <f>
npm run db:bootstrap # create missing tables (empty DB only; run BEFORE migrate)
npm run lint         # eslint (flat config, eslint.config.js)
npm test             # node --test suites under test/
node src/cli.js list # list configured sources
node src/cli.js flow stats     # TheFlow corpus stats (per source + total)
node src/cli.js flow export    # sanitized JSONL sample of the corpus
node src/cli.js flow review    # label enriched posts into post_feedback
node src/cli.js flow requeue   # failed (or --status/--model) back to pending
node src/cli.js flow health    # stall/failure check, exit 1 on a problem
node src/cli.js flow dedup     # dedup report; --run, --reset, --pairs n
node src/cli.js flow search <words> [--semantic]  # corpus search (also /search)
node src/cli.js flow preview   # what delivery would send, sends nothing
node src/cli.js flow digest    # the scheduled digest, previewed
node src/cli.js flow knowledge export|import|stats  # portable labels (NEWS_INTAKE.md)
node src/cli.js flow triage stats|review           # headline triage of news sources
node src/cli.js flow preflight # deployment ready? exit 1 on a blocker
```

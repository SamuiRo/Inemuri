# CLAUDE.md

Working notes for Claude Code in this repository.

## What this project is

Inemuri is an event-driven content and data flow manager: it ingests from
configured sources, normalizes into a shared event pipeline, filters, and routes
to destinations. Currently Telegram ingestion, Telegram and Discord delivery,
cron jobs, and Discord server management (discordapp).

Start with [docs/HANDOFF.md](docs/HANDOFF.md) for current state and next
steps, [README.md](README.md) for behavior and configuration, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the repo map and runtime
flow. [docs/CHANGELOG.md](docs/CHANGELOG.md) has the per-version record of
what shipped and why.

## Naming

**Inemuri is the name of the whole system.** Everything else is a part of it.

**TheFlow is a subsystem of Inemuri**, not a separate product or a peer system.
It is the part responsible for producing a stream of validated, categorized,
deduplicated posts. Phase 0 (persistence), Phase 1 (LLM gateway and
enrichment, shadow mode, dormant without a provider key) and Phase 1.5
(vision, off per source by default) are **implemented**, as are Phase 2's
resolve stage and delivery mechanism (off until `FLOW_DELIVERY_ENABLED`),
Phase 3's deduplication tiers 1–2 and the §9.1 history search; the rest is
still specification — see
[docs/THEFLOW.md](docs/THEFLOW.md)
and `docs/theflow/` (in particular `docs/theflow/ROADMAP.md` for exact
per-task status).

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

- **Commit freely, never push.** Pushing is the user's decision.
- Always bump the version in the same commit as the change.
- The default branch is `master`.

## Code conventions

- Node.js ESM (`"type": "module"`), Node 22+.
- Singletons are exported as instances where a single shared instance is
  intended (`EventBus`, `MessageFilter`, `TelegramMessageParser`,
  `telegramClient`).
- All constants and environment variables live in `src/config/app.config.js`.
  Do not read `process.env` elsewhere.
- Logging goes through `print()` from `src/shared/utils.js`, not `console.log`.
- Source adapters extend `BaseSourceAdapter`, destination adapters extend
  `BaseDestinationAdapter`.
- Modules communicate through `EventBus` when an event handoff is enough,
  rather than calling each other directly.

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
  fails in `002`. A fresh install runs `npm run db:bootstrap` first.
- `.github/workflows/ci.yml` runs lint, bootstrap, migrate and tests on push
  and PR. CI has no `.env`, no `sources.json` and no database, which is
  deliberate: it proves a fresh clone starts on the `*.sample.json` fallbacks.
- Tests are `node --test` suites under `test/` (`*.test.js`, no dependency);
  run with `npm test`, which is `scripts/run-tests.js`: it builds a throwaway
  SQLite database in the OS temp dir (bootstrap + migrate), points
  `SQLITE_STORAGE` at it and runs `node --test --test-concurrency=1`. The
  suites that write to SQLite refuse to run against `database/pot.sqlite`
  (`test/support/testDatabase.js`), so run a single file as
  `npm test -- test/x.test.js`, never bare `node --test`. They cover the pure/unit layers —
  `RegexStage`, `FlowIngest` helpers, media resolver, the AI schema/prompt,
  providers, the gateway internals and fallback matrix, the quota ledger and
  the enrich worker, and discordapp. CI runs them on push and PR.
- `.env` holds live secrets and is git-ignored. Never commit it or echo its
  contents.

## Commands

```bash
npm start            # start the service
npm run seed         # seed sources from src/config/sources.json
npm run seed:fresh   # clear all sources and reseed
npm run migrate      # apply pending schema migrations (backs up first)
npm run migrate:status  # list applied and pending migrations
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
```

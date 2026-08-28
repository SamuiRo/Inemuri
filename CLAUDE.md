# CLAUDE.md

Working notes for Claude Code in this repository.

## What this project is

Inemuri is an event-driven content and data flow manager: it ingests from
configured sources, normalizes into a shared event pipeline, filters, and routes
to destinations. Currently Telegram ingestion, Telegram and Discord delivery,
and cron jobs.

Start with [README.md](README.md) for behavior and configuration, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the repo map and runtime flow.

## Naming

**Inemuri is the name of the whole system.** Everything else is a part of it.

**TheFlow is a subsystem of Inemuri**, not a separate product or a peer system.
It is the part responsible for producing a stream of validated, categorized,
deduplicated posts. It is specified but **not implemented** — see
[docs/THEFLOW.md](docs/THEFLOW.md) and `docs/theflow/`.

Never describe TheFlow as standing alongside or on top of Inemuri; it is inside it.

## Documentation

- **All documentation is written in English.** This applies to `README.md`,
  everything under `docs/`, and this file.
- Some older documents in `docs/` are still in Ukrainian
  (`text_replacements.md`, `USE_EMBED.md`, `DETAILED_OPTIMIZATION_EXPLANATION.md`,
  `INEMURI_DOCS.txt`, `description.txt`). They are being migrated; write anything
  new or rewritten in English.
- Code comments in existing files are Ukrainian. Match the surrounding file
  rather than mixing languages within one file.
- Older notes in `docs/` describe a Google Sheets based configuration. That is
  historical; the current implementation is JSON config files plus SQLite.

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
- The runtime database is `database/pot.sqlite`. Back it up before any schema
  change.
- There are **no migrations** in this project. `sequelize.sync()` without
  `alter` will not add columns to existing tables; adding one needs a one-off
  `sync({ alter: true })` or a manual `ALTER TABLE`.
- There are no tests and no CI. `npm test` is a placeholder that exits 1.
- `.env` holds live secrets and is git-ignored. Never commit it or echo its
  contents.

## Commands

```bash
npm start            # start the service
npm run seed         # seed sources from src/config/Sources.json
npm run seed:fresh   # clear all sources and reseed
node src/cli.js list # list configured sources
```

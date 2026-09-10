# Deployment

Inemuri runs as a single Node process under **pm2** on a VPS. This document is
the deploy and schema-migration procedure. It is written for the TheFlow
phase 0.5 rollout (ROADMAP §2.3) but applies to every deploy after it.

> A migration that runs *after* the new code has started is a runtime failure
> in the ingest path — the one place that must never stop. The order below is
> not negotiable.

## Prerequisites

- Node.js 22+ on the VPS.
- pm2 installed globally (`npm i -g pm2`).
- The repository checked out at a fixed path — call it `$APP_ROOT`
  (e.g. `/opt/inemuri`). Set it once in
  [`ecosystem.config.cjs`](../ecosystem.config.cjs) → `cwd`.
- A populated `.env` in `$APP_ROOT` (never committed — see `.env.example`).
- The current runtime `database/pot.sqlite` in place.

## First install

```bash
cd $APP_ROOT
git clone <repo> .            # or unpack the checkout
npm ci
cp .env.example .env && $EDITOR .env      # fill in real values
npm run migrate:status                    # should list 001..NNN as pending
npm run migrate                           # creates the schema (takes a backup first)
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup                    # bring it back after a reboot
pm2 logs inemuri --lines 100
```

On a brand-new database `database.sync()` (run on boot) already creates every
table at its latest shape; `npm run migrate` then runs the idempotent
migrations and just records them. On the current VPS database (pre-TheFlow)
migration `001` **creates** the TheFlow schema.

## Every subsequent deploy

```bash
cd $APP_ROOT

# 1. Stop first. See "Why stop before migrating" below.
pm2 stop inemuri

# 2. Back up the database off-box as well as in database/backups/.
cp database/pot.sqlite ~/pot.sqlite.$(date +%F)

# 3. Deploy code.
git pull
npm ci

# 4. Inspect, then apply migrations.
npm run migrate:status        # what is pending?
npm run migrate               # applies pending, one backup per run

# 5. Start and watch.
pm2 start inemuri             # or: pm2 start ecosystem.config.cjs
pm2 logs inemuri --lines 100
```

Then **verify classic forwarding works before switching any source to flow
mode** — send a message through a known classic source and confirm it lands in
its destination.

## Why stop before migrating

Two failure modes otherwise, both nasty:

- the running process holds the SQLite file while `ALTER TABLE` runs;
- pm2 restarts on crash — so a process that fails against a half-applied
  schema restarts into the same failure in a loop, spamming the log and
  hammering Telegram reconnects.

`npm run migrate` refuses to run under `NODE_ENV=development` (that path uses
`sync({ force: true })` and recreates tables). Keep `NODE_ENV=production` in
the environment and in `ecosystem.config.cjs`.

## Rollback

Migrations are **forward-only**. To roll back:

```bash
pm2 stop inemuri
cp ~/pot.sqlite.<date> database/pot.sqlite     # restore the pre-deploy backup
git checkout <previous-tag>
npm ci
pm2 start inemuri
```

`database/backups/` also holds a `pot.sqlite.<timestamp>.pre-migrate` copy
taken automatically at the start of each `npm run migrate` run.

## pm2 notes

- The config file is [`ecosystem.config.cjs`](../ecosystem.config.cjs) —
  `.cjs`, because the project is `"type": "module"` and pm2 loads a
  `.js` ecosystem file as CommonJS.
- `cwd` must be `$APP_ROOT`: `dotenv` resolves `.env` relative to
  `process.cwd()`. Starting from the wrong directory gives a process with no
  credentials and no obvious reason why.
- `instances: 1`, `exec_mode: "fork"` are load-bearing from phase 1 onward:
  pm2 cluster mode would start a second process — and, once the enrichment
  worker exists, a second worker that silently doubles every AI call
  (ROADMAP §13.1).
- Useful: `pm2 logs inemuri`, `pm2 restart inemuri`, `pm2 describe inemuri`.

## Checklist

- [ ] `pm2 stop inemuri` before touching the schema
- [ ] database backed up off-box
- [ ] `npm ci` (not `npm install`) — lockfile-exact
- [ ] `npm run migrate:status` inspected, then `npm run migrate`
- [ ] `pm2 start inemuri`, logs clean
- [ ] classic forwarding verified before any `flow.enabled` change
- [ ] `pm2 save` if the process list changed

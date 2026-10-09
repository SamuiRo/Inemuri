# Deployment

Inemuri runs as a single Node process under **pm2** on a VPS. This document is
the install, deploy and schema-migration procedure.

> A migration that runs *after* the new code has started is a runtime failure
> in the ingest path — the one place that must never stop. The order below is
> not negotiable.

## Prerequisites

- Node.js 22+ on the VPS.
- pm2 installed globally (`npm i -g pm2`).
- The repository checked out at a fixed path — call it `$APP_ROOT`.
  [`ecosystem.config.cjs`](../ecosystem.config.cjs) runs the app from the
  directory it lives in (`cwd: __dirname`), so there is nothing to set; run
  every `npm run …` and `node …` command from `$APP_ROOT` too.
- A populated `.env` in `$APP_ROOT` (never committed — see `.env.example`).

## First install

```bash
cd $APP_ROOT
git clone <repo> .            # or unpack the checkout
npm ci
cp .env.example .env && $EDITOR .env      # fill in real values
# copy the git-ignored configs (sources.json, routing.json, triage.json, …) — see below
npm run setup                             # schema, migrations, sources from sources.json
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup                    # bring it back after a reboot
pm2 logs inemuri --lines 100
```

`npm run setup` builds the database from the configs: `db:bootstrap` (the
tables older than migrations), `migrate`, `seed` from `sources.json`, and
`flow knowledge import <file>` with `-- --knowledge <file>`; then it prints
`flow preflight`. It refuses without `src/config/sources.json` (seed would
take the sample). On an existing database every step is safe to repeat;
`npm run setup -- --new` starts from an empty database and moves the old one
to `database/backups/pot.sqlite.<time>.pre-setup` — nothing is deleted.

A new database means: no TheFlow corpus and labels unless imported, no
provisioning state (the next apply adopts everything and posts the managed
messages again — PROVISIONING.md), and polling starts from now for every
source. `npm run migrate` alone on an empty database stops and says so.

## What `git pull` does not bring

The repository is public, so every piece of deployment data is git-ignored
and has to be on the server by other means — copied over (`scp`), or edited
there. A missing one falls back to its `*.sample.json` with a `[CONFIG]`
warning, which is how a server quietly ends up running on example values.

| File | Holds | Without it |
|---|---|---|
| `.env` | Telegram session, API keys (`GEMINI_API_KEY`), `DISCORD_USER_TOKEN` of the Discord reading account, switches | Nothing starts, TheFlow stays dormant, or discord sources are not started |
| `src/config/sources.json` | Every source: channels, filters, `flow`, news sources with `feed` | Seed has nothing real to import |
| `src/config/routing.json` | `unsorted_destinations`, `routing` rules, `health_destinations`, `digest_destinations`, `status_destinations` | Verdicts, alerts and the status board go to the sample's ids, which do not exist — `flow preflight` blocks |
| `src/config/triage.json` | The reader profile for headline triage | Triage judges against the sample profile |
| `src/config/cronjob.config.json` | Cron job destinations | The daily report goes to the sample's ids — Discord answers `Unknown Channel` — and `flow preflight` blocks |
| `src/config/discordapp/servers/*.json`, `messages/**` | discordapp server configs and texts | `/provision` has nothing to apply |
| A knowledge JSONL (`database/knowledge/*.jsonl`) | The operator's labelled examples | Triage and few-shot start without examples |

After copying, `npm run seed` imports `sources.json` (it adds and updates,
never deletes — a source that exists only in the database keeps running),
and `node src/cli.js flow knowledge import <file>` loads the examples
(repeating it changes nothing).

**Check it all with one command:** `node src/cli.js flow preflight` —
environment, migrations, keys, the triage profile, sources, routing,
delivery state and the knowledge base. It exits 1 on a blocker, so run it
before `pm2 start`.

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

# 5. Deployment data that changed (see "What git pull does not bring").
npm run seed                  # if sources.json changed
node src/cli.js flow preflight   # must say "Ready"

# 6. Start and watch.
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

## Turning on TheFlow features

Each switch is independent; do them in this order on a new deployment.

**Enrichment (shadow mode).** `.env`: `GEMINI_API_KEY` set,
`FLOW_DELIVERY_ENABLED` absent or `false`. `routing.json`:
`health_destinations` set, so a stall or failure reaches you. Flip
`flow.enabled` on the sources, `npm run seed`, restart. Verdicts are written,
nothing is sent; read them with `flow stats` and `flow review`.

**News sources with headline triage.** Copy `src/config/triage.json` and the
news entries of `sources.json` (`"platform": "rss"`,
`"feed": { …, "triage": true }`, `"flow": { "enabled": true }`); import the
knowledge JSONL (`flow knowledge import <file>`); `npm run seed`; restart. In
the log: `[FEEDS] polling N feed source(s)`, a `baseline` line per source (the
first poll ingests nothing old), then `[TRIAGE] … decided, … passed`. Quota:
roughly 90 triage calls a day for ten outlets, out of the 500 a day the
complete model allows, shared with enrichment.

**A Discord server for the channels.** Provision it (PROVISIONING.md): give
the bot Administrator and a role above the roles it manages,
`node scripts/discordapp.js check <guildId> <config>`, `apply … --yes`, then
`check` again — the plan must come back empty. On an instance that never
provisioned this server, every managed message is posted again: delete the
old copies by hand. `node scripts/discordapp.js ids <guildId>` prints the ids
to put into `routing.json` in place of any `TODO:<key>` placeholders.

**Delivery.** `flow preflight` → Ready (it fails while a placeholder is left),
then `flow preview --ignore-age --limit 10` to see what would go where. Set
`FLOW_DELIVERY_ENABLED=true` only when every rule points at a channel you are
happy to see filled; restart. Posts older than 24 h are never sent. With
`status_destinations` set, the status board posts about a minute after the
start.

## When migrate says "No sources table"

`npm run migrate` found a database without the tables Inemuri creates on its
first start. It stops before changing anything and prints the path. The
database lives in `<working directory>/database/pot.sqlite`, so:

1. Find the database the service was using:
   `pm2 describe inemuri` (look at `exec cwd`) or
   `find / -name pot.sqlite -not -path "*/backups/*" 2>/dev/null`.
2. If it is in another directory: stop the service, copy that file to
   `database/pot.sqlite` here (or run everything from that directory), then
   `npm run migrate`. Start the service with `pm2 start ecosystem.config.cjs`
   from that directory, so pm2 and the commands use the same database.
3. Or start clean: `npm run setup -- --new` builds a new database from the
   configs (see First install). For a deployment that never ran TheFlow the
   old database holds only sources, which `sources.json` recreates, and
   polling positions, which simply start from now.

The empty file the failed run created can be deleted; its "backup" under
`database/backups/` is empty too.

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
- `cwd` is the checkout the file lives in (`__dirname`): `dotenv` resolves
  `.env` and the database path relative to `process.cwd()`. A process
  started elsewhere would get no credentials or a new empty database. A pm2
  app created before `v4.59.2` with another `cwd` keeps it until
  `pm2 delete inemuri && pm2 start ecosystem.config.cjs && pm2 save`.
- `instances: 1`, `exec_mode: "fork"` are load-bearing: pm2 cluster mode
  would start a second process — a second Telegram session and a second
  enrich worker that silently doubles every AI call (ROADMAP §13.1).
- Useful: `pm2 logs inemuri`, `pm2 restart inemuri`, `pm2 describe inemuri`.

## Checklist

- [ ] `pm2 stop inemuri` before touching the schema
- [ ] database backed up off-box
- [ ] `npm ci` (not `npm install`) — lockfile-exact
- [ ] `npm run migrate:status` inspected, then `npm run migrate`
- [ ] git-ignored configs copied or updated; `npm run seed` if sources changed
- [ ] `node src/cli.js flow preflight` says Ready
- [ ] `pm2 start inemuri`, logs clean
- [ ] classic forwarding verified before any `flow.enabled` change
- [ ] `pm2 save` if the process list changed

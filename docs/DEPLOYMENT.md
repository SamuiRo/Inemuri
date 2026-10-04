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

## What `git pull` does not bring

The repository is public, so every piece of deployment data is git-ignored
and has to be on the server by other means — copied over (`scp`), or edited
there. A missing one falls back to its `*.sample.json` with a `[CONFIG]`
warning, which is how a server quietly ends up running on example values.

| File | Holds | Without it |
|---|---|---|
| `.env` | Telegram session, API keys (`GEMINI_API_KEY`), switches | Nothing starts, or TheFlow stays dormant |
| `src/config/sources.json` | Every source: channels, filters, `flow`, news sources with `feed` | Seed has nothing real to import |
| `src/config/routing.json` | `unsorted_destinations`, `routing` rules, `health_destinations`, `digest_destinations`, `status_destinations` | No alerts, no status board; verdicts route to sample ids |
| `src/config/triage.json` | The reader profile for headline triage | Triage judges against the sample profile |
| `src/config/cronjob.config.json` | Cron job destinations | Cron jobs post nowhere |
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

## Turning on news intake in shadow mode

The first deploy of TheFlow phase 6 (news sources with headline triage,
v4.52–v4.56). On top of the steps above:

1. `.env`: `GEMINI_API_KEY` set; `FLOW_DELIVERY_ENABLED` absent or `false` —
   that *is* shadow mode. Triage knobs are in `.env.example`
   (`FLOW_TRIAGE_*`); the defaults are meant to be kept.
2. Copy `src/config/triage.json` and the news entries of `sources.json`
   (each `"platform": "rss"`, `"feed": { …, "triage": true }`,
   `"flow": { "enabled": true }`); `npm run seed`.
3. `routing.json`: `health_destinations` set, so a stall or failure reaches
   you; no `digest_destinations` while in shadow mode.
4. Copy the knowledge JSONL; `node src/cli.js flow knowledge import <file>`.
5. `node src/cli.js flow preflight` → Ready; `pm2 start inemuri`.
6. In the log: `[FEEDS] polling N feed source(s)`, then a `baseline` line per
   source (the first poll only records what exists — nothing old is
   ingested), then from the next polls `[TRIAGE] … decided, … passed`.
7. Daily: `node src/cli.js flow triage stats` and `flow triage review`.

Quota: triage asks the model at most once per full batch of 50 headlines or
once per 20 minutes for a partial one — roughly 90 calls a day for ten
outlets, out of the 500 a day `gemini-3.5-flash-lite` allows, shared with
enrich.

## Turning on delivery to test channels and the status board

`v4.58.0` adds routing by source (`when.source`), shared channels (`also`)
and the status board. A first deploy that also provisions a Discord server
with a different bot than the one that provisioned it before:

1. `npm run migrate` (service stopped) — `018` adds `source_states.last_seen_at`
   and `status_messages`.
2. Copy `routing.json` with its rules. Channels that do not exist yet carry
   `TODO:<key>` placeholders.
3. Provision the server (docs/PROVISIONING.md): give the bot Administrator and
   a role above the roles it manages, `node scripts/discordapp.js check <guildId> <config>`,
   then `apply … --yes`, then `check` again — it must come back empty.
4. Delete the old copies of the provisioned texts and role panels by hand: on
   a new instance every managed message is posted again (PROVISIONING.md).
5. `node scripts/discordapp.js ids <guildId>` and replace every `TODO:<key>`
   in `routing.json` with its id.
6. `node src/cli.js flow preflight` → Ready (it fails while a placeholder is
   left), then `node src/cli.js flow preview --ignore-age --limit 10`.
7. `FLOW_DELIVERY_ENABLED=true` only when every rule points at a channel you
   are happy to see filled; start. The status board posts about a minute
   after the start.

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
- [ ] git-ignored configs copied or updated; `npm run seed` if sources changed
- [ ] `node src/cli.js flow preflight` says Ready
- [ ] `pm2 start inemuri`, logs clean
- [ ] classic forwarding verified before any `flow.enabled` change
- [ ] `pm2 save` if the process list changed

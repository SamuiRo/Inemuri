> **Role:** Current state and next steps · **Audience:** Anyone starting a session on this project, human or AI

## Current state

`v4.38.1`. TheFlow Phase 0 (persistence, no AI), Phase 1 (LLM gateway and
enrichment, shadow mode) and Phase 1.5 (vision) are **implemented**, and
Phase 2's resolve stage (§5.2) is built and waiting on destination channels.
10 migrations exist (`database/migrations/001`–`010`); `npm run migrate:status`
is clean on the dev database. `npm test` is 385 green `node --test` cases
(`--test-concurrency=1` — some suites touch the real SQLite file). See
[CHANGELOG.md](CHANGELOG.md) for the version-by-version detail and
[theflow/ROADMAP.md](theflow/ROADMAP.md) for the full per-task status (every
finished task there carries a `> **Done (vX.Y.Z).**` note).

**The pilot is configured but has not run yet.** On the dev copy, three
sources are flow-enabled in the git-ignored `sources.json` — one of them with
`flow.vision.enabled`, two with `filters.reject_shouty` — and a Gemini key is
in `.env`, so `EnrichWorker` starts on the next boot. Nothing has flowed
through the pipeline: `posts`, `post_feedback` and `provider_quota` are still
empty, and **a running process will not pick the change up** — source config
is read at startup. Until that restart, and a first pass of
`node src/cli.js flow stats`, treat "implemented" as "the code exists and its
units pass", not as "it works against a live provider".

Phase 1 is still **dormant without a key**: `src/module/theflow/EnrichWorker.js`
starts only when `ENRICH_WORKER_ENABLED` and
`LLM_PROVIDERS[LLM_PRIMARY].apiKey` are both set
(`src/config/app.config.js`); without one, flow-enabled sources ingest into
`posts` as `pending` and nothing else happens. Classic (non-TheFlow)
forwarding is untouched throughout — except on a source that is itself
flow-enabled, which stops forwarding by design (see
[README.md](../README.md#enabling-a-source-into-theflow)).

The dev copy's database and its own live `sources.json` (14 sources, 3
flow-enabled) are git-ignored — only what is under `database/migrations/` is
version-controlled. Channel names and ids are deployment data and are kept out
of `docs/` entirely.

`SourceBuilder.html` (the source-config editor, opened straight from the
filesystem — no build step) covers the whole source shape as of `v4.14.0`,
`flow` and `vision` included. Enabling the pilot is: import the live
`src/config/sources.json`, switch the chosen sources on, export, reseed.

**discordapp** — Discord server management inside Inemuri — is specified in
[DISCORDAPP.md](DISCORDAPP.md); its work plan table at the end records
per-step status. Steps 1–4 are done: Discord delivery is REST-only, so a
Discord outage no longer stops the process, discordapp starts last with its
own login retry (`v4.31.0`), `/export-chats` exists (`v4.32.0`), and so do
`/provision plan` (`v4.33.0`), `/provision apply` (`v4.34.0`), and provisioned
messages with role panels (`v4.35.0`). **Provisioning has been run against a
real server** (the operator's test server, `v4.36.0`): create, adopt, archive,
edit-in-place and restore all worked and left an empty plan. Not yet exercised
live: slash commands and buttons inside Discord (the service has not been
restarted with the server in `DISCORD_GUILD_IDS`), and `/export-chats`.

## Documentation

Everything under `docs/` is English. Four superseded Ukrainian documents were
retired on 2026-09-12 into `docs/.archive/`, which is git-ignored — they are on
disk for reference and out of the repository. `docs/.archive/README.md` records
why each one went. **Do not cite them:** three describe a design that was never
built (a Google Sheets config provider, a Rule Engine, tables that do not
exist). All four are now closed out: `USE_EMBED.md` was rebuilt from the code as
[media.md](media.md) in `v4.19.0`, and nothing in the archive is pending.

## Configuration layout

Deployment-specific config is git-ignored and read through
`src/config/localConfig.js`, which falls back to the matching `*.sample.json`:

| Local (ignored) | Sample (tracked) | Holds |
|---|---|---|
| `sources.json` | `sources.sample.json` | Per-source channels, filters, replacements, `flow`, `poll_interval_min` |
| `routing.json` | `routing.sample.json` | `unsorted_destinations` and the phase 2 `routing` rules |
| `cronjob.config.json` | `cronjob.config.sample.json` | Cron job destinations |

`categories.json` is **tracked** and holds taxonomy only — topics, signals,
dedup windows. No channel ids live in it.

A missing local file falls back to its sample with a `[CONFIG]` warning; a
**malformed** one throws instead, because silently running on sample
destinations is worse than not starting. A fresh clone now starts — before
`v4.17.0` it could not, since the ignored files were statically imported.

## Next steps

0. **discordapp first boot (`v4.31.0`).** Before restarting: make sure
   `DISCORD_COMMAND_WHITELIST` holds your user id — an empty list now refuses
   admin commands, `/daily` included — and optionally set `DISCORD_GUILD_IDS`.
   On boot the log should show the Discord adapter connecting "(REST)",
   `discordapp started`, stale global commands removed once, and commands
   registered per server. A server that says "could not register commands"
   needs the bot re-invited with the `applications.commands` scope. Then
   `/daily` should answer ephemerally and still deliver the report. Before
   trying `/export-chats`, switch on the **Message Content** intent in the
   Developer Portal; start with a small `limit` on one server. For
   provisioning: `npm run migrate` (migration `009`), copy
   `src/config/discordapp/servers/example.sample.json` to `<name>.json`, set
   `guildId`, and run `/provision plan` — it changes nothing. Try
   `/provision apply` first on a **test server**, with the bot temporarily
   holding a role with Administrator. Bot setup (portal, invite link, role
   placement): [DISCORDAPP.md § Setup](DISCORDAPP.md#setup). Run
   `npm run migrate` **before** starting the new version — done on the dev
   copy on 2026-09-29 (backup in `database/backups/`). On the test server,
   the config's `mentions` AutoMod rule fails until Discord's own *Block
   Mention Spam* is deleted by hand — the bot cannot edit or delete it. The
   DISCORDAPP.md work plan is complete; what remains is running the slash
   commands and buttons live (restart with the server in
   `DISCORD_GUILD_IDS`) and deciding what discordapp does next.
1. **Gemini is configured.** `GEMINI_API_KEY` is set, and the free-tier
   limits read from AI Studio are the defaults since `v4.30.0` —
   `gemini-3.5-flash-lite` (RPD 500 / RPM 15) and `gemini-embedding-2`
   (RPD 1000 / RPM 100), counted per model. Nothing further is required.
   Daily capacity is roughly **250–500 posts**: a text post costs one
   flash-lite and one embedding call, a post that needs vision costs two
   flash-lite calls. A backlog drains quickly and then waits for Pacific
   midnight. Optional: an OpenRouter fallback (`OPENROUTER_API_KEY` plus a
   model supporting `json_schema` output); leave `OPENROUTER_EMBED_MODEL` empty.
2. **Restart the service and watch the first day.** The pilot config is in
   place but only takes effect on boot. After a restart the log must show
   `Starting TheFlow enrichment worker...`; then
   `node src/cli.js flow stats` for the per-source split (how much is
   `skipped_*` versus `enriched`) and `node src/cli.js flow review` to label
   verdicts into `post_feedback`. A week of that labelling is Phase 1's exit
   gate.
3. **Operator steps for Phase 0.5's tail:** run `scripts/estimate-volume.js`
   against the live session; deploy to the VPS per
   [DEPLOYMENT.md](DEPLOYMENT.md) — on an empty database run
   `npm run db:bootstrap` before `npm run migrate`.
4. **Create the destination channels** (ROADMAP §5.1), `#unsorted` at least.
   Resolve (§5.2) is built and waiting on them.
5. **Vision stays per source.** `flow.vision.enabled` belongs where
   `flow stats` shows a high "has_media & len<200" share — a channel posting
   code screenshots is the intended case — and **not** on meme-heavy ones,
   where OCR of a meme is noise. Where it is off the stage costs nothing: the
   gate refuses before any download.
6. **The plan now needs real enriched posts.** The §5.4 message template is
   deliberately designed against real material, and routing waits on §5.1.

## Open questions

- Why has the stale polling source's checkpoint not advanced since
  2026-05-01 — dead channel, or broken polling? (`S3` in ROADMAP §1.2, §11)
- The VPS app-root path, needed to finish `ecosystem.config.cjs` for real.
- The new destination channels for Phase 2, and which existing channel (if
  any) is the screenshot-heavy one Phase 1.5's vision gate should target
  first.

## Session log

### 2026-09-29

- Designed discordapp with the operator and wrote [DISCORDAPP.md](DISCORDAPP.md)
  (`v4.30.2`). Settled: same process behind an `EventBus` boundary rather than a
  separate bot process; private bot on several of the operator's servers;
  export defaults to Markdown; provisioning never deletes — removed channels
  go to a private archive category; everything ephemeral; business logic as
  pure functions.
- Built step 1 (`v4.31.0`): REST-only Discord delivery, `DiscordGateway`,
  `DiscordApp` + `CommandRegistry`. Verified by tests and lint only.
- Built step 2 (`v4.32.0`): `/export-chats`. Also tests and lint only; the
  collector was exercised against a fake guild, not a real one.
- Built step 3 (`v4.33.0`): configs, validator, planner, `/provision plan`.
  The operator settled on no deletion at all: a channel leaving the config
  goes to a mandatory private archive category.
- Built step 4 (`v4.34.0`): the applier and `/provision apply`. Verified
  end-to-end against an in-memory server, not a real one.
- Built step 5 (`v4.35.0`): messages, role panels, opt-in groups. The operator
  offered a test server; its setup is written down in DISCORDAPP.md § Setup.
- Added `scripts/discordapp.js` (`v4.36.0`) and ran provisioning on the test
  server with the git-ignored `servers/test.json` (the sample with its
  guildId) — see CHANGELOG 4.36.0 "Verified". Applied migrations 009–010 to
  the dev database for it.
- Built step 6 (`v4.37.0`): AutoMod. The live run found that Discord's own
  default rules cannot be edited by a bot (404); handled, see CHANGELOG.
- Built step 7 (`v4.38.0`): `/provision export`. The live round trip found
  three bugs the in-memory tests could not (state keys, neutral overwrites,
  unknown permission bits); all fixed and covered by tests.

### 2026-09-13

- Live free-tier limits overturned two provider defaults (`v4.30.0`): the
  complete/vision model moved to a flash-lite one after the previous default
  turned out to allow 20 requests a day, and the quota ledger became per
  model rather than per provider.
- Enabled the pilot in the git-ignored `sources.json`: three sources
  flow-enabled, vision on the one that posts code screenshots, `reject_shouty`
  on the two whose ritual posts it targets. Applied with `npm run seed`.
- **`npm run seed` matches on `platform` + `channel_id`, so the same channel
  written as `@username` when the database row holds its numeric id is
  imported as a second source** — the channel would then be polled twice.
  Caught with `node src/cli.js list`; the duplicate row was deleted (it had no
  posts and no checkpoint) and the config aligned to the numeric id.
- Seeding also overwrites `destinations` from the file, so a source whose
  destinations live only in the database loses them on the next reseed. The
  pilot's were copied into the config before reseeding.
- Scrubbed channel names and ids out of `docs/` (`v4.30.1`); the plan refers
  to sources by shape and by the `S1`–`S8` labels defined in ROADMAP §1.2.

### 2026-09-10

- Built out all of TheFlow Phase 0.5 (`v4.3.1`–`v4.9.1`): the volume-estimate
  script, a hand-rolled migration runner, the multi-platform schema
  generalization, the media-resolver seam, delivery-identity/editMessage/
  post_feedback plumbing, a `node --test` harness, `flow stats`/`flow export`,
  and the pm2 deployment doc.
- Built all of TheFlow Phase 1's buildable scope (`v4.10.0`–`v4.13.0`):
  `categories.json` v1, the enrich schema and prompt, the provider layer and
  persistent quota ledger, `LLMGateway`, `EnrichWorker` (wired in but
  dormant), and `flow review`. End-to-end verified with a fake provider
  against the real database.
- Added this file and [CHANGELOG.md](CHANGELOG.md); corrected the "TheFlow is
  specified but not implemented" line in `CLAUDE.md`, `README.md`, and
  `THEFLOW.md`, which had gone stale.

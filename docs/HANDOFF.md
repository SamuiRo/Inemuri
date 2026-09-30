> **Role:** Current state and next steps · **Audience:** Anyone starting a session on this project, human or AI

## Current state

`v4.50.0`. TheFlow Phase 0 (persistence, no AI), Phase 1 (LLM gateway and
enrichment, shadow mode) and Phase 1.5 (vision) are **implemented**, Phase 2's resolve stage (§5.2) is
built and waiting on destination channels, and Phase 3's deduplication tiers 1
and 2 run in the enrich worker, with the delta call and updates to delivered
messages (§6.6); threshold calibration (§6.8) is open. History search (§9.1) is built: `/search` in
discordapp and `flow search` on the CLI. Phase 3.5 is built: Reddit and
RSS/Atom sources through `src/sources/feeds/` (Reddit needs OAuth
credentials in practice — see Next steps). Phase 4 (entity extraction) is
built: enrich prompt version 2. The delivery mechanism (§5.3–5.6) is
built and **off** (`FLOW_DELIVERY_ENABLED=false`) until the §5.1 channels and
the final template exist. 14 migrations exist
(`database/migrations/001`–`014`); `npm run migrate:status`
is clean on the dev database. `npm test` is 517 green `node --test` cases,
run on a throwaway database since `v4.43.1` — never on `database/pot.sqlite`.
See
[CHANGELOG.md](CHANGELOG.md) for the version-by-version detail and
[theflow/ROADMAP.md](theflow/ROADMAP.md) for the full per-task status (every
finished task there carries a `> **Done (vX.Y.Z).**` note).

**The pilot's first day produced no real verdict — fixed in `v4.43.1`.** On
the dev copy three sources are flow-enabled in the git-ignored `sources.json`
(one of them producing posts so far) and a Gemini key is in `.env`. Reading
`flow stats` on 2026-09-30 found two bugs, not data:

- every real Gemini enrich call returned HTTP 400 on the response schema
  (52 posts `failed`, 337 requests spent);
- `npm test`, run while the pilot ingested, claimed real pending posts and
  wrote the fake provider's verdicts into them — all 135 `enriched` rows are
  `model_used = fake-model`, and 30 `failed` ones are its `provider down`.

Both are fixed (CHANGELOG 4.43.1), and the corrupted rows were requeued with
the service stopped (backup `database/backups/*.pre-requeue`): the dev
database now holds 217 `pending` posts waiting for the next start. `flow
review` must wait until they are re-enriched — before that it would have
nothing real to label.

Since `v4.44.0` the service watches itself (ROADMAP §13.10): failing
enrichment, a queue that stops draining, and silent ingest raise an alert to
`health_destinations` in `routing.json`. **That key is not set in the dev
`routing.json` yet**, so alerts only reach the log until it is.

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

**discordapp** — Discord server management inside Inemuri — is **complete and
in production** (`v4.30.2`–`v4.42.3`). On 2026-09-30 provisioning rebranded
the operator's main server end to end (86 changes, history kept, a clean plan
afterwards); that run added `adopt` by id, multi-embed texts with links and
personas, and fixed the plan fingerprint and the exclusive role panel. The
server's config and texts are git-ignored, like all deployment data. How to run
a server with it: [PROVISIONING.md](PROVISIONING.md). [DISCORDAPP.md](DISCORDAPP.md)
holds the design, the setup, every feature contract, and a *Status and known
limitations* section with what it deliberately does not do. Discord delivery is
REST-only, so a Discord outage no longer stops the process. Provisioning was
run against the operator's test server, and the operator exercised the slash
commands and buttons there. The one piece not yet run live is `/export-chats`
delivering to Telegram (`DISCORD_EXPORT_TELEGRAM_CHAT`).

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
| `discordapp/servers/<name>.json` | `discordapp/servers/example.sample.json` | discordapp server configs (read per command, no fallback) |
| `discordapp/messages/*.md` | `discordapp/messages/*.sample.md` | Texts of provisioned messages |

`categories.json` is **tracked** and holds taxonomy only — topics, signals,
dedup windows. No channel ids live in it.

A missing local file falls back to its sample with a `[CONFIG]` warning; a
**malformed** one throws instead, because silently running on sample
destinations is worse than not starting. A fresh clone now starts — before
`v4.17.0` it could not, since the ignored files were statically imported.

## Next steps

- **Re-extract the pilot's verdicts with prompt 2** when convenient:
  `node src/cli.js flow requeue --status enriched --prompt-below 2` (102
  posts, one day of quota). Their dedup decisions stay as they are.

- **Adding a news or Reddit source** is a `sources.json` entry
  (`"platform": "rss"`, `channel_id` = feed URL; or `"platform": "reddit"`,
  `channel_id` = `r/name`) and `npm run seed` — README § Feed sources.
  **Reddit needs `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`** (a "script"
  app at reddit.com/prefs/apps): from the dev machine Reddit answered 403 to
  every unauthenticated request. The OAuth path has not run live yet.

0. **discordapp is closed.** Operational notes that outlive the build:
   bot setup is in [DISCORDAPP.md § Setup](DISCORDAPP.md#setup);
   `node scripts/discordapp.js check <guildId>` verifies it from a terminal;
   `/provision apply` needs the bot to hold Administrator for the duration.
   On the test server, `servers/test.json` has `archiveUnmanaged: true`, so
   every apply there archives whatever was made by hand, and its `mentions`
   AutoMod rule fails until Discord's own *Block Mention Spam* is deleted by
   hand. `.env` defines `DISCORD_COMMAND_WHITELIST` twice; only the first line
   counts. Open for a live run: `/export-chats` with
   `DISCORD_EXPORT_TELEGRAM_CHAT` set.
1. **Start the service and let the 217 requeued posts drain.** They fit one
   day of free-tier quota (~15 min at RPM 15). Add `health_destinations` (a
   Telegram chat) to the git-ignored `routing.json` first, so a repeat of the
   pilot's failure reaches you. Then `node src/cli.js flow health` and
   `flow stats` — `model_used` must now be the Gemini model — and only then
   `flow review`.
2. **Gemini is configured.** `GEMINI_API_KEY` is set, and the free-tier
   limits read from AI Studio are the defaults since `v4.30.0` —
   `gemini-3.5-flash-lite` (RPD 500 / RPM 15) and `gemini-embedding-2`
   (RPD 1000 / RPM 100), counted per model. Nothing further is required.
   Daily capacity is roughly **250–500 posts**: a text post costs one
   flash-lite and one embedding call, a post that needs vision costs two
   flash-lite calls. A backlog drains quickly and then waits for Pacific
   midnight. Optional: an OpenRouter fallback (`OPENROUTER_API_KEY` plus a
   model supporting `json_schema` output); leave `OPENROUTER_EMBED_MODEL` empty.
3. **Watch the first real day.** The pilot config is in
   place but only takes effect on boot. After a restart the log must show
   `Starting TheFlow enrichment worker...`; then
   `node src/cli.js flow stats` for the per-source split (how much is
   `skipped_*` versus `enriched`) and `node src/cli.js flow review` to label
   verdicts into `post_feedback`. A week of that labelling is Phase 1's exit
   gate.
4. **Operator steps for Phase 0.5's tail:** run `scripts/estimate-volume.js`
   against the live session; deploy to the VPS per
   [DEPLOYMENT.md](DEPLOYMENT.md) — on an empty database run
   `npm run db:bootstrap` before `npm run migrate`.
5. **Create the destination channels** (ROADMAP §5.1), `#unsorted` at least,
   and `security`. Resolve and delivery are built and waiting on them. Then:
   put them in `routing.json` (`unsorted_destinations` off the firehose,
   `routing` rules), design the template with
   `node src/cli.js flow preview --ignore-age --limit 10` (the wording is the
   `TEMPLATE` object in `src/module/theflow/delivery/render.js`), and only
   then `FLOW_DELIVERY_ENABLED=true`. Posts older than 24 h are never sent.
6. **Vision stays per source.** `flow.vision.enabled` belongs where
   `flow stats` shows a high "has_media & len<200" share — a channel posting
   code screenshots is the intended case — and **not** on meme-heavy ones,
   where OCR of a meme is noise. Where it is off the stage costs nothing: the
   gate refuses before any download.
7. **Deduplication needs cross-source posts to calibrate.** All flow posts so
   far come from one source. Once the others produce, `node src/cli.js flow
   dedup --pairs 30` shows the pairs around HIGH/LOW; judge them, set
   `DEDUP_HIGH`/`DEDUP_LOW`, then `flow dedup --reset --run` (only while nothing
   is delivered).
8. **The plan now needs real enriched posts.** The §5.4 message template is
   deliberately designed against real material, and routing waits on §5.1.

## Open questions

- Why has the stale polling source's checkpoint not advanced since
  2026-05-01 — dead channel, or broken polling? (`S3` in ROADMAP §1.2, §11)
- The VPS app-root path, needed to finish `ecosystem.config.cjs` for real.
- The new destination channels for Phase 2, and which existing channel (if
  any) is the screenshot-heavy one Phase 1.5's vision gate should target
  first.
- Taxonomy v2: esports results currently fall into `other` — a topic of their
  own, or part of `steam`? (ROADMAP §3 checkpoint)

## Session log

### 2026-09-30 — phase 4

- Operator: phase 4 and onwards in ROADMAP order.
- Built entity extraction (`v4.50.0`): links, amounts, events, anchored
  dates, prompt version 2, tier-1 "ticker + date", the event line in
  `render()`, `flow requeue --prompt-below`. Two live Gemini calls on real
  posts: both dates correct and anchored, nothing discarded.

### 2026-09-30 — phase 3.5

- Built Reddit and RSS/Atom sources (`v4.49.0`, migration `014` applied to
  the dev database — `posts.message_id` dropped). Live, read-only: a Steam
  news RSS feed parsed correctly; Reddit returned 403 for `.json` and `.rss`,
  so app-only OAuth was added. Found and fixed on the way: flow delivery
  handed adapters media without bytes (`buffer` vs `data`), and a Reddit
  title-only post would have been `skipped_empty`.

### 2026-09-30 — §6.6

- Operator: calibration, channels and templates come last; build what does
  not depend on them — §6.6, then phase 3.5.
- Built §6.6 (`v4.48.0`): delta prompt and `LLMGateway.delta()`,
  `DeltaStage`, updates in `FlowDelivery` (edit with the cap, corrections as
  edit + reply, fallback reply, canonical rewrite), `editMessageData()` on
  both adapters. Found and fixed on the way: a Telegram album's identity was
  `null`, `replyTo` was dropped, a Discord edit would have lost the image. One
  live delta call returned a correct `corrects`.

### 2026-09-30 — delivery mechanism

- Built §5.3–5.6 (`v4.47.0`, migration `013` applied to the dev database):
  pure `render()` with a draft template, `FlowDelivery` over the unchanged
  `MessageRouter`, `flow preview`. Off by default; history never sent.
  Previewed on real posts: 17 Telegram entities kept, Discord Markdown kept,
  `security` red, `#unsorted` diagnostics. Not sent anywhere live — there is
  no destination channel yet.

### 2026-09-30 — history search

- Built §9.1 (`v4.46.0`, migration `012` applied to the dev database): FTS5
  keyword search and semantic search, `/search` and `flow search`, and a
  request/reply on the EventBus so discordapp asks the core without importing
  it. Tried on the real corpus: keyword and Cyrillic work; a first 30-day
  default window made semantic search find nothing on a corpus of old channel
  history, so there is no default window now. A Russian query finds English
  `text_en`.
- Noticed for the taxonomy checkpoint: esports posts (a Major's daily results)
  land in `other`, since no topic covers them.

### 2026-09-30 — deduplication

- Operator chose option 1 for §6.1: `skipped_repost` is now per source.
- Built tiers 1 and 2, the cluster lifecycle, the richness gate and the
  decision log (`v4.45.0`, migration `011`, applied to the dev database).
- Ran it on the 102 real verdicts: HIGH 0.90 merged nine same-channel pairs,
  all wrong (template series). Tier 2 now skips the post's own source; rerun
  gives 102 events, max same-source `s` 0.955. Cross-source calibration waits
  for the other two flow sources to produce posts.

### 2026-09-30 — first real enrichment run

- The operator started the service: 102 real verdicts from
  `gemini-3.5-flash-lite`, every one with a `gemini-embedding-2` vector, mean
  confidence 0.91. Then Gemini was marked exhausted at 117/500 and one post
  failed on `circuit open`. Four gateway bugs behind it, fixed in `v4.44.1`
  (per-minute 429 read as daily quota, 2×RPM burst, ignored `retryDelay`, gate
  refusals burning attempts). The false `exhausted_at` for the day was cleared
  and the one failed post requeued, service stopped.

### 2026-09-30 — TheFlow pilot review

- Read `flow stats` for the first time. The pilot had no real verdicts: the
  Gemini response schema was rejected on every call, and the enrich-worker
  test had been writing fake verdicts into real pending posts. Fixed both,
  added `flow requeue`, and moved `npm test` onto a throwaway database
  (`v4.43.1`). One live Gemini call verified the fix.
- With the service stopped by the operator, requeued the 217 corrupted rows
  (135 fake `enriched`, 82 `failed`) after a backup.
- Built the health monitor, ROADMAP §13.10 (`v4.44.0`). The first design keyed
  a stall on the age of the oldest `pending` post; running it against the
  requeued corpus showed that would alert on every healthy drain of an old
  backlog, so a stall now also requires no progress for as long. Verified the
  alert path monitor → EventBus → MessageRouter → adapter with a fake adapter.

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
- After the operator's testing: fewer requests (`v4.38.1`), exports to disk
  and Telegram instead of Discord (`v4.39.0`), `archiveUnmanaged` (`v4.40.0`,
  applied on the test server), archived/hidden listed apart (`v4.40.1`).
- Reviewed the whole slice for bugs before closing it: no critical issue
  found. Brought DISCORDAPP.md and this file up to date and closed discordapp
  (`v4.40.2`).

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

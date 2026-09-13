> **Role:** Current state and next steps · **Audience:** Anyone starting a session on this project, human or AI

## Current state

`v4.25.0`. TheFlow Phase 0 (persistence, no AI) and Phase 1 (LLM gateway and
enrichment, shadow mode) are both **implemented in code, and have never yet
run on real data** — the corpus is empty, no source is flow-enabled, and no
provider key is set. Phase 1 is **dormant**:
`src/module/theflow/EnrichWorker.js` only starts when a primary provider API
key is set in `.env` (`ENRICH_WORKER_ENABLED` + `LLM_PROVIDERS[LLM_PRIMARY].apiKey`
in `src/config/app.config.js`); without one, flow-enabled sources ingest into
`posts` as `pending` and nothing else happens. Classic (non-TheFlow) forwarding
is untouched throughout. 5 migrations exist (`database/migrations/001`–`005`);
`npm run migrate:status` is clean on the dev database. `npm test` is 184 green
`node --test` cases (`--test-concurrency=1` — some suites touch the real
SQLite file). See [CHANGELOG.md](CHANGELOG.md) for the version-by-version
detail and [theflow/ROADMAP.md](theflow/ROADMAP.md) for the full per-task
status (every finished task there carries a `> **Done (vX.Y.Z).**` note).

The dev copy's database and its own live `src/config/sources.json` (14
sources, none yet flow-enabled) are git-ignored — only what's under
`database/migrations/` is version-controlled.

Audited against the code on 2026-09-11: all five migrations are applied on the
dev database, `npm test` is 119 green, and every `Done` note in
[theflow/ROADMAP.md](theflow/ROADMAP.md) matches what is actually in the tree.
What the docs cannot show is that `posts`, `post_feedback` and `provider_quota`
are all **empty** — nothing has flowed through the pipeline yet. Treat "Phase 1
implemented" as "the code exists and its units pass", not as "it works against
a live provider"; the first real run is still ahead and is what the next steps
below are for.

`SourceBuilder.html` (the source-config editor, opened straight from the
filesystem — no build step) covers the whole source shape as of `v4.14.0`,
`flow` and `vision` included. Enabling the pilot is: import the live
`src/config/sources.json`, switch the chosen sources on, export, reseed.

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

1. **Fill in `.env` for the provider decision** (ROADMAP §3.1, decided
   `v4.25.0`: Gemini primary, OpenRouter text-only fallback). `.env.example`
   carries the block. Two values cannot be defaulted and need you:
   - **`GEMINI_RPD` / `GEMINI_RPM`** — Google does not publish free-tier
     limits; read them for your project at `aistudio.google.com/rate-limit`.
   - **`OPENROUTER_COMPLETE_MODEL`** — must support structured output
     (`response_format: json_schema`); check the model page first.

   Leave `OPENROUTER_EMBED_MODEL` empty — see §3.1 for why.
2. **Operator steps for Phase 0.5's tail:** run `scripts/estimate-volume.js`
   against the live session; deploy to the VPS per
   [DEPLOYMENT.md](DEPLOYMENT.md) — on an empty database run
   `npm run db:bootstrap` before `npm run migrate`; enable `flow.enabled` on the
   pilot sources.
3. **Create the destination channels** (ROADMAP §5.1), `#unsorted` at least.
   Resolve (§5.2) is built and waiting on them.
4. **Next buildable work: Phase 1.5 (vision)** — unblocked by the provider
   decision. After that the plan needs real enriched posts: the §5.4 message
   template is deliberately designed against real material.

## Open questions

- Why has the `Source M` source's polling checkpoint not advanced since
  2026-05-01 — dead channel, or broken polling? (ROADMAP §1.2, §11)
- The VPS app-root path, needed to finish `ecosystem.config.cjs` for real.
- The new destination channels for Phase 2, and which existing channel (if
  any) is the screenshot-heavy one Phase 1.5's vision gate should target
  first.

## Session log

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

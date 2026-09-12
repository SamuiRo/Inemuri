> **Role:** Current state and next steps · **Audience:** Anyone starting a session on this project, human or AI

## Current state

`v4.15.0`. TheFlow Phase 0 (persistence, no AI) and Phase 1 (LLM gateway and
enrichment, shadow mode) are both **implemented in code, and have never yet
run on real data** — the corpus is empty, no source is flow-enabled, and no
provider key is set. Phase 1 is **dormant**:
`src/module/theflow/EnrichWorker.js` only starts when a primary provider API
key is set in `.env` (`ENRICH_WORKER_ENABLED` + `LLM_PROVIDERS[LLM_PRIMARY].apiKey`
in `src/config/app.config.js`); without one, flow-enabled sources ingest into
`posts` as `pending` and nothing else happens. Classic (non-TheFlow) forwarding
is untouched throughout. 5 migrations exist (`database/migrations/001`–`005`);
`npm run migrate:status` is clean on the dev database. `npm test` is 80 green
`node --test` cases (`--test-concurrency=1` — some suites touch the real
SQLite file). See [CHANGELOG.md](CHANGELOG.md) for the version-by-version
detail and [theflow/ROADMAP.md](theflow/ROADMAP.md) for the full per-task
status (every finished task there carries a `> **Done (vX.Y.Z).**` note).

The dev copy's database and its own live `src/config/sources.json` (14
sources, none yet flow-enabled) are git-ignored — only what's under
`database/migrations/` is version-controlled.

Audited against the code on 2026-09-11: all five migrations are applied on the
dev database, `npm test` is 92 green, and every `Done` note in
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

## Known documentation debt

Three Ukrainian documents under `docs/` are not just untranslated, they are
wrong, and `CLAUDE.md` points new sessions at them:

- `INEMURI_DOCS.txt` and `description.txt` describe a system that was never
  built — a Google Sheets config provider, a Rule Engine, and tables
  `messages` / `deliveries` / `sources_config` / `routing_rules` (the real
  ones are `sources`, `source_states`, `posts`, `clusters`, `post_feedback`,
  `provider_quota`, `schema_migrations`). They also use a different project
  name. Deleting them and dropping the links loses nothing that
  `ARCHITECTURE.md` does not already say correctly, in English.
- `USE_EMBED.md` points at code that has moved: `parseMedia()` now lives in
  `TelegramMessageParser`, and the listener's `downloadableMediaTypes` is now
  `DOWNLOADABLE_MEDIA_TYPES` in `app.config.js`. It needs rewriting against
  the current structure, not translating.

`DETAILED_OPTIMIZATION_EXPLANATION.md` is a retrospective and still accurate;
it is a candidate for `docs/archive/`.

`src/config/categories.json` is tracked by git and carries real channel ids in
`unsorted_destinations`. It mixes taxonomy (shared, tests depend on it) with
routing targets (deployment-specific). The repo already has the pattern for
the latter — `sources.sample.json` tracked, `sources.json` ignored — so the
two belong apart. Touching it affects phase 2 routing, so it is a decision,
not a cleanup.

## Next steps

1. **Provider decisions (ROADMAP §11, §3.1)** — pick the Gemini and
   OpenRouter model ids, confirm whether the OpenRouter account exposes
   `/embeddings` (leave `OPENROUTER_EMBED_MODEL` empty if not — `embed()`
   degrades to a single provider, dedup degrades to tier 1, both already
   handled), pick a vision provider, and measure RPD/RPM per model id
   against `scripts/estimate-volume.js`'s output. Then fill in `.env` from
   `.env.example`'s `LLM_*` / `GEMINI_*` / `OPENROUTER_*` block.
2. **Operator steps for Phase 0.5's tail:** run `scripts/estimate-volume.js`
   against the live Telegram session; deploy the current code to the VPS
   per [DEPLOYMENT.md](DEPLOYMENT.md) and run `npm run migrate` there; strip
   the copy-pasted no-op text replacements from the live `sources.json` (the
   committed `Sources.sample.json` is already clean — v4.9.0) and its VPS
   copy; enable the pilot sources from ROADMAP §2.9 (not `Source M` until its
   stale checkpoint is explained).
3. **Once the worker has run for a while:** the Phase 1 checkpoint — read
   everything landing in `other`/low confidence through
   `node src/cli.js flow review`, rewrite `categories.json`, bump its
   `version` to `2`. Exit gate for enabling routing is "verdicts you agree
   with often enough", not a fixed number of days.
4. **Next phase of work:** Phase 2 (content-based routing) needs the new
   destination channels from ROADMAP §11 first (including `#unsorted` and a
   `security` channel — today everything still goes to one firehose chat).
   Phase 1.5 (vision) can start independently once a vision provider is
   chosen in step 1.

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

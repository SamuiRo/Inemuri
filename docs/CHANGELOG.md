> **Role:** Per-version record of what shipped and why · **Audience:** Anyone deciding whether a change affects them, or tracing when a behavior changed

This changelog starts at `v4.3.1`. Earlier versions (`v1.0.0` through `v4.3.0`)
predate it — see `git log` for that history, and
[docs/theflow/ROADMAP.md](theflow/ROADMAP.md) §0–1 for the state TheFlow was
in going into `v4.3.1`. Versioning rule: every commit bumps `package.json`
(patch = docs/tests/cleanup, minor = new capability, major = a large body of
work closes out) — see `CLAUDE.md` § Versioning.

## [4.18.1] - 2026-09-12

### Fixed
- **The `4.17.0` fresh-clone fallback did not actually work on Linux.** Git
  tracked the file as `src/config/Sources.sample.json` while
  `loadLocalConfig("sources", …)` asks for `sources.sample.json`. Windows and
  macOS ignore filename case, so it resolved here and the new test suite passed;
  the VPS is Linux, where a fresh clone would have found neither
  `sources.json` (git-ignored) nor `sources.sample.json` (named with a capital
  S) and started with an empty source list.

  The sample is renamed to lowercase, and every reference across `README.md`,
  `CLAUDE.md`, `ARCHITECTURE.md`, `THEFLOW.md`, `ROADMAP.md` and the seeder's
  comments now matches. The redundant `/src/config/Sources.json` line is gone
  from `.gitignore`. The historical `CHANGELOG` entry for `4.9.0` keeps the old
  spelling, which was correct at the time.

  Added a test that reads the directory listing and checks exact filenames, so
  a case mismatch fails on a case-insensitive filesystem too — parsing the file
  through the loader cannot catch this class of bug on Windows.

## [4.18.0] - 2026-09-12

Polling cadence is now per source.

### Added
- `sources.poll_interval_min` (migration `006`, plain `ADD COLUMN`, no table
  rebuild). `NULL` means "use the global `POLLING_INTERVAL_MIN`", so every
  existing row behaves exactly as before and no backfill was needed.
  `Source.getPollIntervalMin(globalDefault)` reads it, treating zero, negative
  and non-numeric as `NULL` — a zero interval would mean "due every tick".
- `POLLING_TICK_MS` (30s), `POLLING_MAX_PER_TICK` (8) and
  `POLLING_MAX_DRAIN_PAGES` (5), all optional. They use a new
  `optionalNumber()` which, unlike `positiveNumber()`, stays silent when the
  variable is simply unset: warning about every unconfigured knob with a
  working default trains an operator to stop reading startup warnings.
- `poll_interval_min` in `SourceBuilder.html`, next to `Mode` and disabled for
  `listener` sources, where polling does not happen. Verified in-browser: a
  mixed config round-trips byte-identically, `null` never reaches the file, and
  zero, negative and non-numeric input is refused rather than written.
- `test/polling-schedule.test.js` — 19 cases over the interval getter, the
  phase offset, due selection, rescheduling, the cycle, and drain paging.

### Changed
- **The scheduler polls only what is due**, on one timer rather than one per
  source. Keeping a single serialized cycle is the point: independent
  per-source timers would let several channels fire together, which is the
  failure mode `POLLING_CHANNEL_DELAY_MS` exists to prevent.

  Three properties make a mixed set of intervals safe:
  - *A deterministic phase offset per source*, derived from its id. Sources
    sharing an interval would otherwise stay synchronized forever — six
    channels set to daily would fire in the same second every day. Deriving it
    from the id rather than randomly means the schedule survives a restart.
  - *A ceiling per tick.* When everything comes due at once — a restart, or a
    long `FLOOD_WAIT` — one tick stays bounded and the rest slips to the next.
    The most overdue source goes first, so a short-interval channel cannot
    starve one that has been waiting since an earlier tick.
  - *Page-by-page catch-up in `_pollChannel`*, capped at
    `POLLING_MAX_DRAIN_PAGES`. This one is not optional: a channel polled daily
    with `POLLING_FETCH_LIMIT` at 50 collects 50 messages per tick while more
    than that arrives per day, so without paging a long interval would fall
    permanently behind. The cap keeps a single tick bounded, and the checkpoint
    means the next one resumes rather than restarting.
- A source that has vanished from the caches is dropped from the schedule
  instead of staying due forever and consuming a slot under the per-tick cap.
- `SourceSeeder` threads `poll_interval_min` through, normalizing anything
  non-positive to `NULL`.
- `docs/theflow/ROADMAP.md` §2.9's all-polling advice still holds, and the
  reason a quiet channel was polled 288 times a day is now configurable.

## [4.17.0] - 2026-09-12

Deployment-specific configuration now lives outside the repository, and a
fresh clone starts.

### Fixed
- **A fresh clone could not start at all.** `sources.json` and
  `cronjob.config.json` are git-ignored — correctly, since every deployment
  has its own channels — but they were pulled in with
  `import ... with { type: "json" }`. Module resolution failed before a single
  line of logic ran, and the error named a file the reader had no reason to
  expect. Both now load through `src/config/localConfig.js`.

### Added
- `src/config/localConfig.js`. A local config is read from
  `src/config/<name>.json`; if it is absent, the tracked `<name>.sample.json`
  is used and a line is recorded in `CONFIG_WARNINGS`.

  A **malformed** local file throws rather than falling back. The distinction
  is deliberate: silently substituting the sample means starting the system
  with somebody else's destinations, which is worse than refusing to start.
- `src/config/routing.sample.json`, and `routing.json` added to `.gitignore`.
- `test/local-config.test.js` — 7 cases: local wins over sample, absent falls
  back loudly, neither falls back to defaults, malformed local throws,
  malformed sample throws, every shipped sample parses, and the routing sample
  carries only placeholder ids.

### Changed
- **`categories.json` no longer carries routing.** It held
  `unsorted_destinations` with a deployment's real Telegram and Discord ids
  while being tracked by git — one operator's channels shipped to everyone,
  in a file whose other half (topics, signals, dedup windows) is genuinely
  shared and which the tests depend on. The two halves are now apart:
  taxonomy stays in `categories.json`, `unsorted_destinations` and `routing`
  move to `routing.json`, exported as `ROUTING`. Nothing in `src/` read those
  two keys yet — phase 2 will — so the split is free to make now and would
  not have been later.
- `docs/theflow/ROADMAP.md` no longer prints those ids either.

## [4.16.0] - 2026-09-12

### Removed
- Four superseded Ukrainian documents left the repository into the new
  git-ignored `docs/.archive/`: `INEMURI_DOCS.txt`, `description.txt`,
  `USE_EMBED.md` and `DETAILED_OPTIMIZATION_EXPLANATION.md`. They are still on
  disk for reference; they are no longer part of the project.

  Translating them was rejected. Three are not merely old but wrong — they
  describe a Google Sheets config provider, a Rule Engine, and tables
  `messages` / `deliveries` / `sources_config` / `routing_rules` that do not
  exist — and a translated wrong document is worse than none, because it reads
  as current. `CLAUDE.md` was pointing new sessions straight at them.

  `docs/.archive/README.md` records what each one claimed and why it went, so
  the reasoning survives the deletion. `USE_EMBED.md` is flagged there as the
  one worth rewriting rather than discarding: its `DiscordDestination` details
  are still accurate.

### Changed
- `docs/` is now English-only, with no migration backlog. `CLAUDE.md` says so
  and tells future sessions not to read or cite `docs/.archive/`.
- Inbound links repaired rather than dropped. `README.md`'s embed section now
  names the two places that actually decide media behaviour
  (`DOWNLOADABLE_MEDIA_TYPES` in `app.config.js`, `supportedMediaTypes` /
  `canEmbed` in `DiscordDestination.js`) instead of pointing at a retired file,
  and its document index lists `HANDOFF.md` and `CHANGELOG.md`, which were
  missing. `ARCHITECTURE.md`'s directory tree matches what `docs/` now holds.
- `docs/HANDOFF.md` replaces its "Known documentation debt" section with the
  outcome. One item stays open: `categories.json` is tracked while carrying
  real channel ids, mixing shared taxonomy with deployment-specific routing.

## [4.15.1] - 2026-09-12

### Changed
- `docs/HANDOFF.md` brought up to date and given a "Known documentation debt"
  section: which Ukrainian documents are merely untranslated versus actively
  wrong, and the note that `categories.json` is tracked while carrying real
  channel ids. A new session reads this file first, so findings that were
  only in a conversation now survive the session.

## [4.15.0] - 2026-09-12

Two ways the polling loop could walk into a Telegram flood ban, both closed
before the pending VPS deploy rather than after it.

### Fixed
- **A missing env var turned polling into an unthrottled request loop.**
  `POLLING_INTERVAL_MS` was `Number(process.env.POLLING_INTERVAL_MIN) * 60 *
  1000` with no fallback, so an unset variable produced `NaN` — and
  `setTimeout(fn, NaN)` coerces to `0` and fires immediately. A deployment
  whose `.env` lacked the line would hammer `getMessages` across every
  channel with no pause and be rate-limited within seconds. The VPS `.env`
  has never been inspected, so this was live risk on the next deploy.
  `POLLING_FETCH_LIMIT` had the same shape.

  Both now go through `positiveNumber()`, which falls back (5 minutes, 50
  messages) on an unset, empty, non-numeric, zero or negative value. Silence
  is what made the original bug invisible, so each fallback records a line in
  `CONFIG_WARNINGS`, printed by `src/inemuri.js` as `[CONFIG] …` before
  anything starts.

- **A `FLOOD_WAIT` moved on to the next channel.** Telegram's limits apply to
  the *account*, not the channel, so continuing the cycle meant issuing more
  requests on an account already being rate-limited — which can extend the
  penalty. The handler logged the error and carried on to the next channel.

  `TelegramSourceListener.floodWaitSeconds()` now recognises the error, the
  cycle aborts, and the next one is scheduled `seconds + 5s` out instead of
  at the normal interval. GramJS still absorbs anything under its 60-second
  `floodSleepThreshold` transparently, so only longer waits reach this path.
  A `seconds` field alone is not treated as proof — the error must also look
  like a flood — because an unrelated error carrying that field would
  otherwise stall polling for no reason.

### Changed
- `_scheduleNextPoll(delayMs)` takes a delay; `_runPollingCycle()` returns the
  backoff to apply, or `null` for business as usual. `isPolling` moved into a
  `finally` so an early return cannot strand it.
- `POLLING_INTERVAL_MIN` and `POLLING_FETCH_LIMIT` are optional in
  `.env.example`, with the defaults documented.

### Added
- `test/polling-backoff.test.js` — 10 cases over `positiveNumber()`,
  `floodWaitSeconds()` and the cycle itself: a flood aborts and returns the
  backoff, an ordinary error skips one channel and continues, a clean cycle
  returns none, and overlapping cycles are refused. The listener is driven
  with a fake `_pollChannel`, so no network or database is involved.

## [4.14.4] - 2026-09-12

### Changed
- `categories.json`: `freebie` no longer covers temporary access. It read
  "Something is given away free or at a steep discount", which put a free
  weekend, a trial and a permanent giveaway in one bucket — an operator
  reviewing real posts flagged exactly that conflation. `freebie` now means
  something that **stays yours after claiming**; time-boxed access goes to
  `event`, whose description now says so, since a free weekend already fits
  its "start, deadline, active window" shape. No new signal was needed.

  `version` stays `1` deliberately. The rule in ROADMAP §"Phase 1 checkpoint"
  is to bump it so older verdicts stay interpretable — there are no verdicts
  yet, so there is nothing to keep interpretable and editing v1 in place is
  correct. The bump to `2` still belongs at the checkpoint.

## [4.14.3] - 2026-09-12

### Changed
- `docs/text_replacements.md` rewritten in English. It is the detailed
  reference `README.md` points at twice, so it was the Ukrainian document
  with the most readers. Every API it documents was re-checked against the
  code first — `compileReplacements`, `preprocessText`, `checkMessageFast`,
  `checkMessageDetailed`, `clearCache`, `getCacheStats`,
  `Source.preprocessText`, `Source.passesFilter` all still exist and behave
  as described.

  Corrections made while translating, rather than carried over:
  - The "database migration" section said a new field lands automatically via
    `database.sync()`. That contradicts the migration discipline in
    `CLAUDE.md`: `sync({ alter: true })` rebuilds the whole table in SQLite.
    It now says configuration needs no migration and a schema change is a
    numbered migration.
  - Added what the old text left implicit: supplying `flags` implies
    `is_regex`; an invalid regex is logged and dropped while the other
    patterns still run; `is_regex: false` uses `String.replaceAll()`;
    backslashes must be doubled in JSON.
  - Added the TheFlow interaction, which did not exist when the document was
    written: `posts.raw_text` stores text *after* replacements, so it is what
    the model sees and what verbatim validation checks against — and
    stripping URLs also strips them from `candidates.urls`.
  - Added a reaction-footer pattern as a worked example, including why it
    requires two consecutive lines.

## [4.14.2] - 2026-09-12

### Fixed
- Test fixtures and comments in `4.14.1` carried real promo codes and a real
  post from an operator's private channel. Channel-specific data does not
  belong in a repository where every deployment has its own sources: the
  per-source config (`src/config/sources.json`) is git-ignored for exactly
  that reason, and the fixtures had quietly worked around it. Replaced with
  synthetic codes of the same shape, so the tests exercise the rule rather
  than one operator's data. No behaviour change.

## [4.14.1] - 2026-09-12

### Fixed
- `RegexStage.extractCandidates()` silently dropped letter-only promo codes.
  The filter required a token to contain **both** a digit and a letter, so
  a code with no digit in it — a form several game issuers use — produced no
  candidate at all. A post listing three such codes surfaced only two.
  A token is now promo-like if it has a digit and a letter (as before) **or**
  is 10+ letters with no digit.

  The 10-character floor is where the trade-off sits: short shouty words
  (`STEAM`, `CSGO`, `GIVEAWAY`) stay out, long English ones
  (`ANNOUNCEMENT`, `CONGRATULATIONS`) now get in. That is acceptable by the
  stage's own contract — candidates are a hint the model confirms, never a
  decision, so a false candidate costs tokens while a missed code costs the
  code. Cyrillic never matched `[A-Z]` to begin with. Measured against a
  sample of real posts: zero false positives, three recovered codes.

  Two regression tests added; both fail against the previous filter.

## [4.14.0] - 2026-09-11

### Added
- `SourceBuilder.html` — a **TheFlow section** per source, so enabling the
  pilot (ROADMAP §2.9) no longer requires hand-editing `sources.json`:
  `enabled`, `topics` (chips over the five `categories.json` v1 topics; none
  selected = `null` = all), `min_confidence`, `dedup_window_hours` (empty =
  `null` = inherit from the category), and the `vision` sub-object
  (`enabled`, `text_threshold`, `max_images_per_post`). A `flow` / `flow +
  vision` badge on the collapsed card header shows which sources are on
  without expanding them.
- Two notices the editor can state and a JSON file cannot. In **Filters**,
  when flow is on: keywords (whitelist) are ignored for flow sources, only
  the blacklist applies. In **TheFlow**: phase 1 is shadow mode, so the
  source stops forwarding classically and its `destinations` go unused; and
  the vision toggle is phase 1.5, not yet implemented.

### Fixed
- The platform dropdown offered `twitter`, `slack` and `reddit`, which
  `SourceSeeder.validateSource()` rejects — the failure only surfaced at
  `npm run seed`. It now offers `telegram` and `discord` only. A source
  imported with some other platform keeps its value verbatim (nothing is
  silently rewritten) and is shown in the dropdown labelled
  `— rejected by seeder`.

### Notes
- A `flow` block that is untouched default is omitted from the output, so
  classic sources stay exactly as clean as they were. Verified by round trip:
  importing a mixed file and exporting it returns a classic source
  byte-identical and an enabled `flow` block unchanged.

## [4.13.2] - 2026-09-11

An audit of every TheFlow `Done` claim against the tree. The claims held; three
things around them did not.

### Removed
- `LLM_SHADOW_MODE` from `src/config/app.config.js` and `.env.example`. It was
  exported, documented as a settable env var, and **read by nothing** — a
  switch an operator could flip expecting routing to change, with no reader on
  the other end. In phase 1 shadow mode is structural, not configurable: the
  worker writes verdicts and no consumer of them exists. The flag comes back
  with the routing consumer in phase 2, when it will actually gate something.

### Fixed
- `docs/theflow/ROADMAP.md` §3.6 said the worker is wired behind
  `LLM_SHADOW_MODE`; the real gate is `ENRICH_WORKER_ENABLED` plus a primary
  provider API key. (§3.6's `Done` note already said so — the spec text above
  it did not.)
- §3.2 (provider layer) was the one finished task with no `> **Done (vX.Y.Z).**`
  note, which read as "not started" next to its neighbours. It shipped in
  `v4.11.0`; the note now records what is in the tree, including
  `classifyHttpError()`'s 429 split and the injectable axios seam the test
  suites depend on.
- `docs/HANDOFF.md` claimed `v4.13.0` while `package.json` said `4.13.1`.
- `docs/ARCHITECTURE.md` and `docs/theflow/LLM_GATEWAY.md` both still described
  the flag — `LLM_GATEWAY.md` §Configuration was in fact where it was specified
  in the first place, so it now records why phase 1 deliberately has none.

### Added
- ROADMAP §2.9 now records that `SourceBuilder.html` has no `flow` UI (it does
  preserve an existing `flow` block on round trip, and its platform dropdown
  offers three values the seeder rejects), so the pilot is a hand edit of
  `sources.json` until that is closed.
- HANDOFF now states plainly that Phase 0.5 and Phase 1 are implemented **but
  have never run on real data** — `posts`, `post_feedback` and `provider_quota`
  are empty. "Implemented" was true and kept being read as "working".

## [4.13.0] - 2026-09-10

### Added
- `node src/cli.js flow review [--limit n] [--topic t]` — walks `enriched`
  posts with no `post_feedback` row, shows the verdict, takes a one-key label
  (`g` good / `n` noise / `w` wrong_topic + optional note / `s` skip / `q`
  quit) into `post_feedback`. Input via readline's async iterator, so
  `flow review < answers.txt` works too. (ROADMAP §3.7 — closes Phase 1's
  buildable scope.)

## [4.12.0] - 2026-09-10

### Added
- `src/services/ai/LLMGateway.js` + `internal.js` (`TokenBucket`,
  `CircuitBreaker`, `TtlCache`): `enrich()` / `embed()` behind a 3-lane
  priority queue with a concurrency cap. Capability routing over
  `[LLM_PRIMARY, LLM_FALLBACK]`, a per-provider RPM bucket, the persistent RPD
  ledger, a per-provider circuit breaker (opens on the first server/network
  failure, half-opens after a cool-off), a cache keyed on normalized input
  plus taxonomy version, the full fallback matrix from `LLM_GATEWAY.md`
  (`rate_limit` retries the same provider; `quota` marks it exhausted and
  moves on; `server`/`network` trips the breaker; `bad_response` retries once
  then moves on), tiering kept distinct from fallback, and priority shedding
  near the quota reserve (`{ shed: true }`, never `failed`). `embed()` returns
  `null` when no provider advertises the capability — dedup degrades to tier 1.
- `src/module/theflow/EnrichWorker.js`: a chained `setTimeout` tick (batches
  cannot overlap), `Post.claimPending()` bumping `attempts` in one statement
  before the gateway call (ROADMAP §13.1 — no `enriching` status, a crash
  mid-call still counts toward the retry cap), `enrich()` → `embed()` →
  `UPDATE ... status='enriched'` with `model_used`, `taxonomy_version`, and the
  embedding BLOB. A shed response leaves the post `pending`; a gateway error
  retries up to `ENRICH_MAX_ATTEMPTS` then marks `failed` with `last_error`. A
  missing embedding still yields `enriched`. Imports only `posts` and config —
  no Telegram/Discord/event-bus dependency.
- Wired into `src/inemuri.js` behind `ENRICH_WORKER_ENABLED` and a primary
  provider API key; dormant (no-op) without one. `.env.example` documents the
  `LLM_*` variables.

### Changed
- `npm test` now runs `node --test --test-concurrency=1` — DB-backed suites
  hit the one SQLite file and were racing under the runner's default
  parallelism.

## [4.11.0] - 2026-09-10

### Added
- `app.config.js`: `LLM_*` gateway constants and `LLM_PROVIDERS` (per-provider
  key/model-ids/base URL/RPD/RPM, read from env — Gemini has working
  defaults, OpenRouter's model ids are `null` until chosen).
- Migration `005-provider-quota` + `ProviderQuota` model: a persistent
  per-`(provider, day_utc)` request counter with `exhausted_at`, so the LLM
  gateway's daily-quota accounting survives a process restart.
- `src/services/ai/providers/`: `BaseProvider` (the `complete()` /
  `embed()` / `vision()` contract, `capabilities()` derived from config, and
  HTTP error classification into `rate_limit` / `quota` / `server` /
  `network`), `GeminiProvider` (Generative Language API, structured output,
  unit-normalized embeddings), `OpenAICompatProvider` (base-URL parameterized
  chat-completions + embeddings, covering OpenRouter and similar APIs;
  `embed()` throws when no embed model is configured — the OpenRouter case
  from §3.1).

## [4.10.0] - 2026-09-10

### Added
- `src/config/categories.json` v1 — the TheFlow taxonomy drafted against the
  real 14 sources (ROADMAP appendix A): topics `steam / airdrop / crypto /
  tools / other`, 11 signals including `security` / `giveaway_result` /
  `stream`, `routing: []` with `unsorted_destinations` pointing at the current
  single firehose (the correct shadow-mode configuration). Exposed as
  `CATEGORIES` from `app.config.js`.
- `src/services/ai/schemas.js` — `enrichResponseSchema()` for provider
  structured output, `validateStructural()` (closed-enum `topic` /
  `signal_type`, typed fields), `validateVerbatim()` (strips promo codes and
  tickers not present in `raw_text`; deliberately leaves `entities.project`
  alone — see the note below).
- `src/services/ai/prompts/enrich.js` — `buildEnrichPrompt()`: taxonomy
  descriptions injected into the system prompt, `text_en` produced first,
  `temperature: 0`, and the source text (plus OCR text, once that exists)
  wrapped in a per-call nonced `<<<UNTRUSTED …>>>` block the model is told to
  treat as data, never instructions.

### Fixed
- `docs/theflow/TAXONOMY.md`'s example JSON put `dedup_window_hours` on each
  **topic**; `DEDUPLICATION.md`'s table keys it by **signal** (a `promo_code`
  is stale in hours regardless of topic, `analysis` in days). The shipped
  `categories.json` follows `DEDUPLICATION.md`; `TAXONOMY.md` now says so
  explicitly instead of silently disagreeing with the real file.

### Note
- Verbatim validation only strips literal quotes — `extracted.promo_codes[].code`
  and `entities.tickers[]`. `entities.project` is intentionally not checked:
  a project name is legitimately transliterated or translated away from the
  source spelling, and rejecting a real one would cost more than an
  occasional wrong one the reader sees in context.

## [4.9.1] - 2026-09-10

### Added
- `docs/DEPLOYMENT.md` and `ecosystem.config.cjs` for the pm2 VPS deploy
  (ROADMAP §2.3). The actual deploy is an operator step, not automated here.

## [4.9.0] - 2026-09-10

### Added
- `node src/cli.js flow stats` — per-source and total corpus stats: status
  histogram, `skipped_repost` share, `raw_text` length distribution, the
  `has_media && length(raw_text) < 200` vision-candidate share, and how often
  each `candidates.*` list is non-empty, with samples.
- `node src/cli.js flow export [--out f] [--limit n] [--status a,b]` —
  sanitized JSONL sample (no `channel_id` / `message_id` / `external_id` /
  `media_ref` / `entities`) for local prompt work.

### Fixed
- `caseSensitive` is now threaded `MessageFilter → FlowIngest →
  RegexStage.evaluate()`. Previously `RegexStage` always lowercased its
  blacklist comparison, so a source with `filters.case_sensitive: true` had a
  blacklist that silently stopped matching (latent — every source currently
  has `case_sensitive: false`, so nothing broke in production, but the bug
  was live).
- `Sources.sample.json` stripped of the copy-pasted `[Sponsored]…`/`@techchannel`
  no-op replacement pair and an empty-pattern replacement — junk config that
  was propagating into every new source built from the sample.

## [4.8.0] - 2026-09-10

### Added
- A real test harness: `npm test` runs `node --test` (bare discovery of
  `test/*.test.js`, no new dependency). Initial suites cover `RegexStage`
  (the four rejection paths, their order, the five candidate extractors),
  `FlowIngest`'s static helpers, and the media resolver.
- `.gitignore` no longer excludes `/test`.

## [4.7.0] - 2026-09-10

### Added
- `BaseDestinationAdapter.describeSent()` and `MessageRouter.sendToDestination()`
  now return `{ platform, channel_id, message_id, sent_at }` instead of a
  boolean; `routeMessage()` collects these into `delivered[]` and adds it to
  the `message.routed` event. Needed so a later TheFlow delivery stage can
  edit a message it already sent.
- `BaseDestinationAdapter.capabilities()` (`{ edit: false }` by default) and
  an `editMessage()` that throws unless a subclass overrides it.
  `DiscordDestination.editMessage()` implemented (it did not exist before);
  Telegram's now accepts a string or a raw GramJS edit payload.
- `post_feedback` table, `PostFeedback` model, migration `004-post-feedback`.

### Changed
- Classic (non-TheFlow) forwarding is unaffected — `sendToDestination`'s
  richer return value is additive, and nothing in the classic path reads it.

## [4.6.0] - 2026-09-10

### Added
- `src/module/theflow/media/`: `MediaResolver` (a registry keyed on
  `media_ref.kind`) and `TelegramMediaResolver` (re-fetches by `media_ref`
  through GramJS, handling albums with a 10-wide id window filtered by
  `grouped_id`, then reuses the existing `TelegramMediaDownloader`). Not yet
  wired into a delivery path — there isn't one until Phase 2 — but ready for
  it to import.

## [4.5.0] - 2026-09-10

### Added
- `posts` gained `platform`, `external_id`, `external_url`, `title`,
  `author`, `media_ref`, `entities`, `embedding_model`, `embedding_dim`
  (migration `002-generalize-sources`), and `source_states` gained `cursor`
  (migration `003-source-cursor`) — the schema work needed before a
  non-Telegram source (Reddit, RSS) can exist.
- Post identity moved from `UNIQUE(channel_id, message_id)` to
  `UNIQUE(source_id, external_id)`; `FlowIngest` and `Post.ingest` updated to
  match. `scripts/backfill-image-hash.js` now resolves media through
  `media_ref` instead of the legacy Telegram-only columns.

### Changed
- `posts.message_id` keeps its `NOT NULL` and is still written for Telegram
  rows rather than becoming nullable — nothing reads it any more, and a later
  migration drops the column outright once a non-Telegram adapter exists.
  Chosen so every migration in this set stays a plain `ADD COLUMN` / index
  change with no SQLite table rebuild.

## [4.4.0] - 2026-09-10

### Added
- A hand-rolled migration runner: `npm run migrate` / `npm run migrate:status`,
  a `schema_migrations` ledger table, one backup per run into
  `database/backups/`, and a refusal to run under `NODE_ENV=development`.
  `database/migrations/001-theflow-phase0.js` wraps the original one-off
  script — it creates the Phase 0 schema on a fresh database and adopts it on
  one that already has it.

### Removed
- `scripts/migrate-theflow-phase0.js` and the unused `sequelize-cli`
  dependency (its migrations are CJS and don't fit this project's ESM setup).

### Changed
- `.gitignore`: `database/` is ignored except `database/migrations/`, which
  must be version-controlled.

## [4.3.1] - 2026-09-10

### Added
- `scripts/estimate-volume.js` — one-pass messages/day estimate per Telegram
  source, comparing the current last-message id against each source's
  `source_states` checkpoint and its own baseline date. Answers "how much
  traffic will reach the AI" before any provider is chosen (ROADMAP §2.1).

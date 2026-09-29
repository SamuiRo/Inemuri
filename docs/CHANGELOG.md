> **Role:** Per-version record of what shipped and why · **Audience:** Anyone deciding whether a change affects them, or tracing when a behavior changed

This changelog starts at `v4.3.1`. Earlier versions (`v1.0.0` through `v4.3.0`)
predate it — see `git log` for that history, and
[docs/theflow/ROADMAP.md](theflow/ROADMAP.md) §0–1 for the state TheFlow was
in going into `v4.3.1`. Versioning rule: every commit bumps `package.json`
(patch = docs/tests/cleanup, minor = new capability, major = a large body of
work closes out) — see `CLAUDE.md` § Versioning.

## [4.36.0] - 2026-09-29

discordapp from the terminal, and the first run against a real server.

### Added
- **`scripts/discordapp.js`**: `check <guildId> [config]` (read-only) reports
  the bot's identity, its role's position and missing permissions, registered
  slash commands, whether Message Content works, and the provisioning plan;
  `apply <guildId> [config] --yes` applies the plan like the Apply button
  (without `--yes` it only shows it). Its own gateway session does not listen
  to interactions, so it is safe next to the running service.
- `preparePlan` takes an optional state loader; `check` plans with an empty
  state when `discord_resources` is not migrated yet, instead of failing.

### Changed
- The plan shows 🔊/🎙/💬/📢 for voice, stage, forum and announcement channels
  instead of `#`, and says that `reorder` is checked after the other changes.

### Verified
- On the operator's test server (Community): an empty-ish server provisioned
  from the sample config in one apply (25 changes, none failed) — including
  adopting the existing `#rules` and `#general` — then a second plan reported
  nothing to do. Removing `#media` from the config archived it; editing the
  rules text edited the posted embed in place; putting `#media` back restored
  it into its category. Every run ended with an empty plan.

## [4.35.0] - 2026-09-29

discordapp step 5: provisioned messages, role panels, opt-in channel groups.

### Added
- **Messages in the config.** A text or announcement channel carries
  `messages`: text from a `.md` file in `src/config/discordapp/messages/`
  (git-ignored except `*.sample.md`), optionally as an embed with a title and
  color, or a role panel. Posted once; **edited in place** when the rendered
  message changes (a hash in state, no read of the message); posted again if
  deleted by hand. A message removed from the config is reported, not deleted.
  Provisioned messages never ping.
- **Role panels** (`rolePanel`: `toggle` or `exclusive`, up to 25 roles,
  optional label and emoji per role). Buttons are stateless
  (`roles:<t|x>:<roleId>`); an exclusive group is read from the message's own
  buttons. Any member can press them; the reply is ephemeral.
- **Self-assign safety**: a role carrying moderation or admin permissions,
  managed by an integration, or above the bot is refused — by the validator,
  by the planner against the server, and again on every press.
- **Opt-in groups** — `optIn: { role, panel? }` on a category: `@everyone`
  loses `ViewChannel`, the role gets it, and the role's button is added to the
  named panel.
- Migration `010-discord-resource-parent`: `discord_resources.parent_id`, the
  channel of a provisioned message.
- Setup section in `DISCORDAPP.md`: portal settings, the invite link with its
  permission integer, role placement, the temporary Administrator role.
- Tests: `discordapp-messages.test.js` (12) and a messages scenario in
  `discordapp-apply.test.js`.

### Fixed
- Plan text printed a permission twice when discord.js knows it under a
  deprecated alias as well (`ManageEmojisAndStickers`).

## [4.34.0] - 2026-09-29

discordapp step 4: `/provision apply`.

### Added
- **`/provision apply [server:]`** (admin, ephemeral): shows the plan with
  **Apply** / **Cancel** buttons — only when there is something to apply, no
  plan error and the bot holds Administrator. The button carries the plan's
  fingerprint; if the server or config changed before the click, nothing is
  applied. It edits its own message, so it cannot be pressed twice, and one
  apply runs per server at a time.
- **Applier** (`applier.js`): roles → role order → categories → channels →
  channel order → state. Each phase re-reads the server and state and
  recomputes the plan, so a phase sees what the previous one created and a
  rerun continues from what is left. A failed operation is logged and the rest
  of the phase still runs. Archiving moves the channel into the archive and
  syncs it with the archive's rights; a full archive (50 channels) rolls over
  into `<name> 2`. Restoring moves it back and resyncs it with its category.
- `CommandRegistry`: component handlers with `update: true` edit the message
  they sit on (buttons and attachments cleared) instead of replying anew.
- `src/module/discordapp/progress.js` — the throttled progress editor, now
  shared by `/export-chats` and apply.
- `test/discordapp-apply.test.js` — 7 cases against an in-memory server:
  empty server to configured, with an empty second plan and a no-op second
  apply; archive then restore of the same channel; adoption without
  duplicates with a per-member overwrite surviving; archive rollover; a failed
  operation not stopping its phase.

### Changed
- `topic` on a voice or stage channel is now a config error rather than a
  Discord error halfway through apply.

## [4.33.0] - 2026-09-29

discordapp step 3: server-as-code configs and `/provision plan`. Nothing is
applied yet — that is step 4.

### Added
- **Server configs** in `src/config/discordapp/servers/<name>.json`
  (git-ignored; `example.sample.json` is tracked and validates). Roles,
  categories, channels, permission overwrites with reusable `presets`, and a
  mandatory private archive category. Read on every command, so edits need no
  restart.
- **Validator** (`schema.js`): unknown fields, unknown permission names,
  unknown presets and role references, duplicate or malformed keys, and a
  permission both allowed and denied are all errors with a path — a typo must
  not silently do nothing. Only fields that are set are managed. A private
  category or channel gets an overwrite for the bot automatically, so the bot
  keeps seeing it after Administrator is taken away.
- **Planner** (`planner.js`, pure): create, adopt (existing resource matched by
  name), update, archive, restore, reorder, forget, skip, orphaned.
  **There is no delete operation.** Overwrites of targets the config does not
  manage — a per-member overwrite, a role outside the config — are preserved.
  Ordering swaps managed resources among the positions they already hold, so
  nothing outside the config moves. Errors instead of guesses: two resources
  with the same name, a role at or above the bot's, a Community-only channel
  on a plain server, a config for another server.
- **`/provision plan [server:]`** (admin, ephemeral): the plan as text, or as an
  attached file when long, plus what would block apply (Administrator).
- Migration `009-discord-resources` and the `DiscordResource` model: the
  config key → Discord id state that makes a rename an edit. The service's
  startup `sync()` also creates the table.
- `test/discordapp-provision.test.js` — 25 cases.

### Changed
- ChannelType ↔ kind mapping moved from the export feature into
  `src/module/discordapp/channelKinds.js`, shared with provisioning.

## [4.32.0] - 2026-09-29

discordapp step 2: `/export-chats`.

### Added
- **`/export-chats limit:<1–100> format:<md|json|both> scope:<this|all>`**
  (admin, ephemeral). Takes the latest `limit` messages of every text, announcement
  and voice-chat channel and every thread — active and archived — the bot can
  read, in chronological order, and writes them to the git-ignored `exports/`
  directory. The file is attached to the reply as is, gzipped when it only fits
  that way, or kept on disk only when it fits neither.
  - Markdown (default) is one line per message, grouped server → category →
    channel → thread, with replies, edits, attachments, embeds, stickers and
    reactions marked; it leaves out attachment URLs, which are signed and
    expire. JSON is the full snapshot, URLs and ids included.
  - Channels the bot cannot read are listed as skipped, in the file and in the
    reply, rather than silently missing.
  - Archived threads are capped at one API page per channel; a channel with
    more says so.
  - A missing **Message Content** intent is detected from the result — Discord
    then returns other people's messages empty and the export would look
    successful — and the reply says to enable it.
- `DISCORD_EXPORT_DIR`, `DISCORD_EXPORT_CONCURRENCY`,
  `DISCORD_EXPORT_ARCHIVED_THREADS` constants; `/exports/` in `.gitignore`.
- `test/discordapp-export.test.js` — 12 cases: normalizers, grouping and
  ordering, the Markdown layout, attachment/gzip decisions, the result text,
  and the collector against a fake guild.

## [4.31.0] - 2026-09-29

discordapp step 1 (docs/DISCORDAPP.md): Discord delivery no longer needs the
gateway, and the slash-command code became a module with a boundary.

### Changed
- **Discord delivery is REST-only.** `DiscordDestination` sends and edits
  through the new `src/module/discord/DiscordRest.js` instead of a logged-in
  discord.js client. Before this, `inemuri.js` awaited the Discord login before
  the Telegram listener started, so a Discord outage or a bad token stopped the
  **whole process** — Telegram-to-Telegram forwarding included. Now a missing
  token disables Discord delivery with a warning and nothing else.
  `describeSent()` reads `channel_id` from the raw API object.
- **Attachment limit is `DISCORD_UPLOAD_LIMIT_MB` (default 20).** The adapter
  assumed 25 MB; 20 is what the operator measured. The unused
  `setFileSizeLimit()` and its Nitro constants are gone.
- **`DISCORD_COMMAND_WHITELIST` fails closed.** An empty list used to allow
  every user to run commands; it now refuses admin commands for everyone and
  warns at startup. Admin commands are also hidden in the client from members
  without `Administrator`.
- **Commands are registered per guild, never globally**, and no longer
  unregistered on shutdown — every pm2 restart used to make them disappear and
  re-register. Leftover global commands are removed once on start.
- **Every discordapp reply is ephemeral**, enforced in `CommandRegistry`
  before any handler runs.
- `DiscordClient.js` → `DiscordGateway.js`, now used by discordapp only, with a
  permanent `error` listener: without one, a gateway error after login was an
  unhandled `error` event, which crashes Node.

### Added
- `src/module/discordapp/`: `DiscordApp` (starts last; a failed login is a
  warning and a background retry with backoff, an invalid token is not
  retried), `CommandRegistry`, and the pure `guard.js` / `customId.js`.
  `/daily` moved from `cronjobs.js` into `commands/daily.js`.
- `DISCORD_APP_ENABLED`, `DISCORD_GUILD_IDS` (servers discordapp serves;
  others are refused, never left).
- `test/discordapp-core.test.js` — 21 cases: access policy, customId, the
  registry's ephemeral/refusal/error paths, REST payload conversion, and
  delivery through a stubbed REST client.

### Removed
- `src/module/discord/DiscordCommandHandler.js` and `COMMANDS` in
  `cronjobs.js` (replaced by discordapp).

## [4.30.2] - 2026-09-29

Specification for discordapp, the Discord server-management module. No code
changed.

### Added
- **`docs/DISCORDAPP.md`** — decisions, module layout, permission model and
  feature contracts for `/export-chats`, role panels with opt-in channel
  groups, and provisioning a server from config (plan/apply, never delete —
  removed channels move into a private archive), plus the work plan. The
  central decisions: discordapp stays in the same process behind an
  `EventBus`-only boundary; Discord *delivery* moves to REST so forwarding
  never depends on the gateway session; every reply is ephemeral; business
  logic is pure functions.
- `CLAUDE.md` names discordapp and its boundary.

## [4.30.1] - 2026-09-29

Documentation caught up with the pilot being configured, and channel identities
were taken out of the repository. No code changed.

### Added
- **README: "Enabling a source into TheFlow"** — the `flow` block was
  configurable but undocumented outside the roadmap. Every field with what it
  decides, that a partial block merges with the defaults, and the consequence
  that surprises people: a flow-enabled source **stops forwarding**, because
  the two pipelines are exclusive. Its `destinations` should stay in the config
  regardless — they are what it returns to when the flag goes back off.
- **README: "Seeding sources"** — `npm run seed` matches on
  `platform` + `channel_id`, so the same channel written as `@username` where
  the stored row holds its numeric id is imported as a *second* source and the
  channel is then polled twice. This happened while enabling the pilot and was
  caught with `node src/cli.js list`. Also: the file wins on every field it
  defines, so destinations that live only in the database are erased by a
  reseed.
- `flow` and a `channel_id` caveat in the source-field table.

### Changed
- **Channel names and ids are no longer in `docs/`.** They are deployment
  data — the config that holds them has been git-ignored since `v4.17.0`, and
  the plan had been quoting them since before that. `theflow/ROADMAP.md` now
  refers to sources by shape (cluster, mode, volume rank) with labels `S1`–`S8`
  defined in §1.2 and meaningless outside it; the example channel id in
  `text_replacements.md` is a placeholder.
- `HANDOFF.md` — state refreshed: 8 migrations rather than 5, the stale
  "119 green" audit line replaced, the provider key and pilot now configured,
  and the restart requirement called out, since source config is read once at
  startup.
- `THEFLOW.md` — phase 1.5 marked implemented with what it actually does;
  phase 1 no longer "dormant" unconditionally; the vision-provider and
  quota-sizing open questions closed with what was measured.
- `theflow/ROADMAP.md` §2.9 records the pilot as configured but not yet
  observed, including two deviations from the recommendation in that section:
  the sources were picked for the filter-tuning material they had, not by
  volume, and two of the three run `listener` mode, which §1.1a argues against
  for flow sources — a listener source loses everything posted while the
  process is down, which for a corpus is a hole rather than a missed forward.

## [4.30.0] - 2026-09-13

Real free-tier limits, read from the pilot project's AI Studio page, overturned
two configuration decisions.

### Changed
- **Default complete/vision model: `gemini-2.5-flash` → `gemini-3.5-flash-lite`.**
  On the free tier `gemini-2.5-flash` allows **20 requests per day** (RPM 5),
  and so does every Flash 3.x model. The config had assumed 1400 — 70× too
  high — and a three-channel pilot would have exhausted the real allowance
  within an hour. `gemini-3.5-flash-lite` allows RPD 500 / RPM 15. Before
  switching, two live calls confirmed it returns schema-valid JSON and reads a
  code correctly from an image (`AB12CD`), so it serves enrich and vision both.
  Cost: 2 of the day's 500.
- **The quota ledger and RPM buckets are per model, not per provider.** The
  AI Studio table lists each model as its own row with its own limits, which
  settles the open question from `v4.25.0`. One counter per provider charged
  every embedding against flash-lite's budget: a post is one enrich plus one
  embed, so RPD 500 ran out at 250 posts while Google allows 500 enrich *and*
  1000 embed (`gemini-embedding-2`: RPD 1000 / RPM 100). The gateway now keys
  quota and buckets by `provider:model`; the breaker stays per provider,
  because an unavailable provider is unavailable for all its models. Vision on
  the complete model shares that model's counter, as Google does. A model with
  no limits of its own (a tier-up model) falls back to the provider's.

  `provider_quota.provider` is a string, so the composite key needs **no
  migration**.
- The measured free-tier values are the defaults (`GEMINI_RPD` 500,
  `GEMINI_RPM` 15, new `GEMINI_EMBED_RPD` 1000, `GEMINI_EMBED_RPM` 100,
  optional `GEMINI_VISION_RPD/RPM`). A paid project has higher limits, where
  these defaults under-use quota rather than exceed it — the safe side. The
  pilot's `.env`, with empty placeholders, now resolves to exactly these.

### Fixed during the change
- Introducing a `key` variable for the quota inside `_embed()` **shadowed the
  cache key** of the same name, so embeddings were cached under the quota key
  and every lookup missed — the embedding cache would have silently stopped
  working, re-spending a request on each repeat. The existing
  `embed — happy path, cached on repeat` test caught it before commit; the
  variable is now `quotaKey` in both paths, with a comment saying why.

### Added
- 5 gateway tests: enrich and embed draw on separate budgets; an exhausted
  embed model does not block enrichment; vision and enrich on one model share a
  budget; limit fallback for a model with none of its own; one RPM bucket per
  model. 3 config tests, including that the default complete model is not a
  20-requests-per-day one. Two existing tests updated to the per-model key.

## [4.29.0] - 2026-09-13

### Added
- **Vision transcribes screenshots sent as files**, closing the gap left in
  `v4.27.0`. People send a screenshot as a document (`image/png`) to stop
  Telegram recompressing it — and that is exactly what promo-code channels do,
  because every character of a code matters. `isVisionImage()` accepts `photo`
  plus documents whose MIME is on an allowlist — `image/png`, `image/jpeg`,
  `image/webp` — and no larger than 20 MB, decided from message metadata
  **before** any download (Telegram does not compress documents, so a 4K
  screenshot as a file runs 5–15 MB).

  Deliberately excluded: **SVG** (not a screenshot, and `sharp` renders it
  through librsvg — a vector file from an open channel is attack surface for no
  gain), **HEIC** (the prebuilt `sharp` does not decode it) and **GIF**
  (animation). GramJS `long` sizes arrive BigInt-like and are coerced
  explicitly, since an uncoerced comparison would fail silently.
- `MediaResolver.resolve(post, { accept })` — a predicate over pre-download
  metadata. The downloader's type list is now derived from what survives the
  filters.

### Security
- **A document's MIME type is the sender's claim; `sharp` decodes by content.**
  An SVG labelled `image/png` passed the allowlist and was rendered — verified
  before the fix, returning a 400×200 JPEG. `sniffImageFormat()` now checks the
  JPEG / PNG / WebP magic bytes and `downscaleForVision()` refuses anything
  else **before invoking any decoder**. A signature cannot be faked without the
  file actually being that format. This also covers photos, as defence in
  depth.
- Verified with the live key (read-only `models.list`, no generation quota):
  `gemini-2.5-flash` supports `generateContent` and `gemini-embedding-2`
  supports `embedContent` in the configured project, confirming the `v4.25.0`
  defaults against the real account rather than only against documentation.
- Tests: 7 for `isVisionImage` (allowlist, excluded types, size cap, BigInt
  sizes), 4 for signature sniffing including the mislabelled-SVG regression and
  a WebP screenshot, 1 for the resolver's `accept`.

## [4.28.0] - 2026-09-13

Phase 1.5 (vision), part 5: wired into the worker. **Phase 1.5 is complete**
and off on every source.

### Fixed
- **A shed consumed a retry.** `Post.claimPending()` increments `attempts`
  before the provider call (§13.1, so a crash mid-call counts), but a shed
  returned the post to `pending` without giving that attempt back. A post shed
  a few times therefore reached `maxAttempts` without a single real call, and
  its **first genuine error made it `failed` permanently**. The bug predates
  vision, but vision made it likely: vision runs at `normal` priority and is
  shed first under quota pressure, so on a tight day screenshot posts would have
  exhausted their retries within a minute and died on the next network blip.

  The existing test asserted `attempts === 1` after a shed — it had pinned the
  bug as expected behaviour. `Post.releaseClaim(id)` now returns the attempt on
  both enrich and vision sheds (only while still `pending`, never below zero),
  and a new test sheds five times and then confirms the first real error still
  gets a retry. Both fail against the previous code.

### Added
- `EnrichWorker` runs the vision stage before enrich. It is **injected**
  (`vision`, `flowFor`), not imported: `VisionStage` reaches Telegram through
  the media resolver, and the worker's defining boundary is that it knows
  nothing about Telegram — which keeps extracting it into its own process
  cheap. Supplying `vision` without `flowFor` is a construction error rather
  than a silent no-op.

  On a vision `shed`, enrichment is **not** attempted and the claim is
  released: classifying a screenshot-only post on empty text would produce a
  confident verdict, mark it `enriched`, and it would never receive its OCR.
  `skipped` and `unavailable` enrich as usual; a vision error counts as an
  attempt like any gateway error.
- `inemuri.js` builds the stage with the shared gateway, looks up each source's
  flow config (cached for the process lifetime, like the listener's own
  caches), and sweeps `vision_cache` at startup and every 6 hours on an
  `unref()`'d timer, cleared on stop.
- `VISION_CACHE_TTL_HOURS` (default 72).
- 7 worker tests for the integration and the shed fix.

### Verified
- The full CI sequence against an empty database: `db:bootstrap` creates 7
  tables including `vision_cache`, all 8 migrations apply, 272/272 tests pass.

### Phase 1.5 summary (v4.25.1–v4.28.0)
Built to VISION.md, with four departures recorded in ROADMAP §4: the cache is
keyed by Hamming distance (measured — an exact key misses nearly every repost);
verbatim validation gained OCR provenance (it would have discarded every code
from a screenshot); the resolver filters types before downloading (it would
have pulled whole videos to discard them); and sheds no longer consume retries.
`sharp` was upgraded first, since vision makes it decode channel images. Known
gap: only `photo` — a screenshot sent as a file is not transcribed yet.

## [4.27.0] - 2026-09-13

Phase 1.5 (vision), part 4: the stage, its cache, and fetching only what it
needs.

### Added
- `src/module/theflow/VisionStage.js` — `visionGate()` and `VisionStage.run()`.
  Gate → photos only, capped → downscale → dHash → cache by distance →
  `gateway.vision()` → **`UPDATE posts.text_ocr` immediately**, before enrich,
  so an enrichment retry never pays for the transcription twice. That is also
  why vision needs no status of its own: `text_ocr IS NOT NULL` is the marker.

  `NULL` and `""` mean different things on purpose. `NULL` is "not attempted";
  `""` is "attempted, no text" — no photos, illegible, blocked, deleted
  message. Without the distinction a post whose screenshot carries no text
  would be re-transcribed on every attempt.

  Outcomes the worker must treat differently:
  - `shed` — quota under pressure. **The post is left untouched** rather than
    enriched without OCR: a screenshot-only post classified on empty text gets
    a confident verdict on garbage input, becomes `enriched`, and never
    receives its OCR. Images already paid for before the shed are in the cache,
    so the retry does not buy them again.
  - `unavailable` — no provider has the capability. `text_ocr` is not marked,
    so adding a vision provider later still reaches these posts.
  - A resolver or gateway error propagates, so the worker counts the attempt.
  - One undecodable image (or a decompression bomb) is skipped without blocking
    the rest of the post.
- `vision_cache` table (migration `008`) and `VisionCache.nearest()` /
  `store()` / `sweep()`. **Lookup is by Hamming distance, not hash equality** —
  the `v4.25.1` measurement showed a recompressed repost lands 4–7 bits away,
  so an exact key would have missed nearly every repost. Exact match is tried
  first (indexed, cheap), then a capped scan of the TTL window in JS.
  `image_hash` is deliberately not unique. Illegible results are cached too, so
  an unreadable repost is not paid for twice.
- `MediaResolver.resolve(post, { types, limit })`. **The Telegram resolver
  downloaded every media type before the caller could filter**, so the vision
  stage asking for a post with a video would have pulled the whole video just
  to discard it — the exact thing ROADMAP §5 forbids ("must never have
  triggered a video download"). Types and the album cap now apply to the parsed
  media *before* download, and the type list is handed to the downloader too,
  or its global list would silently drop a requested type. Without options,
  behaviour is unchanged.
- Tests: `vision-stage` (17), `vision-cache` (8), 5 more for the resolver.

### Known gap
- Only `photo` is transcribed. A screenshot sent **as a file** — a document
  with `image/png`, which people do to stop Telegram compressing it — is not
  picked up. Supporting it needs the resolver to filter documents by MIME type.

### Test hygiene
- The first `sweep()` test swept with a future date, which deletes **every**
  row in `vision_cache`, not just the test's own. Harmless on the new, empty
  table, but it would have wiped real cache entries on any developer database
  that had them. It now ages one test row directly and sweeps with the real
  clock.

## [4.26.0] - 2026-09-13

Phase 1.5 (vision), part 3: the vision call itself.

### Added
- `LLMGateway.vision(image, { priority })`, replacing the stub that threw.
  It shares the per-provider quota, RPM bucket and breaker with enrich — the
  point VISION.md makes about the gateway: without shared accounting vision
  quietly eats the daily limit and ordinary enrichment starts failing, which
  presents as "classification broke" rather than "vision ate the quota".
  Default priority is `normal`, below enrich's `critical`, so under quota
  pressure vision is shed first. Returns `null` when no provider advertises the
  capability, mirroring `embed()`, so the stage simply skips.
- `GeminiProvider.vision()` — image inline as base64 with the response schema.
  A **safety-filter block** (`promptFeedback.blockReason` or
  `finishReason: "SAFETY"`) returns a `legible: false` result naming the
  reason instead of throwing: the block is deterministic for that image, so a
  retry would only burn quota and a fallback would send the same image.
- `src/services/ai/prompts/vision.js`. The model **transcribes and does not
  classify** — VISION.md's "OCR, not vision classification": the text merges
  into the post and enrich runs unchanged, rather than a second pipeline with
  its own reliability and prompt tuning. The prompt asks for verbatim text, one
  line of description and `legible`; tells the model not to guess between
  `0/O`, `1/I/l`, `5/S`, `8/B` but to report illegible instead; and treats text
  in the image that reads like instructions as text to transcribe, never to
  follow.

  `legible` stands in for a confidence signal Gemini does not return per
  transcription. A self-assessment is not real confidence, but it is the lever
  available, and `validateVisionResponse()` empties `text_ocr` whenever the
  model reports the image illegible — whatever it wrote anyway goes nowhere.
  Transcriptions are capped at 4000 characters against a model narrating
  rather than reading.

### Changed
- **The fallback matrix is one method, `_runWithFallback()`**, used by both
  `complete` and `vision` rather than copied. It is the most error-prone part
  of the gateway — quota, breaker, rate-limit backoff, the single
  `bad_response` retry, moving to the next provider — and two copies would
  drift at the first edit. JSON parsing runs inside the invocation, so an
  unparseable answer is a `bad_response` and gets its retry. All 16 existing
  gateway tests pass unchanged on the refactor.
- The JSON parse error no longer says `enrich:` — it is shared now, and the
  prefix would mislead while debugging vision.
- `test/vision-gateway.test.js` — 18 cases over the prompt, validation,
  provider request shape, safety-block handling, shared quota, shedding, the
  retry and fallback.

## [4.25.3] - 2026-09-13

Phase 1.5 (vision), part 2: provenance for entities read from images.

### Fixed
- **Verbatim validation would have silently discarded every code from a
  screenshot.** `validateVerbatim()` checked extracted promo codes and tickers
  against `raw_text` only. A code that exists only in an image is by definition
  absent there, so once vision ran, the codes it exists to recover would have
  been thrown away with no error — vision spending quota for nothing.

  The obvious fix was the dangerous one: adding `text_ocr` to the haystack
  would have marked OCR codes as verified. VISION.md is explicit that
  `HY45OLK8QRE2` and `HY45OLK80RE2` read from an image look equally convincing,
  and a wrong code delivered with confidence is worse than none.

  So there are now three outcomes instead of two: found in the post text →
  kept, `verified: true`; found **only** in the transcription → kept,
  `verified: false`; found in neither → discarded, as before. A match against
  `text_ocr` only proves the model did not invent the string relative to the
  transcription — the transcription itself may be wrong, hence unverified.

### Added
- Promo code objects carry `source` (`"text"` / `"ocr"`) and `verified`. They
  go on the object because that is where delivery (DELIVERY.md: "any entity
  carrying `verified: false` is marked") and tier 1 dedup ("an unverified code
  must not suppress a verified one") will read them.
- Tickers are strings, and giving them per-item provenance would have changed
  the schema, so OCR-only tickers stay in the array and are listed in a new
  `unverified: [{ path, value }]` result, symmetric with `discarded`. That
  limitation is deliberate and noted in the code.
- `validateEnrichResponse()` and the gateway pass `textOcr` through — on both
  the base run and the tier-up re-run, since a validation that supports
  provenance is useless if the caller never hands it the transcription.
  `enrich()` results now include `unverified`.
- 8 tests; five fail against the previous code. Without `text_ocr` the
  behaviour is unchanged, which one test pins.

## [4.25.2] - 2026-09-13

### Security
- `sharp` 0.34.5 → 0.35.4 (libvips 8.18.6), closing the libvips and libheif
  advisories — `npm audit` 10 → 9. Deferred at `v4.22.1` as a major bump with
  no reachable path, it became urgent at `v4.25.1`: vision will make `sharp`
  decode images from Telegram channels. It lands before vision is enabled
  anywhere. The 12 image tests, including the decompression-bomb refusal, pass
  on the new version, as does the one pre-existing call site
  (`loadImage("daily.png")` in the cron job).

## [4.25.1] - 2026-09-13

Phase 1.5 (vision), part 1: local image processing.

### Added
- `src/shared/image.js` — `dhash()`, `hammingDistance()`,
  `downscaleForVision()`. dHash lived only inside
  `scripts/backfill-image-hash.js`; gate 3 of the vision stage must compute the
  identical hash or the backfill and the stage would never agree on a cache hit,
  so it now has one home and the script imports it.
- **`SAME_IMAGE_MAX_DISTANCE = 10`, measured rather than chosen.** On
  screenshot-like images the same shot after Telegram-style downscaling and
  recompression lands at 4–7 bits; genuinely different screenshots at 15–23.
  Ten sits in the gap with margin both ways.

  The measurement changes the cache design: **a repost almost never hashes to
  distance 0, so an exact-hash cache key would miss nearly every repost** — the
  saving VISION.md calls "the largest single one of the four gates" would not
  happen. The vision cache must be looked up by Hamming distance. A test pins
  that a recompressed repost does not hash identically, so the premise is
  flagged if it ever stops holding.

  The first fixture was a smooth gradient, and on it dHash could not tell a
  recompressed copy (8) from a different image (8): adjacent pixels are nearly
  equal, so JPEG noise flips comparison bits. Real screenshots have hard edges,
  so the fixture was replaced — but the caveat is real and recorded: on
  low-contrast images (subtle gradients, dark UIs) the threshold will produce
  extra cache misses. That costs a call, not correctness.
- `limitInputPixels` set explicitly (50 MP) with `failOn: "error"`. From phase
  1.5, `sharp` decodes images from Telegram channels — bytes from outside. A
  decompression bomb (a few kilobytes declaring enormous dimensions) is refused
  before decoding; a test builds one and confirms it. EXIF rotation is applied
  so phone screenshots do not arrive sideways.
- `test/image.test.js` — 12 cases.

### Security note
- Until now `sharp` only ever processed a file from the repository, which is
  why the `v4.22.1` audit rated its libvips/libheif CVEs unreachable. **That
  assessment stops being true when vision runs**, since it will decode
  attacker-influenced image bytes. The `sharp` major upgrade therefore belongs
  to this phase rather than to "after the VPS deploy", and lands before vision
  is enabled anywhere.

## [4.25.0] - 2026-09-13

Provider decision (ROADMAP §3.1): **Gemini primary for text, vision and
embeddings; OpenRouter fallback for text only.** Checking the decision against
the provider's current documentation turned up two defects that would have
shown up only after going live.

### Fixed
- **The default embedding model had been shut down.** `text-embedding-004` was
  retired on 2026-01-14 and was still the config default. It failed quietly: a
  404 classifies as `bad_response`, so the circuit breaker stayed closed and
  enrichment carried on — but `quota.bump()` runs before the request, so every
  post spent daily quota on a guaranteed 404 and was stored with
  `embedding = null`. With one enrich and one embed call per post, that is half
  the Gemini allowance buying nothing. Now `gemini-embedding-2`, dimension
  pinned at 768 per ROADMAP 13.2 (the model default is 3072). No `task_type` is
  sent, which embedding-2 rejects; the provider already normalizes vectors, so
  the switch needed no code change there.
- **The quota ledger counted days in UTC; Gemini resets at Pacific midnight.**
  The ledger exists to predict the quota wall, and it predicted it seven to
  eight hours off. The worst case was concrete: exhausting at 06:00 UTC
  (23:00 PDT) marked Gemini spent for the entire UTC day, so after Google
  restored the quota at 07:00 the gateway kept refusing the provider for about
  17 hours — enrichment either stalled or shifted everything onto OpenRouter's
  smaller allowance. `ProviderQuota.today(timeZone, now)` computes the day in a
  given IANA zone (DST included), each provider carries `quotaTimeZone`
  (`America/Los_Angeles` for Gemini, per Google's rate-limit page; `UTC` for
  OpenRouter, unverified and configurable), and the gateway passes the right day
  at all five ledger call sites. An invalid zone warns at startup and falls back
  to UTC rather than crashing the worker.

### Added
- A startup warning when more than one embedding model is configured.
  OpenRouter **does** expose `/embeddings` — closing that open question in
  §3.1 — and it stays deliberately unused. 13.2 already forbids comparing
  vectors across models, so a fallback embedding would not corrupt dedup; it
  would make the post invisible to it, stored in a vector space the rest of the
  corpus is never searched in. A `null` can be backfilled by the same model.
- `.env.example` rewritten around the decision, marking what cannot be
  defaulted: **free-tier RPM/RPD are not published by Google**, only visible
  per project in AI Studio; and the OpenRouter model must support
  `json_schema` output.
- Tests: the Pacific/UTC day boundary including DST, zone propagation through
  the gateway, invalid-zone fallback, and `test/llm-config.test.js` asserting no
  default points at a shut-down model. The five regression tests fail against
  the previous code.

### Changed
- ROADMAP §3.1 records the decision and what the doc check changed; §11 marks
  it decided. HANDOFF's next steps now start from the two values only the
  operator can supply, and name phase 1.5 (vision) as unblocked.

## [4.24.0] - 2026-09-13

Phase 2 begins: the resolve stage (ROADMAP §5.2).

### Added
- `src/module/theflow/ResolveStage.js` — `resolve({ post, flow, routing })`
  turns a verdict into destinations. Pure, no I/O: rules and destinations are
  arguments, so it is tested as a function. Implements every rule in
  TAXONOMY.md — descending priority, first match wins, fallthrough to
  `unsorted_destinations`, low confidence forcing `#unsorted` regardless of a
  match, single value ≡ one-element array — plus the `#unsorted is mandatory`
  list: a failed model, topic `other`, and no rule matching all land there.

  **Every result carries a `reason`** (`matched_rule`, `model_failed`,
  `low_confidence`, `topic_other`, `topic_not_in_source`, `no_rule`). That is
  what makes `#unsorted` useful rather than a heap: it tells you whether to fix
  a description, a threshold, a topic list or a rule. The checks run in a fixed
  order and the first that applies is recorded.

  Two gaps in the spec, filled:
  - *A topic outside the source's `flow.topics`* → `#unsorted` with its own
    reason. The spec only defined `null` as "all". Dropping such posts would
    make a topic-restricted source the one place things vanish silently.
  - *A rule that matches but has no destinations* is skipped rather than taken,
    so a half-written rule cannot swallow posts.

  And three defensive properties: a post whose status should never reach
  resolve (`pending`, `skipped_*`, `routed`) **throws** — a quiet `#unsorted`
  would hide a bug in whatever selected it; returned destinations are copies,
  so a caller cannot corrupt the config by mutating them; a missing or garbage
  confidence is treated as low rather than routed.
- `validateRouting(routing, taxonomy)` — returns problems instead of throwing.
  A bad routing rule does not fail, it silently changes behaviour: `"signal"`
  typed for `"signal_type"` would make a rule match everything, and a topic not
  in the taxonomy would make one match nothing. **TAXONOMY.md's own example
  uses `games` and `market`, neither of which exists in v1**, so a
  `routing.json` copied from the spec would have routed nothing. Printed at
  startup as `[ROUTING]` warnings — not fatal, because routing is still in
  shadow and classic forwarding does not depend on it. The live `routing.json`
  and the shipped sample both validate clean.
- `test/resolve-stage.test.js` — 24 cases.

### Not yet
- Nothing calls `resolve()` on real posts. Wiring it into delivery is 5.4, and
  creating the channels it routes to is 5.1 — still the operator's, and still
  what gates turning any of phase 2 on.

## [4.23.0] - 2026-09-13

### Security
- **The Telegram 2FA password was echoed to the terminal in clear text.**
  `TelegramClient` used `input.text()` for all three auth prompts, and that
  helper maps to inquirer's `input` type, which does not mask. The password
  appeared on screen and stayed in the shell's scrollback. It now goes through
  `askSecret()`, which mutes the output stream immediately after the prompt is
  written.

  The masking test has a **control case**: the same readline interface without
  muting, asserting the echo *is* present. Without it, "the secret never
  reaches the output" would have proved nothing — it could equally have meant
  readline does not echo to a fake stream at all. It does; the guard is
  load-bearing.

### Removed
- The `input@1.0.1` dependency, and with it **26 packages**: `inquirer@0.12.0`
  (a 2016 release), `babel-runtime`, `core-js`, `rx-lite`, `readline2`, its own
  copies of `chalk`/`ansi-styles`/`supports-color`, and the rest of that tree —
  all for three prompts in the Telegram login path. Nothing in the audit
  flagged it, which is the point: it was the oldest thing in the tree and the
  largest attack surface per line of value.

### Added
- `src/shared/prompt.js` — `askText()` and `askSecret()` on the built-in
  `node:readline/promises`. Streams are injectable, so the behaviour is
  testable without a terminal. One interface per prompt, closed immediately:
  an open readline on stdin keeps the event loop alive, and the process would
  not exit after `npm start`. `test/prompt.test.js` covers that too.

## [4.22.1] - 2026-09-13

### Security
- `npm audit fix` applied: **24 production advisories down to 10**, 22 packages
  updated, `package-lock.json` only — every change was inside an already
  declared semver range, so `package.json` is untouched. Tests 149/149, lint
  clean.

  Notable ones closed: `axios` 1.13.5 → 1.20.0 (a long list of prototype
  pollution gadgets and `NO_PROXY` bypasses), `sequelize` 6.37.7 → 6.37.8 (SQL
  injection via JSON column cast, GHSA-6457-6jrx-69cr), `ws` → 8.21.3 and
  `undici` → 7.29.1 / 6.28.1 (WebSocket parser crashes and unbounded
  decompression on the Discord gateway), `validator` 13.12.0 → 13.15.35,
  `lodash` 4.17.21 → 4.18.1, `form-data`, `socks`/`ip`, `dottie`, `tar-fs`.

  The 10 that remain need a major bump and were left alone: eight are the
  `sqlite3@5.1.7` build toolchain (`tar` — the one critical — plus `node-gyp`,
  `cacache`, `make-fetch-happen`, `http-proxy-agent`, `@tootallnate/once`),
  reachable only while `npm install` extracts a prebuilt binary and not at
  runtime — verified by hooking `Module._load` around `require("sqlite3")`:
  ten modules load, none from that chain. The other two are `sharp` (libvips
  and libheif CVEs) and `sqlite3` itself. npm's suggestion for the remaining
  `sequelize`/`uuid` entries is `sequelize@3.30.0`, a downgrade from 6.x, and
  is nonsense.

## [4.22.0] - 2026-09-13

CI, and a working linter — the last two items of build-side debt.

### Added
- `.github/workflows/ci.yml`: lint, schema bootstrap, migrations and tests on
  every push to `master` and every PR, on Node 22. CI deliberately has no
  `.env`, no `sources.json` and no database, so every run re-proves that a
  fresh clone starts on the `*.sample.json` fallbacks — the property `v4.17.0`
  added and `v4.18.1` had to repair.
- `eslint` as a pinned devDependency with a flat `eslint.config.js`, plus
  `npm run lint` / `lint:fix`. Lint was **not running at all**: eslint was in
  no dependency list, so `npx eslint` fetched a current release, which reads
  only flat config and failed on `.eslintrc.json` (now deleted). Nothing caught
  it because lint was not a script.

  Rules carried over as they were, with three deliberate settings.
  `eqeqeq` gets `{ null: "ignore" }`: all ten violations were the intentional
  `x != null` idiom, and rewriting them to `!==` would stop catching
  `undefined` — a behaviour change for a lint rule. `no-console` allows
  `error`/`warn` and is off in `shared/utils.js`, the CLI and scripts, which
  *are* the output layer rather than callers of it. Base adapters use
  `args: "none"`, since their unused parameters document the contract for
  subclasses and renaming them to `_foo` would spoil the only place that
  contract is visible.
- `npm run db:bootstrap` (`scripts/bootstrap-schema.js`), because
  **migrations cannot create the schema from nothing.** `sources` and
  `source_states` predate the migration system and come from
  `database.sync()`, so `npm run migrate` against an empty file dies in `002`
  at `describeTable("sources")`. Invisible until now, because every database in
  existence already had those tables. It is a no-op on a populated database and
  refuses `NODE_ENV=development` exactly as `migrate` does.

### Fixed
- `test/enrich-worker.test.js` took its source from `Source.findOne()` —
  depending on data it never created. On a clean database that returns `null`
  and five tests died on `.id`. It now creates and removes its own namespaced
  source. Verified by running the whole CI sequence against an empty database:
  149/149.
- 17 files were missing a trailing newline, fixed by `--fix`. Dead code
  removed: an unused `print` import in `MessageFilter`, two unused `catch`
  bindings, an unused loop key in `cronjobs.js`.
- `inemuri.js` dumped error data through `console.log`; it is `console.error`
  now.

### Notes
- `npm audit` reports 24 vulnerabilities in production dependencies (1
  critical, 15 high), all pre-existing and mostly transitive through the
  Discord and Telegram clients. Not addressed here, since `npm audit fix` can
  bump majors, but recorded so it is not discovered by accident.

## [4.21.1] - 2026-09-13

### Changed
- `analysis` and `opinion` sharpened in `categories.json`, from a case where
  the old wording could not choose. Two posts from one channel, same shape — a
  long write-up on a Valve content drought, dates and patch history cited, poll
  at the end:

  - *"524 days without a new case, 871 without a new Arcana"* is **analysis**:
    it says nothing tradeable shipped in that window, which is a fact about
    supply, and supply bears on price.
  - *"CS2 turns three and there has been no content for two months"* is
    **opinion**: the occasion is a birthday, the dates are decoration, and
    nothing about what to buy, sell or claim follows.

  "A breakdown with data and reasoning, not just an opinion" admitted both.
  The test is now whether the data **changes what a reader would buy, sell or
  claim** — a retrospective pegged to a calendar occasion is an opinion however
  well researched. `opinion` gained the matching half: data that is incidental.

  No regex can draw this line and no per-source filter can either — the posts
  differ only in what their numbers are *about* — so it belongs in the taxonomy.
- `docs/theflow/TAXONOMY.md` gains a "Boundaries that were actually contested"
  section holding this case and the `freebie` / `event` one from `v4.14.4`.
  Signal descriptions are the model's only instruction, and a boundary recorded
  without the case that forced it gets re-litigated — or, worse, labelled both
  ways in `flow review`, which poisons the `post_feedback` set phase 5 draws
  few-shot examples from.

  `version` stays `1`: the corpus is empty, so no stored verdict depends on the
  old wording (same reasoning as `v4.14.4`).

## [4.21.0] - 2026-09-12

### Added
- `filters.reject_shouty` — an opt-in per-source rule dropping short all-caps
  posts. It exists for ritual posts (`ВСЕМ СПАСИБО. СПОКОЙНОЙ НОЧИ.`, daily
  countdowns) whose wording changes every time, so a blacklist has no stable
  substring to match. Lives inside the existing `filters` JSON, so **no
  migration**.

  Thresholds default to 120 characters and 0.8 caps, measured against real
  posts: ritual posts scored 1.00 while the most shouty *useful* post scored
  0.21. `capsRatio()` counts uppercase among letters only — digits, emoji and
  punctuation have no case and would dilute it — and works for Cyrillic.

  **Promo codes are excluded inside the check, not just by configuration.** A
  bare code such as `PS3QWS3ACGDK` is 100% caps and 12 characters: exactly the
  shape the rule targets, and the most expensive possible false positive, since
  a promo channel would lose the code itself. `isShouty()` refuses any text
  containing a promo-like token, so a code survives even where the rule is on.
- `src/shared/text.js` — `capsRatio`, `isShouty`, `compileShouty`, and
  `PROMO_RE` / `isPromoLike` moved out of `RegexStage`. Dependency-free on
  purpose, unlike `shared/utils.js` (chalk, sharp, gradient), so both
  `MessageFilter` and `RegexStage` can import it. One definition means the
  classic path and flow ingest cannot drift apart in judging the same text.
- `skipped_shouty` in `POST_STATUSES`. A flow source records the post with a
  reason instead of discarding it, so `flow stats` can show what the rule
  catches. No migration: `posts.status` is `STRING`, not an `ENUM`, for exactly
  this reason.
- The toggle and both thresholds in `SourceBuilder.html`. Verified in-browser:
  round-trips byte-identically, `null` never reaches the file, and a ratio
  above 1, zero and non-numeric input are all refused.
- `test/shouty.test.js` — 19 cases, including the promo-code guard, that a long
  post starting in caps is never shouty, that earlier rejections still take
  precedence, and that a rejected post keeps its hash and candidates.

### Changed
- `RegexStage.evaluate()` takes `rejectShouty` and applies it **last**, after
  the empty, blacklist and noise checks — it is the most expensive of them and
  the earlier reasons are more specific.
- `MessageFilter` applies the rule after the blacklist and before keywords: an
  empty whitelist passes everything, so placing it later would leave it nothing
  to act on.

## [4.20.0] - 2026-09-12

Both findings from the `v4.19.0` doc rewrite, acted on.

### Added
- `sources.extra_media_types` (migration `007`, JSON, plain `ADD COLUMN`).
  Media types to download for one source **in addition** to the global
  `DOWNLOADABLE_MEDIA_TYPES`, so `audio` can be kept where it is worth keeping
  without forwarding every voice message everywhere.

  Additive rather than a full per-source override, deliberately: a replacement
  list invites omitting `photo` by accident and silently losing every image on
  that source. `Source.getDownloadableMediaTypes(global)` merges and
  de-duplicates, and treats `NULL`, an empty array, a JSON string and anything
  malformed as "global list only".

  `video_note` stays out of the global list by decision — round video messages
  are not worth forwarding — but a source can name it.
- The chips for it in `SourceBuilder.html`. Verified in-browser: a mixed config
  round-trips byte-identically and an empty selection never reaches the file.
- `test/media-types.test.js` — 10 cases over the getter (including the
  string-column and garbage paths) and the downloader honouring a per-call list
  for both albums and single media.

### Fixed
- **Skipping a non-downloadable media type is no longer silent.** It was a bare
  `continue` in `_downloadMany` and a `return null` in `_downloadOne` with no
  log line at all — the one place in the pipeline where media vanished without
  a trace, leaving nothing to diagnose. The skip now logs the type, the
  effective list, and that `extra_media_types` is the fix.
- `photo.defaultExtension` was `"png"`, which was unreachable and misleading.
  `parseMedia()` sets `mimeType: "image/jpeg"` unconditionally for photos and
  `_getFilename()` consults the MIME type *before* the default, so Telegram
  photos always land as `.jpg`. The field now says `jpg` and carries a comment
  explaining why.

## [4.19.0] - 2026-09-12

### Added
- `docs/media.md`, rebuilt from the code rather than translated from the
  retired `USE_EMBED.md`. The old document was wrong about the thing it mainly
  documented: it described an **opt-in** embed API — `useEmbed: true`, or a
  caller-supplied `embed` object with title, colour and fields — while
  `DiscordDestination._buildPayload()` composes an embed from the message every
  time and there is no way to pass one in.

  The rewrite is organized around the fact that media crosses **three
  independent stages, each dropping things for its own reasons** — which is
  what you need to know when a file does not arrive:

  1. `TelegramMessageParser.parseMedia()` classifies and rejects nothing;
  2. `DOWNLOADABLE_MEDIA_TYPES` decides what is downloaded;
  3. `supportedMediaTypes` decides what may become an embed image.

  Two findings from checking every symbol against the tree:

  - **`audio` and `video_note` parse correctly but are never downloaded.**
    `DOWNLOADABLE_MEDIA_TYPES` omits them, and both skip paths are a bare
    `continue` / `return null` with no log line, so the loss is invisible.
    `audio` is nonetheless configured in `DiscordDestination`'s
    `supportedMediaTypes`, so the two lists disagree and nothing keeps them
    in sync.
  - **`photo.defaultExtension: "png"` almost never applies.** `parseMedia()`
    sets `mimeType: "image/jpeg"` unconditionally for photos (a Telegram photo
    carries no document, so there is no MIME type to read), and the MIME lookup
    runs before the default — so Telegram photos land as `.jpg`. The retired
    document had a section arguing for PNG that did not describe real
    behaviour.

  Also documented: the fixed Blurple colour, the 4096-char description
  truncation and its `*(…)*` marker, per-file oversize skipping with the
  warning in the embed footer, `setFileSizeLimit(true)` for Nitro and the fact
  that nothing calls it, the three-step filename resolution, and the three
  places a new media type has to be registered.

### Changed
- `README.md`'s media section and document index, and `ARCHITECTURE.md`'s
  directory tree, point at the new file.
- `docs/.archive/README.md` marks `USE_EMBED.md` superseded rather than
  "worth rewriting", and records what it got wrong. Nothing in the archive is
  pending any more.

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

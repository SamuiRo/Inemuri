> **Role:** The full session-by-session record — what each working session did and found · **Audience:** Anyone tracing how the project got to its current state

Newest first. [HANDOFF.md](HANDOFF.md) keeps only the latest entries; when it
gets a new one, the oldest of them moves here. For what each version shipped,
see [CHANGELOG.md](CHANGELOG.md).

### 2026-10-03 — the first 18 Telegram channels

The operator collected 18 gaming, Steam and crypto channels with good and
bad examples. Proposed filters were run through the real `MessageFilter`
and `RegexStage` on the exported posts: footers stripped, giveaways, shop
ads, fundraisers and review links blacklisted, none of the good examples
cut. Roughly half of the bad examples are "not interesting", not spam —
that is calibration, not regex. Operator decisions: `games`, `p2e`, `meme`
(v3); `is_ad` → `#unsorted`; `min_length` on two channels (60); every
post not in Ukrainian translated; art posts kept; one channel's own blog
links cut for now.
Seeding overwrote the classic destinations of three DB-only sources; they
were restored from `database/backups/pot.sqlite.pre-news-seed-2026-10-03`
the same session, nothing was sent in between (the service was down).

### 2026-10-03 — documentation brought up to date

THEFLOW.md, README, ARCHITECTURE and CLAUDE.md said phases 2–5 were
specification and phase 1 dormant; they now carry the real status (phases
0–5 built, phase 6 steps 1–3). HANDOFF was 443 lines: rewritten as a short
current picture, the session record moved to SESSION_LOG.md. The operator
accepted the two preflight warnings as non-critical.

### 2026-10-03 — ready for the shadow week

Pushed to `origin` (v4.55.1, fast-forward). Triage now waits for a full batch
or 20 minutes instead of calling the model on every tick — that alone would
have spent the daily quota. `flow preflight` checks a deployment end to end;
DEPLOYMENT.md lists every file git does not carry. The ten agreed outlets
were checked live (all respond, fresh items), added to the local
`sources.json` and seeded; the poller loads all ten with triage on.

### 2026-10-03 — taxonomy v2, deployment data out of git

`categories.json` v2: topics `health`, `mind`, `money`, `markets`, signals
`research`, `report`; render and digest know them. The repository is public,
so the triage profile became deployment data: `triage.json` is git-ignored
and loaded through `localConfig` with `triage.sample.json` (neutral) as the
fallback; tests use the sample; docs and taxonomy examples no longer retell
the operator's example posts. The rule is in CLAUDE.md. Nothing was pushed
before this — the local branch was 90 commits ahead of `origin`.

### 2026-10-03 — news intake step 3

Headline triage: `discovered_items` (migration `017`), `src/module/theflow/triage/`,
`gateway.triage()`, `src/config/triage.json`, `flow triage stats|review`,
a triage toggle in `SourceBuilder.html`. The operator's interest profile and
eight example posts are in place; markets count in both directions. Live on
NYPost: 252 of 596 headlines dropped by rule, 50 judged in one call, 3–4
passed.

### 2026-10-03 — news intake step 2

`sitemap` and `wpjson` discovery (migration `016`, `src/sources/feeds/discovery.js`),
gzip bodies, the sitemap index followed to its freshest child. Checked live:
NYPost sitemap 599 items, Reuters 50 through its index, NYT `.gz` 714, Fox
243, The Hill and TechCrunch WordPress 25 each, NYPost WordPress 401.
`SourceBuilder.html` gained a discovery selector for `rss` sources.

### 2026-10-03 — news intake spec, knowledge base

Probed 31 news outlets (RSS length, news sitemap, WP JSON API, article page):
about two thirds of RSS feeds carry only a teaser, nearly all outlets publish
a news sitemap with titles, and the most market-relevant ones (Reuters,
Bloomberg, WSJ, FT, AP) close their pages to an honest bot. That produced
[theflow/NEWS_INTAKE.md](theflow/NEWS_INTAKE.md) and ROADMAP §14. Step 1 built:
`knowledge_examples` (migration `015`), `src/module/theflow/knowledge/`,
`flow knowledge stats|export|import|backfill`; `flow review` and few-shot moved
onto it. The dev database had no labels yet, so the backfill copied nothing.

### 2026-09-30 — phase 5

- Built few-shot from labels and the digest (`v4.51.0`). Live call: an
  example with the note "esports results are other/opinion" steered a new
  tournament post there. The digest previewed on the pilot corpus: security
  first, Ukrainian leads, links. Reactions (§5.7) stay open — they need a probe
  against a live channel.

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

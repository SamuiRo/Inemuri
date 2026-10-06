> **Role:** Current state and next steps · **Audience:** Anyone starting a session on this project, human or AI

Short by design — read it whole. The full session record is in
[SESSION_LOG.md](SESSION_LOG.md), every version in [CHANGELOG.md](CHANGELOG.md),
per-task status in [theflow/ROADMAP.md](theflow/ROADMAP.md).

## Current state

`v4.59.0`; pushed up to `v4.58.0`. 18
migrations; `npm test` is 623 green `node --test` cases on a throwaway
database (never `database/pot.sqlite`); CI runs lint, bootstrap, migrate and
tests on every push.

| Part | State |
|---|---|
| Classic forwarding | Telegram → Telegram/Discord, unchanged; must keep working through every deploy |
| TheFlow phases 0–5, 1.5 | Built, run on real data in shadow mode ([THEFLOW.md](THEFLOW.md)). Delivery built and **off** until the destination channels exist |
| Phase 6 — news intake | Steps 1–3 built: knowledge base, sitemap/WordPress discovery, headline triage ([theflow/NEWS_INTAKE.md](theflow/NEWS_INTAKE.md)). **Ready for the shadow week** |
| Taxonomy | `categories.json` v3: v2 (`health`, `mind`, `money`, `markets`; `research`, `report`) + `games`, `p2e`; `meme` |
| Delivery extras | Ads (`is_ad`) → `#unsorted`; routed posts not in Ukrainian are translated (`translate()`, only for what is sent); `filters.min_length` |
| Status board | Built (`v4.58.0`): silent sources and channels, one message edited in place; on with `status_destinations` |
| discordapp | Complete and in production ([DISCORDAPP.md](DISCORDAPP.md), [PROVISIONING.md](PROVISIONING.md)); one piece not run live: `/export-chats` to Telegram |

**Dev copy.** 18 Telegram channels from the operator's list
(`devtest/Sources/`, git-ignored: INFO/POSTS/screenshot per channel) are in
`sources.json` and seeded with per-channel filters, all flow-enabled — 15
new, 3 updated pilots. Three of the new ones were DB-only classic sources: their classic destinations, `polling`
mode and old filters were kept and merged. Before that: 10 news outlets with
triage, `triage.json` profile v1, 8 operator examples in the knowledge base,
`health_destinations` set, delivery off. Corpus: 102 `enriched`, 115
`pending` (pilot posts waiting for the next run).

**The VPS** still runs the pre-TheFlow `v4.1.7`. The operator deploys it
([DEPLOYMENT.md](DEPLOYMENT.md), "Turning on news intake in shadow mode");
none of the deployment data travels with `git pull`.

## Configuration layout

Deployment data is git-ignored (the repository is public) and read through
`src/config/localConfig.js`; a missing file falls back to its tracked
`*.sample.json` with a `[CONFIG]` warning, a malformed one stops the start.

| Local (ignored) | Sample (tracked) | Holds |
|---|---|---|
| `sources.json` | `sources.sample.json` | Sources: channels, filters, replacements, `flow`, `feed`, `poll_interval_min` |
| `routing.json` | `routing.sample.json` | `unsorted_destinations`, `routing`, `health_destinations`, `digest_destinations` |
| `triage.json` | `triage.sample.json` | Headline-triage reader profile (NEWS_INTAKE.md §5) |
| `cronjob.config.json` | `cronjob.config.sample.json` | Cron job destinations |
| `discordapp/servers/*.json`, `messages/**` | `*.sample.*` | discordapp server configs and texts |

`categories.json` is tracked: taxonomy only, neutral examples. **Never in
git:** channel lists and ids, filters, routing, the triage profile, server
configs, the operator's example posts (knowledge JSONL under `database/`).
Public outlets (NYPost, PsyPost, Reuters) are fine as examples.

## Next steps

0. **Start the service** — the 18 channels and the v3 prompt load on start.
   Watch `flow stats` per source for a day: the filters were checked
   offline against the operator's good/bad examples
   (`devtest/Sources/FILTERS.proposed.json`), not against live traffic.
   Re-enrichment of old verdicts under v3 is a separate decision
   (`flow requeue --status enriched --reset-dedup`, quota cost; the flag
   re-clusters them, possible only while nothing is delivered).
1. **Deploy and run the shadow week** (operator). Push `v4.56.0` first — it
   carries the triage batching fix. On the server: copy the ignored configs,
   `npm run seed`, `flow knowledge import`, `flow preflight` → Ready, start.
   Then daily `node src/cli.js flow triage stats` and `flow triage review`.
2. **After the week:** read the labels, tune `triage.json` (bump its
   version), set the market cap and corroboration rules (NEWS_INTAKE.md §5).
3. **Phase 6 step 4** — article text for what passed triage (JSON-LD
   `articleBody` → `<p>`), plus the sampled rejects (ROADMAP §14.4).
4. **Destination channels — prepared, applied with the deploy.** The server
   config (git-ignored) creates the test channels in the staff category;
   the local `routing.json` routes to them with `TODO:<key>` placeholders.
   On the VPS, with the production bot: follow DEPLOYMENT.md "Turning on
   delivery to test channels and the status board" — migrate, apply, delete
   the old texts and panels (posted by the test bot), `discordapp.js ids` →
   fill the placeholders, `flow preflight` → Ready, `flow preview`, then
   `FLOW_DELIVERY_ENABLED=true`. The sending account has no Premium, so
   `TELEGRAM_PREMIUM` stays unset: media posts are budgeted to 1024. The
   post template is no longer a draft (DELIVERY.md "The template"); the
   server texts, embed role panels and the announcement in news are in the
   git-ignored config and go out with the same apply.
5. **Deduplication thresholds** once several sources produce:
   `node src/cli.js flow dedup --pairs 30`, set `DEDUP_HIGH`/`DEDUP_LOW`,
   `flow dedup --reset --run` (only while nothing is delivered).

**Accepted as is (operator, 2026-10-03):** two pilot flow sources run pure
`listener` (they lose posts while the service is down), and
`LLM_FALLBACK=openrouter` has no key (when the Gemini quota runs out TheFlow
waits for the reset). `flow preflight` reports both as warnings; neither is
critical.

**Useful any time:** taxonomy v2 does not re-enrich old verdicts —
`flow requeue --status enriched` does, at a quota cost. Labels live in
`knowledge_examples`: `flow knowledge export --out kb.jsonl` before moving
instances, `flow knowledge import kb.jsonl` after. Reddit needs
`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` (unauthenticated requests get
403).

## Open questions

- `sources.json` does not list every source in the database: nine classic
  sources exist only in `pot.sqlite` (`node src/cli.js list` shows them). `npm run seed`
  leaves them alone, but `seed:fresh` would delete them — add them to the
  file before ever running it.
- Why has one polling pilot source's checkpoint not advanced since
  2026-05-01 — dead channel, or broken polling? (ROADMAP §1.2, §11)
- The VPS app-root path, to finish `ecosystem.config.cjs` (`cwd`). The first
  deploy (2026-10-06) ran migrate in `/home/Inemuri` and found no database
  there — where the `v4.1.7` service kept its `pot.sqlite` decides it
  (DEPLOYMENT.md "When migrate says No sources table").
- Esports results fall into `other` — a topic of their own, or `steam`?

## Documentation

Everything under `docs/` is English. `docs/.archive/` is git-ignored and holds
retired documents that describe a design never built — do not cite them.

## Session log

The latest entries; older ones are in [SESSION_LOG.md](SESSION_LOG.md).

### 2026-10-04 — the server and routing for the test week

The operator's server was redesigned for TheFlow (config and texts only,
git-ignored): almost every topic behind its own role, role panels by group,
new channels created in the staff category for the test week, the archive
for a dedicated role only. Code for it, generic: routing by source,
`also` rules for a shared codes channel, the status board, `discordapp.js
ids`, placeholder checks in preflight. Nothing was applied: the operator
applies on the VPS with the production bot. A plan with an empty state
(what the VPS will see) adopts everything cleanly and reposts the 9 managed
messages — the old copies are deleted by hand. Then the texts: the delivery
template in Ukrainian with codes, events and diagnostics as embed fields,
role panels as embeds (new generic option), the status board in Ukrainian,
and the server texts plus an announcement in news (git-ignored).

### 2026-10-04 — audit of TheFlow, three fixes

An audit of the whole flow path before the shadow week. Two critical bugs,
both reproduced before fixing: concurrent `findOrCreate` transactions lost a
third of Telegram flow posts to `SQLITE_BUSY` (now `IMMEDIATE`, plus retries
that keep the polling checkpoint), and a provider-reported daily quota was
ignored, which would have turned the pending queue `failed` (now refused and
deferred). Media captions are budgeted to 1024 (`TELEGRAM_PREMIUM`, the
operator has no Premium). `v4.57.3` closed the rest: delivery no longer
resends when the record fails to save, album text comes from the captioned
item, shutdown waits for the tick, triage leftovers cannot block retries,
numeric env vars are validated, and `flow requeue` warns about (or with
`--reset-dedup` erases) old dedup decisions.

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

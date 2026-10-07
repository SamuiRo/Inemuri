> **Role:** Current state and next steps · **Audience:** Anyone starting a session on this project, human or AI

Short by design — read it whole. The full session record is in
[SESSION_LOG.md](SESSION_LOG.md), every version in [CHANGELOG.md](CHANGELOG.md),
per-task status in [theflow/ROADMAP.md](theflow/ROADMAP.md).

## Current state

`v4.59.3`; pushed up to `v4.59.1`. 18 migrations; `npm test` is 625 green
`node --test` cases on a throwaway database (never `database/pot.sqlite`); CI
runs lint, bootstrap, migrate and tests on every push.

| Part | State |
|---|---|
| Classic forwarding | Telegram → Telegram/Discord, unchanged; must keep working through every deploy |
| TheFlow phases 0–5, 1.5 | Built ([THEFLOW.md](THEFLOW.md)). **Live on the VPS since 2026-10-06, delivery on** — every routing rule points at a staff-only test channel, so nothing reaches a public channel yet |
| Phase 6 — news intake | Steps 1–3 built: knowledge base, sitemap/WordPress discovery, headline triage ([theflow/NEWS_INTAKE.md](theflow/NEWS_INTAKE.md)). **Test week running** |
| Taxonomy | `categories.json` v3: 11 topics, 14 signals ([theflow/TAXONOMY.md](theflow/TAXONOMY.md)) |
| Delivery | Template in Ukrainian, Discord embeds with codes/event fields (DELIVERY.md "The template"); routing by source and `also` rules; ads (`is_ad`) → `#unsorted`; posts not in Ukrainian translated; `filters.min_length` |
| Status board | On (`v4.58.0`): silent sources and channels, one message edited in place in the staff `status` channel |
| discordapp | In production with the production bot ([DISCORDAPP.md](DISCORDAPP.md), [PROVISIONING.md](PROVISIONING.md)); the operator's server redesign applied 2026-10-06; one piece not run live: `/export-chats` to Telegram |

**The VPS** runs `v4.59.1` under pm2 since 2026-10-06. Its database is new
(`npm run setup -- --new`): sources from `sources.json`, no TheFlow history
before that day, polling started from the deploy. The old `v4.1.7` database
was not migrated — it held only sources and polling positions. Deployment
data is copied by hand; none of it travels with `git pull`
([DEPLOYMENT.md](DEPLOYMENT.md)).

**Dev copy** (this machine): the same configs; the corpus here (pilot
posts from 2026-04 onwards) is not on the VPS. Its provisioning state still
points at messages the test bot posted — the server is now managed from the
VPS, so do not apply from here.

## Configuration layout

Deployment data is git-ignored (the repository is public) and read through
`src/config/localConfig.js`; a missing file falls back to its tracked
`*.sample.json` with a `[CONFIG]` warning, a malformed one stops the start.

| Local (ignored) | Sample (tracked) | Holds |
|---|---|---|
| `sources.json` | `sources.sample.json` | Sources: channels, filters, replacements, `flow`, `feed`, `poll_interval_min` |
| `routing.json` | `routing.sample.json` | `unsorted_destinations`, `routing`, `health_destinations`, `digest_destinations`, `status_destinations` |
| `triage.json` | `triage.sample.json` | Headline-triage reader profile (NEWS_INTAKE.md §5) |
| `cronjob.config.json` | `cronjob.config.sample.json` | Cron job destinations |
| `discordapp/servers/*.json`, `messages/**` | `*.sample.*` | discordapp server configs and texts |

`categories.json` is tracked: taxonomy only, neutral examples. **Never in
git:** channel lists and ids, filters, routing, the triage profile, server
configs, the operator's example posts (knowledge JSONL under `database/`).
Public outlets (NYPost, PsyPost, Reuters) are fine as examples.

## Next steps

1. **The test week (on the VPS, from 2026-10-06).** Daily: read the staff
   test channels and `#unsorted` (what lands there and why — the reason is in
   each post), the `status` message, `node src/cli.js flow stats`,
   `flow triage stats` and `flow triage review`. The per-channel filters were
   checked offline against the operator's good/bad examples, not against
   live traffic — watch for good posts cut and noise let through.
2. **After the week:** tune `triage.json` (bump its version), set the market
   cap and corroboration rules (NEWS_INTAKE.md §5); decide where `tools`
   goes; move the game channels, `claims`, VOYAGE, HARBOR and SANCTUARY out
   of the staff category into their places with their roles and panel
   buttons (the plan is in the operator's server skill); route the `games`
   and `steam` topics, which still fall to `#unsorted`.
3. **Deduplication thresholds** once several sources produce:
   `node src/cli.js flow dedup --pairs 30`, then `DEDUP_HIGH`/`DEDUP_LOW`.
   **Delivery is on, so `flow dedup --reset` (and `flow requeue
   --reset-dedup`) are refused once a cluster is delivered** — new thresholds
   apply to new posts only.
4. **Phase 6 step 4** — article text for what passed triage (JSON-LD
   `articleBody` → `<p>`), plus the sampled rejects (ROADMAP §14.4).
5. **Sources for Nikke and Genshin** — their test channels exist and wait for
   Telegram sources and a `when.source` rule each.

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

- On the dev copy, nine classic sources exist only in `pot.sqlite`, not in
  `sources.json` (`node src/cli.js list` shows them). The VPS database was
  built from `sources.json`, so they are **not on the VPS** — check whether
  any of them should be, and add them to the file.
- Why had one polling pilot source's checkpoint not advanced since
  2026-05-01 — dead channel, or broken polling? The status board on the VPS
  now answers it: a dead channel shows up as silent. (ROADMAP §1.2, §11)
- Esports results fall into `other` — a topic of their own, or `steam`?

- `package.json` says `"license": "ISC"`, the `LICENSE` file is MIT — the
  operator decides which is meant (README now just points to `LICENSE`).

## Documentation

Everything under `docs/` is English. `docs/.archive/` is git-ignored and holds
retired documents that describe a design never built — do not cite them.
`theflow/ROADMAP.md` keeps its section numbers (code comments cite them);
done work is a line per task there, details in CHANGELOG.

## Session log

The latest entries; older ones are in [SESSION_LOG.md](SESSION_LOG.md).

### 2026-10-07 — documentation audit

Every document checked against the code. Fixed what was wrong: README's
quick start (`npm run seed` on an empty database → `npm run setup`), the
ARCHITECTURE repo map (a dozen missing modules, a non-existent file), the
LLM gateway contract (six methods, quota per `provider:model`, consumers),
TAXONOMY's v1-era example and the resolve order (`ad`), DEDUPLICATION's
"Discord edit needs adding", DATA_MODEL's missing tables and migrations,
media.md's file-size limit, NEWS_INTAKE's unbuilt entity allow-list and
`body` knob, DISCORDAPP's status. Removed what was history or repetition:
ROADMAP 1545 → ~400 lines (section numbers kept), DATA_MODEL's per-migration
prose (now a table), DISCORDAPP's work plan, DEPLOYMENT's one-off rollout
procedures (now one "Turning on TheFlow features"). Found, not fixed: the
license mismatch above; `src/config/appearance.config.json` is read by
nothing.

### 2026-10-06 — deployed: TheFlow live on the VPS

The VPS moved from `v4.1.7` to `v4.59.1`. The first `npm run migrate` ran
in a directory with no database and failed opaquely; `v4.58.1`–`v4.59.0`
made migrate explain an empty database and added `npm run setup`, and the
VPS database was built new with it. The server redesign was applied with the
production bot; the first apply failed on the 7 messages the test bot had
posted (another bot's panels, another bot's persona webhook) — `v4.59.1`
reposts those instead, and explains a missing Apply button. Routing ids
filled from `discordapp.js ids`, delivery on to the staff test channels,
status board on. `v4.59.2`: `ecosystem.config.cjs` runs from its own
directory, docs brought to the deployed state.

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

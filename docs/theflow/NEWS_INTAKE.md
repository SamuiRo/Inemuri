# TheFlow — news intake and the knowledge base

> Related: [ROADMAP.md](ROADMAP.md) §14 · [DATA_MODEL.md](DATA_MODEL.md) ·
> [DEDUPLICATION.md](DEDUPLICATION.md) · [TAXONOMY.md](TAXONOMY.md)

Goal: read the large news outlets — NYPost, Reuters, CNBC and the like — and
deliver **only what matters** (in the first place, what moves markets), with the
key facts extracted. Most of what these outlets publish is irrelevant here and
must never reach a channel. Republishing articles is explicitly **not** a goal.

Phase 3.5 reads RSS/Atom (`src/sources/feeds/`). This document adds three
things on top of it: more ways to discover articles, a cheap triage before any
article is fetched, and a portable knowledge base the triage and the enrich
prompt learn from. **Built:** steps 1–3 (§4). **Not built:** article fetch
(step 4) — today a passed article becomes a post with its headline and
teaser only.

## 1. What the outlets actually give — measured 2026-10-03

One probe from the dev machine against 31 outlets, with an honest bot
User-Agent: the RSS item length, `robots.txt` → news sitemap, `/wp-json/wp/v2/posts`,
and whether the article page returns its text. A 403 may differ from another IP,
but the overall picture holds.

**Roughly two thirds of RSS feeds carry only a teaser (100–200 characters).**

| Group | Outlets | What we get |
|---|---|---|
| A. Full text in RSS | Fox News, Fox Business, Business Insider, Axios, ZeroHedge | 3–5k characters per item; nothing else to fetch |
| B. Teaser in RSS, page open | NYPost, CNBC, BBC, Guardian, Al Jazeera, CoinDesk, DW, Kyiv Independent, The Verge, TechCrunch | Text from the page: JSON-LD `articleBody` or plain `<p>` (2.5–7k characters) |
| C. Open WordPress JSON API | The Hill (page itself 403), TechCrunch | Full text as clean JSON. Rare: NYPost runs WordPress but its API answers 401 |
| D. No RSS, news sitemap open | Reuters | `news:title` and date; pages answer 401 |
| E. Page closed or paywalled | Bloomberg, FT, NYT, AP, Forbes, Politico, Seeking Alpha, Investing; WSJ, MarketWatch, WaPo truncated | Headline and teaser from RSS or the sitemap only |

Two consequences shape the design:

- **The most market-relevant outlets are in group E.** Their headlines are wire
  style and carry most of the signal; the full story nearly always appears in a
  group A/B outlet too. Deduplication (phase 3) joins them: the cluster gets the
  headline from the closed source and the body from the open one. We never work
  around a 403, a paywall or a CAPTCHA — a closed page means headline only.
- **The news sitemap is the main find.** Nearly every outlet has one, including
  those without RSS, and an entry carries `news:title`, `news:publication_date`,
  often `news:keywords`, and the URL shows the section:

  ```text
  /2026/10/03/betting/alabama-vs-mississippi-state-prediction-...
  <news:keywords>college football betting, sports betting, ...
  ```

  So most of the noise can be dropped **before** an article is fetched.

### Volume

A news sitemap covers about 48 hours: **200–400 articles a day per large
outlet**, 5–8k headlines a day for 20 outlets, over 90% irrelevant. Fetching every
article would add 30–40 MB a day and reach the 2 GB storage review point
(ROADMAP §13.9) in about two months, almost all of it sport and horoscopes. Hence
the rule this whole design follows: **triage on the headline first, fetch after.**

## 2. Pipeline

```text
1. Discovery   rss | sitemap | wpjson  ->  candidate {url, title, keywords, section, published_at, teaser}
2. Triage      section deny-list rule + batched LLM over headlines (~50 per call)
3. Fetch       (step 4, not built) only what passed, plus a small share of the rejected
               body: feed full text -> wpjson -> JSON-LD articleBody -> <p> -> teaser only
4. Enrich      the existing enrich + entity extraction
5. Delivery    the existing FlowDelivery
```

### 2.1 Configuration — one platform, two knobs

No platform per site. A news source is one `rss` entry in `sources.json` with
two independent settings in `feed`:

| Key | Values | Meaning |
|---|---|---|
| `discovery` | `rss` · `sitemap` · `wpjson` | Where the list of new articles comes from (built) |
| `body` | `feed` · `page` · `wpjson` · `none` | Where the article text comes from, after triage (planned, step 4) |

Adding an outlet is a config entry, never code. Polling starts at 5 minutes
(`poll_interval_min`, migration 006; ETag/304 is already in `fetchFeed`) and is
widened per source once a week of data shows how many new articles an hour it
really produces.

### 2.2 Candidates do not go into `posts`

Candidates live in a light `discovered_items` table (url, title, keywords,
section, triage verdict, short retention — 14 days). Only what passes triage
becomes a post. The corpus stays meaningful, deduplication and search work on
real posts, and the storage budget is spent on signal.

### 2.3 Triage

Cheap by construction: 6k headlines a day in batches of 50 is about 120 calls a
day. The rule runs first and costs nothing — a narrow section deny-list
(`/sports/`, `/betting/`, `/shopping/`…; why it stays narrow is in §5). An
entity allow-list (tickers, central banks, commodities) was considered and
not built: the model decides everything the deny-list does not. Examples for
the triage prompt come from the knowledge base (`headline` and `post` levels).

**A share of the model's rejects is flagged for review** (`sampled`, 5%):
without negatives, nothing ever tells the triage it was wrong to drop something.

### 2.4 Fetch and etiquette (step 4, planned)

Honest User-Agent with a contact, `robots.txt` respected, the per-host
`HostThrottle` shared with the feeds. Text extraction order is the table in §2
step 3; the first one that yields enough text wins. A 401/403 page is recorded
once and the source falls back to `body: none` for that host — never a retry
with a disguised client. Full text is kept for analysis; channels get the
headline, our own summary and the link, never the article.

## 3. Knowledge base — `knowledge_examples`

### 3.1 Why a separate table

`post_feedback` holds `post_id + verdict + note`, and few-shot read the text by
joining to `posts`. The labels are therefore **not self-contained**: lose or prune
`posts`, or move to another instance, and the labels are left without content.
That knowledge is the most expensive data in the system — it is human time — so
it gets its own table that carries everything needed to use it, and can be
exported and imported between instances.

`post_feedback` stays what it is: the append-only event log of reviews. The
knowledge base is the curated, portable layer built from it.

### 3.2 Fields

| Field | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Local only, never exported |
| `uid` | STRING(36) UNIQUE NOT NULL | Stable identity across instances (UUID). Import is an upsert by `uid`, so it can be repeated |
| `content_hash` | STRING(64) NOT NULL | sha256 of the normalized level + title + body. Groups labels of the same content: the latest one wins |
| `level` | STRING NOT NULL | `post` — a whole post (Telegram message, feed item); `headline` — title only, what triage sees; `article` — full article text |
| `verdict` | STRING NOT NULL | Same vocabulary as `post_feedback`: `good` · `noise` · `wrong_topic` · `missed` |
| `reason` | TEXT | **Why** it matters or is noise. The most useful field for the LLM |
| `title` | TEXT | Snapshot |
| `body` | TEXT NOT NULL | Snapshot of the source text (`raw_text`, `text_ocr` merged) |
| `text_en` | TEXT | Snapshot of the canonical English text, when there was one |
| `url` | STRING | Link to the original, when public |
| `source_name` | STRING | Human name of the source, not its id — ids are per instance |
| `platform` | STRING | `telegram` · `rss` · `reddit` · … |
| `published_at` | DATE | When the source published it |
| `topic`, `signal_type` | STRING | The classification the label refers to |
| `extracted` | JSON | Entities and extracted values, when there were any |
| `taxonomy_version` | INTEGER | Which `categories.json` the topic belongs to — a year later, after the taxonomy changes, old labels still read correctly |
| `origin` | STRING NOT NULL | `review` · `sampled_reject` · `manual`. Kept on import |
| `post_id` | INTEGER | Local link to the post, `SET NULL`. Never exported |
| `feedback_id` | INTEGER UNIQUE | Local link to the `post_feedback` row it came from. Makes the backfill idempotent. Never exported |
| `created_at` | DATE NOT NULL | When the label was made. Preserved on import. Rows are immutable — no `updatedAt` |

What the verdicts mean for relevance: `good`, `wrong_topic` and `missed` say the
content **matters** (with the right or the wrong classification); `noise` says it
does not. Triage reads them that way; enrich reads the classification.

### 3.3 Write paths

- `flow review` writes the `post_feedback` row and the knowledge row in one
  transaction (`recordLabel`).
- Migration `015` creates the table and backfills every existing
  `post_feedback` label that still has its post. Backfill is idempotent through
  `feedback_id` and can be rerun: `flow knowledge backfill`.
- `flow triage review` writes `level: headline` rows; `flow knowledge import`
  brings `origin: manual` examples. `article` rows wait for step 4.

### 3.4 Few-shot reads the knowledge base

`FewShot.js` loads examples from `knowledge_examples`, not from the join. The
snapshot is also more correct than the join was: after `flow requeue` the post's
current topic may differ from the verdict that was labelled, and the snapshot
keeps the labelled one. Selection rules are unchanged — the latest label per
`content_hash` wins, `good` diverse by signal first, `wrong_topic` only with a
reason.

### 3.5 Export and import

```text
node src/cli.js flow knowledge stats
node src/cli.js flow knowledge export [--out file.jsonl] [--level post,headline] [--verdict good,noise]
node src/cli.js flow knowledge import <file.jsonl> [--dry-run]
node src/cli.js flow knowledge backfill
```

The file is JSONL. The first line is a header, every following line one example:

```json
{"format":"inemuri.knowledge","version":1,"exported_at":"2026-10-03T12:00:00.000Z","count":2}
{"uid":"…","level":"post","verdict":"good","reason":null,"title":null,"body":"…","text_en":"…","url":null,"source_name":"…","platform":"telegram","published_at":"…","topic":"steam","signal_type":"promo_code","extracted":null,"taxonomy_version":1,"origin":"review","created_at":"…"}
```

- Local ids (`id`, `post_id`, `feedback_id`) are never exported, and neither is
  `content_hash`: it is derived, recomputed on import, so a file cannot
  disagree with its own content.
- Import validates the header and every record and reports bad lines by number
  without stopping; valid records are upserted by `uid`. An existing `uid` is
  left as is — rows are immutable — so importing the same file twice changes
  nothing.
- An unknown `version` is refused rather than guessed at.

## 4. Order of work

| Step | What | Version |
|---|---|---|
| 1 | `knowledge_examples` + export/import + backfill from `post_feedback`; few-shot reads it — **done (v4.52.0)** | minor |
| 2 | Discovery through `sitemap` and `wpjson` as settings of the existing poller — **done (v4.53.0)** | minor |
| 3 | `discovered_items` + triage (rules + batched LLM over headlines) — **done (v4.54.0)** | minor |
| 4 | Article fetch (JSON-LD → `<p>`) for what passed triage, plus the sampled rejects | minor |
| 5 | Alert on silent sources, poll intervals tuned from real data | patch — the alert half is the status board (v4.58.0, every source, not only news); intervals open |

Step 1 comes first: it changes nothing visible, and without it triage would have
nothing to learn from.

### What step 2 found live (2026-10-03)

NYPost's news sitemap 599 items, Reuters through its sitemap index 50 (the
first child is the freshest), NYT's `.xml.gz` 714, Fox 243 (no news
extension, so titles come from the URL slug), The Hill and TechCrunch through
the WordPress API 25 each, NYPost's WordPress API 401 — the poller backs off
as for any closed feed.

**Not every endpoint sends an ETag.** NYPost's sitemap and both WordPress APIs
do not, so each poll downloads the whole response — a few hundred KB for a
large sitemap, tens of MB a day per outlet at 5 minutes. That is what step 5
widens intervals for. A source without triage still ingests every new
article; its `filters.blacklist` can match URL sections (`/betting/`).

## 5. What is valuable — the interest profile

The profile is one reader's interests, which makes it deployment data, not
code: it lives in `src/config/triage.json`, **git-ignored** like
`sources.json`. The repository carries `src/config/triage.sample.json` — the
same shape with a neutral example — and a fresh clone falls back to it with a
`[CONFIG]` warning. The shape:

| Key | What it holds |
|---|---|
| `areas` | What the reader wants, one description per area — the triage prompt's core |
| `values` | What makes an item worth it inside an area (a concrete finding, evidence behind an opinion…) |
| `noise` | What the reader never wants |
| `deny_sections` | Site sections dropped by rule, before any model call |
| `version` | Bumped on every edit; recorded on each decision (`profile_version`) |

The operator's own example posts go into the knowledge base as
`origin: manual` from a git-ignored JSONL (`flow knowledge import`, §3.5) —
they are third-party text and personal taste, so they never enter the
repository either. Areas of the profile line up with the taxonomy topics
(`health`, `mind`, `money`, `markets`), but nothing requires it.

### Lessons the first profile taught the design

- **Valuable usually means a concrete finding** — a study, data, a number —
  that is practical or goes against the usual view. Honest limits ("64
  people") are a plus. An opinion piece counts only when it rests on
  evidence, which a headline cannot show: that check belongs to the
  full-text verdict.
- **The section deny-list must stay narrow.** NYPost's sitemap over two days:
  `sports` 192, `betting` 30, `shopping` 15, `real-estate` 9, `ticket-sales` 4
  — 43% of everything, safely dropped by rule. But a wanted article can sit in
  an unexpected section such as `/lifestyle/`, so sections are dropped by rule
  only when nothing in them can match the profile; the rest goes to the model.
- **Section feeds before whole-site discovery.** Many outlets publish a feed
  per section (`nypost.com/health/feed/`, `/business/feed/`). For an interest
  that lives in one section, the section feed is a publisher-side filter for
  free — about 5 articles a day instead of 300 to triage.
- **PsyPost** is group A: its RSS carries the full text (`content:encoded`,
  ~10k characters), and its WordPress API is open.
- **Two stages, different strictness.** Headline triage is generous — a
  missed article is gone for good, a false pass costs one fetch. The verdict
  after the full text (enrich) is strict.
- **The taxonomy needed a v2**: topics `health`, `mind`, `money`, `markets`,
  signals `research` and `report` (TAXONOMY.md, Versioning).

### Markets: calibrating so it does not spam (open)

The operator's own caveat — market news must not flood the stream. None of
this is built yet; the plan:

1. **Materiality rules, not a score.** Pass only defined event kinds, in
   **both directions** (operator, 2026-10-03: a surge matters as much as a
   crash): a sharp move of a widely known company, record results, guidance
   raised or cut, bankruptcy or default, a large layoff, a CEO exit, a fraud
   probe, a central-bank decision, CPI or jobs data. "Shares rose 2%" is never
   news.
2. **Corroboration.** A market story in one outlet waits; in two or more
   (a dedup cluster of size ≥ 2) it passes. Wire headlines from the closed
   outlets (§1) count as corroboration.
3. **A daily cap** for the market area; above it, the digest instead of the
   stream.
4. **Measure first.** The test week (from 2026-10-06, delivery to staff-only
   channels) produces the labels — `flow triage review`, `flow review` — that
   the rules and the cap are set from.

## 6. Step 3 as built

Decided 2026-10-03: 5% sampled rejects, taxonomy v2 topics `health`, `mind`,
`money`, `markets` (to be refined later), and the outlet list — NYPost
(sections `health`, `business`, `lifestyle` as feeds, or the sitemap with the
deny-list), PsyPost, Fox Business, Business Insider, CNBC, The Guardian, The
Hill, Reuters (headlines).

**Turning it on for a source:** `"feed": { "discovery": "sitemap", "triage":
true }` on a flow-enabled `rss` source (the seeder refuses triage without
`flow.enabled`). Every new article of such a source goes to
`discovered_items` instead of `posts`.

| Part | Where | What |
|---|---|---|
| Profile | `src/config/triage.json` | Areas, values, noise, `deny_sections` (§5). Git-ignored; `triage.sample.json` is the tracked example. Edit the text and bump `version` |
| Queue (ingest side) | `triage/TriageQueue.js` | A new article → a row; a deny-listed section is rejected at once (`decided_by: rule`). No network |
| Stage (worker side) | `triage/TriageStage.js` | Runs first in the enrich worker's tick: ~50 pending headlines → `gateway.triage()` → `passed` / `rejected`; a pass becomes a post through the feed poller (`promote`) and is enriched in the same tick |
| Prompt | `services/ai/prompts/triage.js` | Profile in the system prompt; headlines and examples as nonced data; closed `area` enum; an entry the model skipped stays pending, three misses → `failed` |
| Examples | `triage/examples.js` | From the knowledge base, levels `headline` and `post`: `good` / `missed` = wanted, `noise` = not |
| Review | `flow triage review` | Passes and sampled rejects; "would you want to read it?" → a `headline` label: `good`, `missed` (the model was wrong to reject), `noise` |
| Stats | `flow triage stats` | Outcome, per source pass rate, areas, rule reasons, what is left to review |

Operational knobs (`FLOW_TRIAGE` in `app.config.js`): `FLOW_TRIAGE_BATCH`
(50), `FLOW_TRIAGE_MAX_WAIT_MIN` (20 — a partial batch waits this long, so
trickling news does not cost a call per tick; ~90 calls a day for ten
outlets), `FLOW_TRIAGE_SAMPLE` (0.05), `FLOW_TRIAGE_RETENTION_DAYS` (14).

### First live run (2026-10-03)

The NYPost news sitemap, 596 items: **252 dropped by rule** (sports, betting,
shopping, real estate) at no cost; the next 50 sent in one call to
`gemini-3.5-flash-lite` — schema accepted, 50/50 decided, ~5.7 s. **3–4 of 50
passed** (an FDA outbreak source, a $1M diamond find, an AI-policy opinion);
the rest were rejected with sensible reasons (crime, politics, accidents).
After the run the profile gained `values` (§5) — an opinion counts only when
it rests on evidence — but from a headline the model cannot see the evidence,
so such a piece may still pass; the full-text verdict (step 4) is the strict
one. Calibration is the test week's job, not two calls'.

## 7. Still open

- **The test week** (on the VPS from 2026-10-06) — `flow triage stats` and
  `flow triage review` daily, then tune `triage.json` (bump `version`), the
  market rules and cap (§5).
- **Step 4** — article fetch for what passed, plus the sampled rejects.
- **Step 5** — poll intervals per source from real volume.

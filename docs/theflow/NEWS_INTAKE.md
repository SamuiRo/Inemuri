# TheFlow — news intake and the knowledge base

> Related: [ROADMAP.md](ROADMAP.md) §14 · [DATA_MODEL.md](DATA_MODEL.md) ·
> [DEDUPLICATION.md](DEDUPLICATION.md) · [TAXONOMY.md](TAXONOMY.md)

Goal: read the large news outlets — NYPost, Reuters, CNBC and the like — and
deliver **only what matters** (in the first place, what moves markets), with the
key facts extracted. Most of what these outlets publish is irrelevant here and
must never reach a channel. Republishing articles is explicitly **not** a goal.

Phase 3.5 already reads RSS/Atom (`src/sources/feeds/`). This document adds three
things on top of it: more ways to discover articles, a cheap triage before any
article is fetched, and a portable knowledge base the triage and the enrich
prompt learn from.

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
2. Triage      rules (section deny-list, entity allow-list) + batched LLM over headlines (~50 per call)
3. Fetch       only what passed triage, plus a small random share of the rejected (for learning)
               body: feed full text -> wpjson -> JSON-LD articleBody -> <p> -> teaser only
4. Enrich      the existing enrich + entity extraction, on the full text
5. Delivery    only signals above the threshold (the existing FlowDelivery)
```

### 2.1 Configuration — one platform, two knobs

No platform per site. A news source is one `sources.json` entry with two
independent settings:

| Key | Values | Meaning |
|---|---|---|
| `discovery` | `rss` · `sitemap` · `wpjson` | Where the list of new articles comes from |
| `body` | `feed` · `page` · `wpjson` · `none` | Where the article text comes from, after triage |

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
day. Rules run first and cost nothing — a section deny-list (`/sports/`,
`/betting/`, `/lifestyle/`, `/newsletters/`…) and an allow-list of entities
(tickers, central banks, commodities). The LLM sees only what the rules did not
decide. Examples for the triage prompt come from the knowledge base at
`level: headline`.

**A share of the rejected is fetched anyway** (`sampled_reject`, starting at 5%):
without negatives, nothing ever tells the triage it was wrong to drop something.

### 2.4 Fetch and etiquette

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
- Later steps add `origin: sampled_reject` (triage) and `level: headline` /
  `article` rows.

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
| 2 | Discovery through `sitemap` and `wpjson` as settings of the existing poller | minor |
| 3 | `discovered_items` + triage (rules + batched LLM over headlines) | minor |
| 4 | Article fetch (JSON-LD → `<p>`) for what passed triage, plus the sampled rejects | minor |
| 5 | Alert on silent sources, poll intervals tuned from real data | patch |

Step 1 comes first: it changes nothing visible, and without it triage would have
nothing to learn from.

## 5. Open before step 3

- **What counts as market-moving** — US equities, crypto, commodities, macro
  (Fed, CPI), geopolitics? This sets the rules and the triage prompt.
- **The outlet list** — the groups above, or others.
- **The share of sampled rejects** — 5% to start.

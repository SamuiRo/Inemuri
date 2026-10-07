# TheFlow — deduplication and the `linked` mechanism

> Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATA_MODEL.md](DATA_MODEL.md)

Goal: an event that five channels wrote about, in different words and different
languages, appears in the output **once** — without losing what the later posts
added.

## Base rule: first-wins

The first post about an event is published immediately, with no hold window.
Later posts do not create new messages; they **append** to what was already sent.

Why not wait: promo codes and limited offers expire, and material worth
publishing is most valuable while fresh. A ten-minute delay in exchange for
completeness is a bad trade for most categories.

The cost of this choice: **the first post is usually the worst one**. The
fastest channel writes short, context-free, often clickbait copy. That is
exactly what the `linked` mechanism compensates for.

## Why deduplication cannot be handed to an LLM

"Is this post similar to these 50 from the last few days?" cannot be asked of a
model directly:

- expensive — every post against the whole window;
- non-deterministic — the same post is a duplicate today and not tomorrow;
- does not scale — the window grows, the prompt grows.

Retrieval is done by math. The model only touches what math could not settle.

## Three tiers

### Tier 1 — exact entity match

The cheapest and most reliable. Runs **before** any vectors.

| Key | Example |
|---|---|
| Promo code | `HY45OLK8QRE2` from five channels collapses via one `WHERE code = ?` |
| Normalized URL | the same link to the original source |
| `text_hash` | a word-for-word repost |
| Ticker plus date | `$ABC` plus a listing date — key `evt:ABC:2026-10-05`, built only from a ticker found in the text and an event date whose words were found in the text (phase 4) |

Cost: **0 requests**, 100% precision. It covers the promo code case completely,
which is why entity extraction (phase 4) strengthens deduplication
significantly.

Two rules keep that precision in the implementation (`dedup/DedupCore.js`):

- **Only verified codes are keys.** A code found only in an image transcription
  (`verified: false`) never collapses posts — a misread would merge unrelated
  events.
- **Boilerplate URLs are not keys.** A link a source puts into three or more
  posts within 14 days — its signature, its own channel, a referral — would
  otherwise merge everything that source writes.

URLs are normalized first: lower-case host without `www.`/`m.`, no fragment,
no `utm_*` or other tracking parameters, sorted query, no trailing slash,
`youtu.be/ID` as `youtube.com/watch?v=ID`.

### Tier 2 — embeddings and cosine over a window

```text
vector of post B  x  vectors of posts in the window (same topic)
        |
maximum similarity s
        |
s >= HIGH  -> duplicate or linked (see below)
s <= LOW   -> new event
LOW < s < HIGH -> gray zone
```

**Tier 2 compares against other sources only** (unless
`DEDUP_TIER2_SAME_SOURCE=true`). The first run on real posts, all from one
channel, merged nine pairs at `s` 0.90–0.95 and every one was wrong: giveaways
of different items and results of different tournament days written from the
channel's own template. The embedding sees the template and barely sees the
item name. A close post from the same channel is the next issue of a series;
the case tier 2 exists for is the same event reported by another channel. The
nearest same-source `s` is still logged (`s_same_source`).

Because the comparison runs on `text_en` rather than the original, **the
threshold does not drift between languages**: a Korean and an English post
about the same event sit close together after canonicalization. This is the
main payoff of the "translation first" decision.

Thresholds (`DEDUP_HIGH`, `DEDUP_LOW`) are **not calibrated yet** — they
need cross-source pairs from the corpus (ROADMAP §6.8,
`flow dedup --pairs 30`):

| Threshold | Current | Consequence of getting it wrong |
|---|---|---|
| `HIGH` | 0.90 | Too low collapses distinct events and you lose news |
| `LOW` | 0.75 | Too high lets duplicate spam through |

Once anything is delivered, `flow dedup --reset` is refused, so new
thresholds apply to new posts only.

Computation is brute-force cosine over the window. A few thousand vectors take
single-digit milliseconds in a plain JavaScript loop. No vector database
required.

### Tier 3 — LLM adjudication of the gray zone (not built)

Planned for `LOW < s < HIGH` only — a few percent of traffic. **Until it
exists, the gray zone is a new event** with `dedup.gray = true`, counted by
`flow dedup`. Publishing a duplicate is annoying; swallowing a real story is
worse. Build it once the logs show how much traffic the gray zone carries.

## Deduplication window

A single global window does not work: a promo code is current for hours, market
analysis for days. The window is set per **signal** in `categories.json`, and a
source can override it via `flow.dedup_window_hours`.

| Signal | Window |
|---|---|
| `outage`, `security` | 6 h |
| `promo_code`, `freebie`, `giveaway_result`, `stream`, `meme` | 24 h |
| `event`, `launch`, `patch`, `report` | 48 h |
| `analysis`, `opinion`, `research` | 72 h |

A hack is news for hours, not days: a fresh report about the same exchange a
week later is a different incident, which is why `security` shares the short
window with `outage`.

A cluster with `closed: true` accepts no new members.

## The `linked` mechanism

Applies when post B is found to concern an event A that was already published.

### Step 1 — cheap gate, no AI

First, check whether B **can** add anything at all. This is plain arithmetic
over fields that already exist:

```text
richness(post) = length of text_en
               + number of links
               + number of figures and dates
               + number of extracted entities
               + presence of media
```

If `richness(B) <= richness(A) * 1.15` **and** B's entity set adds nothing to
A's, stop here:

```text
link_role = 'duplicate'
status    = 'suppressed'
clusters.members_count++
```

No AI call. Most duplicates are filtered out at this step.

### Step 2 — the delta call

Only for posts that passed the gate. The model receives **both texts** — the
canonical one and the new one — and states what the new one asserts beyond the
old:

```json
{
  "relation": "adds",
  "adds": [
    { "kind": "date",   "text": "event starts March 14, 09:00 UTC" },
    { "kind": "detail", "text": "reward doubled for first 1000 players" }
  ],
  "confidence": 0.82
}
```

`relation` is a closed enum:

| Value | Meaning | Action |
|---|---|---|
| `same` | The same thing in different words | `duplicate`, suppressed |
| `adds` | Adds detail | `linked`, appended to the sent message |
| `corrects` | Refines or corrects the earlier post | `correction`, **always delivered** |
| `denies` | Retracts the event entirely | `correction`, **always delivered**, cluster closed |

The result is written to `posts.adds` (`relation`, `adds[]` with `kind`,
`text` and `text_uk`, `confidence`, `model_used`; after delivery also
`applied_at` and what was done to each message). Implemented in
`prompts/delta.js`, `LLMGateway.delta()` and `dedup/DeltaStage.js`. A
`security` post answered `same` stays `linked` — counted, never suppressed.

### Step 3 — delivering the addition

Every delivered copy in `clusters.delivered` is re-rendered whole and edited
through the adapter's `editMessageData()` (Telegram and Discord) — the
mechanism is in [DELIVERY.md](DELIVERY.md). Rules:

- **Cap on additions.** At most three (`MAX_APPENDS`) per cluster are edited
  in; after that only the counter grows.
- **A failed edit is not a failed delivery.** Message deleted, permissions lost
  — fall back to a reply carrying the re-rendered message.
- **`corrects` and `denies` are never suppressed**, cap or no cap: they are
  edited in **and** sent as a reply, because an edit notifies nobody. The worst
  failure of this system is a cancelled event with a cheerful announcement
  still standing.
- **`security` is never suppressed** — a `same` answer keeps it `linked`.

### Replacing the canonical post

If `richness(B)` is at least twice `richness(A)`, B becomes the canonical
(`clusters.canonical_post_id`, `richness` updated) and a delivered message is
rewritten from it.

## What to log

`posts.dedup` (migration `011`), reported by `node src/cli.js flow dedup`.
Without this, thresholds cannot be tuned:

- the similarity value `s` behind every decision;
- which tier made the decision;
- `relation` and `adds` for every `linked` post;
- how many posts collapsed per day, per category.

That last metric is the main health indicator. If too many collapse, `HIGH` is
too low and news is being lost.

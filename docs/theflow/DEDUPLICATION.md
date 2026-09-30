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

Starting threshold values — these must be verified against real phase 0 data,
they are not constants to take on faith:

| Threshold | Start | Consequence of getting it wrong |
|---|---|---|
| `HIGH` | 0.90 | Too low collapses distinct events and you lose news |
| `LOW` | 0.75 | Too high lets duplicate spam through |

Computation is brute-force cosine over the window. A few thousand vectors take
single-digit milliseconds in a plain JavaScript loop. No vector database
required.

### Tier 3 — LLM adjudication of the gray zone

Only for `LOW < s < HIGH`. That is a few percent of traffic, not the whole
stream.

**Until tier 3 is enabled, the gray zone is treated as a new event** and flagged
for review. Publishing a duplicate by mistake is annoying; swallowing a real
story by mistake is considerably worse.

## Deduplication window

A single global window does not work: a promo code is current for hours, market
analysis for days. The window is set per category in `categories.json`, and a
source can override it via `flow.dedup_window_hours`.

| Category | Starting window |
|---|---|
| `promo_code`, `freebie` | 24 h |
| `event`, `launch`, `patch` | 48 h |
| `analysis`, `opinion` | 72 h |
| `outage`, `security` | 6 h |
| `giveaway_result`, `stream` | 24 h — classified once, routed nowhere |

`security`, `giveaway_result` and `stream` come from the v1 taxonomy drafted
against the real sources — [ROADMAP.md](ROADMAP.md) appendix A. A hack is news
for hours, not days: a fresh report about the same exchange a week later is a
different incident, which is why `security` shares the short window with
`outage` rather than the analysis window.

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

```text
clusters.delivered  ->  for each destination
        |
editMessage(channel, message_id, text + addition block)
        |
clusters.appends_count++
```

Rules to build in from the start:

- **Cap on additions.** Past `appends_count >= 3`, stop appending — the message
  becomes unreadable. Only the counter continues.
- **Length cap.** If an addition would exceed the platform limit, send it as a
  reply to the original instead of editing.
- **A failed edit is not a failed delivery.** Message deleted, permissions lost,
  window expired — fall back to a separate reply.
- **`corrects` and `denies` are never suppressed.** This is the worst possible
  failure of the system: the event is cancelled while a cheerful announcement
  still stands. A retraction is always delivered, even when the addition cap is
  exhausted.

### Replacing the canonical post

If `richness(B)` is substantially higher than `richness(A)` — twice, as a
starting point — B becomes the new canonical:
`clusters.canonical_post_id = B.id` and `richness` is updated. The already-sent
message is **rewritten in full** rather than appended to.

## Platform support

| Platform | Editing | State |
|---|---|---|
| Telegram | `TelegramDestination.editMessage()` | **Already implemented**, `src/destinations/telegram/TelegramDestination.js:751` |
| Discord | — | **Needs to be added** to `DiscordDestination` |

Telegram delivery goes through GramJS (a user MTProto client) rather than the
Bot API, so bot editing restrictions do not apply here. The practical limits for
specific channels are worth verifying during phase 3.

## What to log

Implemented as `posts.dedup` (migration `011`), reported by
`node src/cli.js flow dedup`. Without this, thresholds cannot be tuned:

- the similarity value `s` behind every decision;
- which tier made the decision (1, 2, or 3);
- `relation` and `adds` for every `linked` post;
- how many posts collapsed per day, per category.

That last metric is the main health indicator. If too many collapse, `HIGH` is
too low and news is being lost.

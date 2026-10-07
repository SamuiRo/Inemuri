# TheFlow — pipeline architecture

> Related: [THEFLOW.md](../THEFLOW.md) · [DATA_MODEL.md](DATA_MODEL.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md)

## Why the pipeline is decoupled through the database

The naive implementation inserts AI calls directly into the existing chain:
MTProto event, filter, AI, media download, emit, route. That breaks in three
places at once:

1. **Ingestion starts waiting on the network.** A GramJS event handler holds the
   update loop while the provider responds. Under a burst, everything stalls.
2. **Bursts are unavoidable.** First startup, recovery after downtime, a polling
   cycle with `POLLING_FETCH_LIMIT` across 30 channels — the provider's
   per-minute limit burns through in seconds.
3. **There is nowhere to re-run from.** A prompt for a system like this gets
   refined over months. Without the stored raw text, every prompt change means
   "wait for new traffic and hope".

Decoupling through the `posts` table closes all three and adds retries,
backfill, backpressure when quota is exhausted, and offline re-runs of a new
prompt over history.

## Stage 1 — Ingest

Synchronous, fast, and **makes no outbound network calls**. This is the part
that is never allowed to stop.

```text
parseEvent / parseRaw          (TelegramMessageParser — unchanged)
        |
text_replacements              (MessageFilter.preprocessText — unchanged)
        |
regex stage                    (new — see below)
        |
INSERT posts (status: pending)
        |
ACK — ingestion complete
```

For sources with `flow.enabled: false`, stage 1 ends not with a database insert
but with the current path: keyword filter, media, `EventBus.emit`, routing.

### The regex stage: what happens before the AI

This stage is deterministic and free. Its job is to reduce what reaches the
model and to give the model something to anchor on. Three distinct jobs:

**1. Rejection — the post never reaches the AI**

| Rule | Status |
|---|---|
| Source blacklist (existing mechanism) | `skipped_blacklist` |
| Empty, or shorter than N characters after replacements | `skipped_empty` |
| Emoji only, link only, or service text | `skipped_noise` |
| Short all-caps post (`filters.reject_shouty`, per source) | `skipped_shouty` |
| Shorter than `filters.min_length` without links (per source; promo codes exempt) | `skipped_short` |
| Exact hash match against the last N hours | `skipped_repost` |

Note that the keyword **whitelist** is disabled for TheFlow sources. Channels
that post everything have no useful keywords, and a whitelist there cuts
precisely what the system exists to find. The **blacklist stays** as a cheap
pre-filter.

**2. Candidate extraction — passed into the prompt**

Regex does not decide what something is. It only finds what *looks like* an
entity and hands the model a list to confirm:

| Candidate | Pattern (approximate) |
|---|---|
| Promo code | `[A-Z0-9]{5,20}`, no spaces, contains both a digit and a letter |
| Ticker | `\$[A-Z]{2,10}` |
| Link | standard URL |
| Date or deadline | ISO, `DD.MM`, `until / till / by <date>` |
| Amount or percentage | number with a currency symbol or `%` |

This is the basis of hybrid extraction (below) and gives the model an anchor:
it never has to guess where in the text a code might be, it is shown candidates.

**3. Cheap repost check before any AI call**

The normalized text hash is checked against the same source's posts of the
last `THEFLOW_REPOST_WINDOW_HOURS` (24): a word-for-word repost is
`skipped_repost` without a single AI call. The check is per source on
purpose — the same text on another channel is enriched and joins the event's
cluster in tier 1, so "also reported by N" stays honest.

## Stage 1.5 — Vision (optional, per source)

For sources with `flow.vision.enabled`, image-only posts pass through a
transcription step before enrichment. The vision model returns text, never a
classification, so everything downstream stays unchanged.

```text
vision gate -> download image -> downscale (sharp) -> perceptual hash
            -> cache lookup -> gateway.vision() -> UPDATE posts.text_ocr
```

This runs in the worker, not during ingestion, so the no-outbound-calls
invariant holds. Full details, gates, and hazards: [VISION.md](VISION.md).

## Stage 2 — Enrich

`EnrichWorker` reads from the database. It knows nothing about Telegram,
Discord, or the event bus — only `posts` and `LLMGateway`. That boundary is
what keeps a later extraction into a separate process cheap.

One tick is a chained `setTimeout` (ticks cannot overlap) that runs, in order:
headline triage (NEWS_INTAKE.md), vision (stage 1.5), enrichment,
deduplication and the delta call (DEDUPLICATION.md). A backlog drains at one
tick a second, then the worker idles at `ENRICH_TICK_MS`.

```text
Post.claimPending(batch)           -> attempts + 1 at claim, before the call
        |
gateway.enrich(raw_text + title + text_ocr, candidates, examples)  -> one structured call
        |
validate (structural, then verbatim)  -> invalid means retry, not write
        |
gateway.embed(text_en)             -> vector for deduplication (null is allowed)
        |
UPDATE posts SET status='enriched', model_used, taxonomy_version, …
```

`attempts` grows at claim time so a post that crashes the process is not
retried forever; a shed or a deferred quota error gives the attempt back.
After `ENRICH_MAX_ATTEMPTS` the post is `failed`, kept with `last_error`.

**One call, not five.** The temptation to make separate calls for translation,
classification, extraction, and scoring is a four-times-too-expensive mistake.
A single structured call returns everything at once, plus one call for the
embedding. That is **2 requests per post**.

Field order inside the call matters: **translation comes first**. The model
normalizes the text to English, and the remaining response fields describe that
canonical representation. This is what makes everything downstream monolingual.

## Stage 3 — Delivery

`FlowDelivery`, on its own timer, only with `FLOW_DELIVERY_ENABLED=true`
(DELIVERY.md):

```text
updates to delivered clusters first (additions, corrections — edit / reply)
        |
canonical posts that passed dedup (+ failed ones, for #unsorted)
        |
resolve destinations (TAXONOMY.md)  -> translate if not Ukrainian
        |
lazy media via MediaResolver  <- the only download for TheFlow
        |
render per platform -> MessageRouter.routeMessage (unchanged)
        |
UPDATE posts SET status='routed' | 'unsorted', delivery; clusters.delivered
```

## Where TheFlow touches the existing code

Three places; the rest of Inemuri is unchanged.

**1. The branch.** `TelegramSourceListener._filterAndProcess()` (and the feed
poller's equivalent) branches on `source.isFlowEnabled()` after
`text_replacements`: flow sources go to `FlowIngest`, classic ones on to
filters, media download and `message.received`. Not earlier
(`_routeIncoming`, album buffering, serves both) and not later
(`_processFiltered` downloads media, which TheFlow defers).

**2. Media is lazy.** Classic forwarding downloads before emitting; TheFlow
stores `posts.media_ref` (`{ kind: "telegram", channel_id, message_id,
grouped_id }` or `{ kind: "url", urls }`) and fetches through `MediaResolver`
only for posts it delivers, so a duplicate never triggers a video download.

**3. Content decides the destination.** `MessageRouter` is unchanged: it
still sends to `messageData.source.destinations`; for a flow post the resolve
stage fills that field from `routing.json`. `sendToDestination()` returns
`{ platform, channel_id, message_id, sent_at }` and `routeMessage()` returns
`delivered[]`, which is what lets delivery edit a sent message later; classic
forwarding ignores it.

## Hybrid entity extraction

A promo code is exactly the case where the model cannot be trusted on its own:
it invents plausible codes that do not exist and misses real ones.

```text
regex finds candidates
        |
model receives the text plus the candidate list
        |
model states which are real codes, for what, what they grant, expiry if stated
        |
VALIDATION: every code in the response must be present in raw_text
```

The model never writes a code itself — it only confirms what was found.
Presence validation closes hallucination completely.

**The same rule applies to every verbatim field:** tickers, project names,
links, amounts. If a field claims to be verbatim, verify it exists in the
source text, otherwise discard it.

**Normalized values keep their words.** A date the model normalizes
(`2026-10-05` from "до 5 октября") cannot be checked verbatim, so the model
also returns the exact words that state it (`date_text`, `expires_text`), and
those are checked; without them the date is dropped. Implemented in phase 4
for event dates and promo-code expiry; links and amounts are verbatim fields.

**The one exception is text that came from an image.** A code transcribed by a
vision model was never in `raw_text`, so presence validation cannot apply.
Those entities carry `source: "ocr"` and `verified: false`, and are marked as
unverified on delivery — see [VISION.md](VISION.md).

## Resilience invariants

These cannot be broken, not even temporarily.

| Invariant | Consequence of breaking it |
|---|---|
| Ingestion never makes outbound network calls | The Telegram update loop stalls and messages are lost |
| No post ever disappears silently: `#unsorted` exists | You stop trusting the system and cannot debug it |
| An AI failure leaves the post `pending` rather than dropping it | Provider downtime becomes a hole in history |
| Classic mode depends on TheFlow for nothing | An experiment breaks a working service |
| Every verdict records `model_used` | Fallback makes history irreproducible |
| `raw_text` is always retained | New prompts cannot be re-run over history |

## What stays in-process, and what could move out

Everything currently runs in one Node process. The enrichment worker is just a
module reading from the database on a timer. Its work is I/O bound, so Node's
single thread is not the bottleneck.

**Moving it to a separate process is worth doing once one of these appears:**

- AI processing needs to run on a different machine;
- a crash or restart of processing must not affect forwarding uptime;
- differing release cadences start to get in the way.

**Until then, extraction costs more than it gives.** But the boundary must stay
clean from day one: the TheFlow module touches only the database and the
gateway, and never imports Telegram or Discord internals. Then extraction is a
few hours of work rather than a rewrite.

If it is extracted, SQLite needs `PRAGMA journal_mode=WAL` and an explicit
`busy_timeout` in both processes; otherwise `SQLITE_BUSY` appears under load,
because two independent Sequelize pools know nothing about each other.

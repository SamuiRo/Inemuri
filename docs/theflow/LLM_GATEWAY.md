# TheFlow — LLM Gateway

> Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [TAXONOMY.md](TAXONOMY.md)

The layer between the pipeline and the AI providers. The pipeline does not know
which provider handled a request and contains no vendor-specific code.

## Contract

The gateway exposes three methods:

```js
await gateway.enrich(input)          -> EnrichResult
await gateway.embed(text)            -> Float32Array
await gateway.vision(image, options) -> { text_ocr, description }
```

Everything else — provider selection, retries, rate limits, parsing,
validation, caching — stays inside. The pipeline sees neither HTTP nor the
differences between APIs.

`vision()` is used only by the vision stage and returns transcribed text, never
a classification — see [VISION.md](VISION.md) for why.

## A module, not a service

The gateway is a standalone **module** with a clean contract, not a separate
process behind HTTP. It has several consumers, and that is precisely what a
module is for; an HTTP service would add a server, serialization, auth, a second
deployment, and a second failure mode while solving nothing that exists today.

**Several consumers is the argument for a module, not against one.** The
instinct to make it a service comes from noticing that TheFlow enrichment,
deduplication, vision, and any future screening or search will all call it. Every
one of those lives in the same Node process today, so a service would mean the
process talking to itself over HTTP.

What a service would genuinely buy is one shared quota ledger and one shared rate
limiter across *processes*. That is bought instead by the `provider_quota` table:
persisted in SQLite, it is already shared by anything that opens the same database
file, service or not.

Extracting it into its own process becomes worthwhile only when more than one
*process* needs it — the same criterion that governs extracting TheFlow itself
(see ARCHITECTURE.md). Concretely, when one of these appears:

- TheFlow is extracted into its own process (ARCHITECTURE.md lists those
  triggers) **and** the forwarding process also needs AI calls;
- AI work has to run on a different machine — a second VPS, or a box with a GPU
  for a local model;
- something outside Inemuri needs the same providers under the same quota
  accounting.

Until then the boundary is enforced by discipline: the gateway imports nothing
from Telegram, Discord, or the pipeline. Because it is already a module behind a
three-method contract, wrapping it in an HTTP server later is a day of work
rather than a rewrite — which is the point of deciding it this way round. The
cheap option now does not foreclose the expensive one later.

If it is ever extracted, the SQLite caveat from ARCHITECTURE.md applies to every
process that touches the quota ledger: `PRAGMA journal_mode=WAL` and an explicit
`busy_timeout`.

No new dependencies are required: Gemini and OpenAI-compatible endpoints (which
is how Qwen is reached) are both plain HTTP and JSON, and `axios` is already in
`package.json`.

## `enrich()` input and output

**Input:**

```js
{
  text: "...",              // text after text_replacements, in the source language
  candidates: {             // what the regex stage found
    promo_codes: ["HY45OLK8QRE2"],
    tickers: ["$ABC"],
    urls: ["https://..."],
    dates: ["2026-03-14"]
  },
  taxonomy: { /* topics and signals from categories.json */ }
}
```

**Output** (validated against the schema before it is written to the database):

```json
{
  "lang": "ko",
  "text_en": "...",
  "summary_uk": "...",
  "topic": "games",
  "signal_type": "promo_code",
  "confidence": 0.88,
  "entities": {
    "project": "Genshin Impact",
    "tickers": []
  },
  "extracted": {
    "promo_codes": [
      { "code": "HY45OLK8QRE2", "reward": "300 gems", "expires_at": "2026-03-20" }
    ],
    "event": null
  },
  "why_interesting": "Limited code, valid for 5 days",
  "is_ad": false
}
```

Field order in the schema matters: **`text_en` comes first**. The model
normalizes the text, and every remaining field describes that canonical
representation.

`summary_uk` is optional, for reading in Ukrainian. It costs a few extra output
tokens and **no additional request**.

## Required call settings

| Parameter | Value | Reason |
|---|---|---|
| `temperature` | `0` | Maximum reproducibility |
| Structured output | `responseSchema` (Gemini) / `response_format: json_schema` (OpenAI-compatible) | The gateway hides the difference |
| Response validation | always, on top of structured output | Structured output helps but is not a guarantee |
| Timeout | explicit | Otherwise the worker hangs on a dead connection |

An invalid response is a failure, not data. The post stays `pending`,
`attempts` is incremented, and the reason goes into `last_error`.

## Verbatim field validation

A rule layered on top of the schema: **every field that claims to be verbatim
must be present in the source text**.

```text
for each code in extracted.promo_codes:
    if code is not contained in raw_text -> discard it
```

The same applies to tickers, links, and names. This closes hallucination
completely and costs nothing. The model never writes a code itself — it only
confirms candidates found by regex (see ARCHITECTURE.md).

## Fallback matrix

A single `catch` that switches providers on every error will burn through the
fallback provider's quota within an hour. The response depends on the cause.

| Situation | Response | Provider state |
|---|---|---|
| `429`, per-minute limit | Backoff and retry on the same provider | active |
| Daily quota exhausted | Switch to fallback until end of day | marked `exhausted` |
| Invalid JSON | One retry, then fallback | quality counter |
| Timeout or `5xx` | Circuit breaker, periodic probe | `open` |
| Network unavailable | Circuit breaker | `open` |
| Low `confidence` | Escalate to a stronger model | this is **tiering**, not fallback |
| All providers unavailable | Post stays `pending` | the worker picks it up later |

### Fallback is not tiering

Different mechanisms, different config fields:

- **Fallback** — the same task on another provider, because the first is
  unavailable.
- **Tiering** — escalation to a stronger model, because the result is uncertain.

Conflating them means escalating on every `429` and burning quota.

### Local RPD accounting

The gateway counts requests per provider itself and switches **before** hitting
the wall rather than after. The counter resets on the provider's schedule
(usually the UTC day). Without this, the first exhausted quota produces a burst
of failures instead of a clean switchover.

**The counter is per provider, not per capability.** `enrich`, `embed`, and
`vision` draw on the same daily allowance. Counting them separately produces a
specific and confusing failure: vision, which costs several times more per call,
quietly consumes the daily limit, and enrichment of ordinary posts starts
failing — which looks like "classification broke" rather than "vision ate the
quota".

## Consumers and priority classes

| Consumer | Uses | Priority | State |
|---|---|---|---|
| Enrichment worker | `enrich`, `embed` | `critical` | phase 1 |
| Deduplication | `embed` | `critical` | phase 3 |
| Vision stage | `vision` | `normal` | phase 1.5 |
| Digests | `enrich` | `low` | phase 5 |
| History search | `embed` | `low` | phase 5 — ROADMAP §9.1 |
| AI-assisted screening | `enrich` | `low` | **unspecified** — ROADMAP §13.8 |

**Every consumer runs worker-side.** No consumer may be added to the ingestion
path, whatever it is for: stage 1 makes no outbound network calls, and that
invariant does not bend for a gateway call. Cheap AI triage of the incoming
stream is therefore a stage-2 concern that writes its verdict back to `posts`,
never a filter evaluated while a Telegram update is being handled. This is a
constraint on the *pipeline*, and packaging does not change it — moving the
gateway behind HTTP would not make an ingest-time call acceptable.

Every call carries a priority. When remaining quota drops below a reserve
threshold, the gateway sheds work from the bottom up: digests and search stop
first, vision next, and enrichment plus deduplication are the last to go.

Without explicit priorities, the shedding order is whatever happened to be
queued first, and the most expensive optional work can starve the core pipeline.
Shed calls are not errors: the caller is told the request was deferred, and the
post stays `pending` for a later pass.

## `model_used` is required

If primary and fallback are different models, the same post is classified
differently depending on which one was alive at that minute.

Without a `model_used` column in `posts`, there is no way a month later to
distinguish a prompt regression from a provider switch. It is always recorded,
together with the taxonomy version.

## Cache

The key is a hash of the normalized input text. One text reposted across five
channels costs **one** call instead of five.

The cache lives in memory with a TTL. The pattern already exists in the project
(`src/sources/telegram/TelegramDeduplicator.js`) and can be used as a model:
TTL plus a size cap to prevent a memory leak.

## Queue and rate limiting

The worker never hits the provider directly:

```text
batch from database -> concurrency-limited queue
                    -> per-provider token bucket (RPM)
                    -> call
```

This is the main protection against bursts: first startup, backfill after
downtime, a polling cycle across 30 channels. Without a queue, the per-minute
limit burns through in seconds.

## Configuration

```js
// src/config/app.config.js
export const LLM_PRIMARY   = process.env.LLM_PRIMARY   || "gemini";
export const LLM_FALLBACK  = process.env.LLM_FALLBACK  || null;
export const LLM_TIER_UP   = process.env.LLM_TIER_UP   || null;
export const LLM_TIER_UP_BELOW = Number(process.env.LLM_TIER_UP_BELOW || 0.5);
export const LLM_MAX_CONCURRENCY = Number(process.env.LLM_MAX_CONCURRENCY || 2);
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30_000);

// Cache and shedding. Plain constants, mirroring DEDUP_TTL_MS / DEDUP_MAX_SIZE.
export const LLM_CACHE_TTL_MS   = 6 * 60 * 60 * 1_000;
export const LLM_CACHE_MAX_SIZE = 5_000;
export const LLM_QUOTA_RESERVE  = 0.15;   // fraction of RPD held for `critical`

// Enrichment worker (ROADMAP 3.6)
export const ENRICH_TICK_MS      = Number(process.env.ENRICH_TICK_MS ?? 30_000);
export const ENRICH_BATCH_SIZE   = Number(process.env.ENRICH_BATCH_SIZE ?? 10);
export const ENRICH_MAX_ATTEMPTS = Number(process.env.ENRICH_MAX_ATTEMPTS ?? 3);
```

**Derive `ENRICH_TICK_MS` and `ENRICH_BATCH_SIZE` from RPD, do not guess them.**
`batch / tick` is throughput; multiply by 2 requests per post and compare against
the daily limit measured in 3.1 against the real volume from 2.1. The defaults
above allow far more than any free tier will grant, which means the brake is the
token bucket rather than the timer — better to slow the timer deliberately than
to discover it through `429`s.

Provider keys go in `.env` like every other secret. `.env.example` is updated
alongside phase 1.

**There is no shadow-mode flag in phase 1**, and this document previously
specified one. Shadow mode is what the structure *is* while the gateway and the
enrichment worker exist and the routing consumer does not: verdicts are written
to `posts` and nobody reads them. A settable flag whose only possible value is
its default is a switch an operator can flip with no effect — worse than no
switch, because it implies a capability that isn't there. `LLM_SHADOW_MODE`
arrives in phase 2, together with the routing code it will gate (ROADMAP §5).

## Module layout

```text
src/services/ai/
├── LLMGateway.js            # enrich() / embed() / vision(), fallback, tiering,
│                            # cache, queue, quota accounting, priority shedding
├── schemas.js               # JSON response schemas plus validation
├── prompts/
│   ├── enrich.js            # main prompt with the taxonomy injected
│   ├── delta.js             # comparison against the canonical post (DEDUPLICATION.md)
│   └── vision.js            # transcription only, never classification (VISION.md)
└── providers/
    ├── BaseProvider.js      # contract: complete(), embed(), vision()
    ├── GeminiProvider.js
    └── OpenAICompatProvider.js   # covers Qwen and other compatible endpoints
```

A provider that does not support a capability declares it, and the gateway
routes that capability to a provider that does. Vision and text do not have to
come from the same vendor.

`OpenAICompatProvider` should be parameterized by base URL — one adapter then
covers Qwen and most other compatible APIs with no new code.

## Volume and quota

The **entire** incoming stream now reaches the AI, not the remainder after
keyword filtering.

```text
~200 posts/day x 2 requests (enrich + embed) = 400-600 requests/day
```

Minus whatever the regex stage rejected, minus cache hits on reposts. The
binding constraint will be the **daily limit (RPD), not the per-minute one** —
verify current provider values before starting phase 1.

Vision changes this arithmetic disproportionately: a call costs several times
more than a text call, and the count depends entirely on how many sources have
it enabled. Budget it separately, gate it hard (VISION.md), and give it a lower
priority class than enrichment.

Free tiers carry no SLA. Once TheFlow becomes your primary news channel that
will start to hurt, but thanks to this layer, moving to a paid tier is an
adapter swap rather than a pipeline rewrite.

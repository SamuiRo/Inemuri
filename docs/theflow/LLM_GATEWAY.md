# TheFlow — LLM Gateway

> Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [TAXONOMY.md](TAXONOMY.md)

The layer between the pipeline and the AI providers. The pipeline does not know
which provider handled a request and contains no vendor-specific code.

## Contract

```js
await gateway.enrich(input,    { priority })  // verdict: text_en, topic, signal, extracted…
await gateway.embed(text,      { priority })  // unit-length Float32Array, or null
await gateway.vision(image,    { priority })  // { text_ocr, description } — never a classification (VISION.md)
await gateway.delta(input,     { priority })  // what a later post adds (DEDUPLICATION.md)
await gateway.translate(input, { priority })  // Ukrainian body for delivery (DELIVERY.md)
await gateway.triage(input,    { priority })  // a batch of headlines against the reader profile (NEWS_INTAKE.md)
```

A shed call returns `{ shed: true }` instead of throwing. Everything else —
provider selection, retries, rate limits, parsing, validation, caching —
stays inside; the pipeline sees neither HTTP nor the differences between APIs.

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
from Telegram, Discord, or the pipeline, so wrapping it in an HTTP server later
is a day of work rather than a rewrite. If it is ever extracted, every process
touching the quota ledger needs `PRAGMA journal_mode=WAL` and an explicit
`busy_timeout` (ARCHITECTURE.md).

Providers are plain HTTP and JSON over `axios`: Gemini, and any
OpenAI-compatible endpoint (OpenRouter, Qwen, …) by base URL.

## `enrich()` input and output

**Input:** the text after `text_replacements` (plus `title` and `text_ocr`
when present), the regex stage's `candidates` (promo codes, tickers, URLs,
dates, amounts), the taxonomy, the post's publication date (outside the
untrusted block, to resolve dates without a year) and few-shot examples from
the knowledge base. The source text, OCR text and examples each sit in a
per-call nonced untrusted-data block.

**Output** (shape abbreviated; validated before it is written — `schemas.js`):

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

A full Ukrainian translation is **not** part of `enrich()`. It was tried
(v4.57.0, measured live): next to `text_en`, the classification and the
extraction, the model translated the first line of a long post and left the
rest in Russian, or returned nothing. `translate({ text, title })` is a
separate call with one job (`prompts/translate.js`), made by delivery only
for posts that are actually sent. A translation that still contains letters
Ukrainian does not have (`ы э ъ ё`, three or more outside URLs) fails
validation, and delivery sends the original.

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
must be present in the source text** (`raw_text` or `title`). Promo codes,
tickers, links and amounts are checked; a normalized date is kept only with
its exact words (`date_text`, `expires_text`), which are checked instead. A
match only in `text_ocr` is kept as `verified: false` (VISION.md); a match
nowhere is discarded into `analysis.discarded`. `entities.project` is not
checked — a project name is legitimately transliterated. The model never
writes a code itself; it confirms candidates found by regex
(ARCHITECTURE.md).

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

The gateway counts requests itself in `provider_quota` (persistent, so a
restart does not forget) and switches **before** hitting the wall rather than
after. The day is the provider's own: Gemini resets at Pacific midnight
(`GEMINI_QUOTA_TZ`), not UTC. Without this, the first exhausted quota produces
a burst of failures instead of a clean switchover.

**The provider's word beats the counter.** A daily-quota `429` marks the
model `exhausted` for the day, and the gate refuses it from then on even if
the local count is below `rpd` — the counter only sees this database, while
the same key on another machine, AI Studio, or a lower limit on Google's side
use the quota too. A refused call sheds, and a quota or rate-limit error that
survives the retries is *deferred* by every stage (`isDeferrable()`): the
enrich claim is returned, triage and delta wait for the next tick. Neither
counts as an attempt (v4.57.2; before it a mismatch turned the whole pending
queue `failed` within minutes).

**The counter is per `provider:model`, not per capability** — the way Google
counts free-tier limits. Every call on the complete model (enrich, vision,
delta, translate, triage) shares its allowance (default 500/day); the
embedding model has its own (1000/day). Counting capabilities separately
would hide the real failure: vision quietly consumes the daily limit and
enrichment starts failing, which looks like "classification broke" rather
than "vision ate the quota".

## Consumers and priority classes

| Consumer | Uses | Priority |
|---|---|---|
| Enrichment worker | `enrich`, `embed` (the vector dedup reads) | `critical` |
| Vision stage | `vision` | `normal` |
| Headline triage | `triage` | `normal` |
| Delta stage (dedup) | `delta` | `normal` |
| Delivery | `translate` — routed posts not in Ukrainian only | `normal` |
| History search | `embed` of the query | `low` |

Deduplication and the digest make no provider call of their own.

**Every consumer runs worker-side.** No consumer may be added to the ingestion
path, whatever it is for: stage 1 makes no outbound network calls, and that
invariant does not bend for a gateway call. Cheap AI triage of the incoming
stream is therefore a stage-2 concern that writes its verdict back to `posts`,
never a filter evaluated while a Telegram update is being handled. This is a
constraint on the *pipeline*, and packaging does not change it — moving the
gateway behind HTTP would not make an ingest-time call acceptable.

Every call carries a priority. The last `LLM_QUOTA_RESERVE` (15%) of a
model's RPD is held for `critical`: below it, `normal` and `low` calls are
shed and only enrichment continues.

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

In memory, keyed by a hash of the normalized input plus the taxonomy version
and the few-shot set; TTL `LLM_CACHE_TTL_MS` (6 h), size cap
`LLM_CACHE_MAX_SIZE` (5000). One text reposted across five channels costs
**one** call.

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

All in `src/config/app.config.js`, every value overridable from `.env`
(`.env.example` lists them): `LLM_PRIMARY` (`gemini`), `LLM_FALLBACK`,
`LLM_TIER_UP` / `LLM_TIER_UP_BELOW` (tiering, off by default),
`LLM_MAX_CONCURRENCY` (2), `LLM_TIMEOUT_MS` (30 s); the enrich worker's
`ENRICH_TICK_MS` (30 s), `ENRICH_BATCH_SIZE` (10), `ENRICH_MAX_ATTEMPTS` (3);
per provider the API key, model ids, RPD/RPM and quota time zone
(`GEMINI_*`, `OPENROUTER_*`). The defaults are the measured Gemini free tier:
`gemini-3.5-flash-lite` for complete and vision (RPD 500, RPM 15),
`gemini-embedding-2` at 768 dimensions (RPD 1000, RPM 100).

With no primary key the enrich worker does not start and flow posts wait as
`pending`. OpenRouter's embeddings are deliberately unused
(`OPENROUTER_EMBED_MODEL` empty): a fallback vector would sit in another
model's space, invisible to dedup and search, while a `null` can be filled
later by the same model. Startup warns if more than one embedding model is
configured.

Delivery has its own switch, `FLOW_DELIVERY_ENABLED` — with it off (the
default) verdicts are written and nobody sends them.

## Module layout

```text
src/services/ai/
├── LLMGateway.js            # the six methods; routing, fallback, tiering, cache,
│                            #   queue, quota ledger, breaker, priority shedding
├── internal.js              # TokenBucket, CircuitBreaker, TtlCache
├── schemas.js               # response schemas, structural and verbatim validation
├── prompts/                 # enrich, fewshot, vision, delta, translate, triage
└── providers/
    ├── BaseProvider.js      # complete() / embed() / vision(), capabilities(), HTTP error classes
    ├── GeminiProvider.js
    └── OpenAICompatProvider.js   # base-URL parameterized
```

A provider declares its capabilities from its key and configured models; the
gateway routes each capability to a provider that has it.

## Volume

The whole flow stream reaches the model, not what keyword filters leave: a
text post costs one complete call and one embedding, a screenshot post one
more complete call — roughly 250–500 posts a day on the free tier, minus regex
rejects and cache hits. The daily limit binds first, not the per-minute one.
Free tiers carry no SLA; moving to a paid tier is a config change, not a
pipeline rewrite.

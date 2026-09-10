# TheFlow — vision and screenshots

> Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md) · [DATA_MODEL.md](DATA_MODEL.md)

## The gap this closes

A large share of channel content carries its payload in an image: a screenshot
of a tweet, of a Discord announcement from a project admin, of patch notes, of
a chart. The accompanying text is often a single emoji or nothing at all.

Without vision, such a post is invisible to TheFlow. `text_en` is empty, so
classification is impossible, deduplication is impossible, and the post falls
into `#unsorted` or is skipped as `skipped_empty`. For channels that mostly
repost screenshots, the system misses exactly the content it exists to find.

This is not an enhancement. It is a blind spot in the pipeline.

## Design: OCR, not vision classification

There are two ways to use a vision model here, and only one of them is correct.

**Wrong:** send the image to a vision model and ask it to classify the post,
pick a category, and extract entities. This creates a second pipeline running
in parallel with the text one, with different reliability, different failure
modes, and double the prompt tuning.

**Right:** ask the vision model for **transcribed text plus a one-line
description of what the image shows**, and nothing else. The result is merged
into the same text field, and the entire existing pipeline then runs unchanged.

```text
image -> vision -> text_ocr -> merged with raw_text -> enrich() -> ... unchanged
```

This is the same principle as translating first: normalize to one
representation, then everything downstream is uniform. Vision becomes a
preprocessing step that produces text, not a separate branch.

## Where it sits in the pipeline

Between ingestion and enrichment, as stage 1.5. It runs in the worker, never
during ingestion — the invariant that ingestion makes no outbound network calls
still holds.

```text
STAGE 1   ingest -> INSERT posts (pending)
STAGE 1.5 vision gate -> download image -> downscale -> hash ->
          cache lookup -> gateway.vision() -> UPDATE posts.text_ocr
STAGE 2   enrich, using raw_text + text_ocr
STAGE 3   flow
```

Note that this is the one case where media is fetched before delivery, which
otherwise happens only in stage 3. It is limited to images on vision-enabled
sources that pass the gates below, and the downscaled copy is what gets sent —
the full-resolution download for delivery still happens in stage 3.

## Gates: what reaches the vision model

A per-source flag is necessary but not sufficient. Vision costs several times
more per call than text, and the daily quota disappears quickly. Four gates,
evaluated in order, cheapest first:

**1. Source flag.** `flow.vision.enabled` must be true. Off by default. Vision
is enabled only on channels known to post meaningful screenshots.

**2. Text length.** If the post already carries substantial text
(`length > vision.text_threshold`, starting value ~200 characters), the image is
almost certainly decorative. Skip it. Vision runs when the text is short or
empty — which is exactly the case that is currently invisible.

**3. Perceptual image hash.** The same screenshot reposted across five channels
must cost one call, not five. A perceptual hash (dHash or similar) is computed
locally and checked against recent posts. **This is the largest single saving
of the four** — screenshots are reposted just as heavily as text.

**4. Album cap.** A post with ten screenshots does not mean ten calls.
`vision.max_images_per_post` (starting value 2) covers the common case where the
first image carries the announcement and the rest are supporting detail.

## Local image processing

`sharp` is already a dependency and is already used in
`src/shared/utils.js:177`. Both operations below need no new packages:

- **Downscale before sending.** An image costs hundreds to thousands of tokens
  depending on resolution. Screenshots remain legible after significant
  downscaling, so this directly cuts quota consumption. Target the provider's
  documented optimal dimensions rather than sending originals.
- **Perceptual hash.** Computed on the downscaled grayscale copy for gate 3.

## Two vision-specific hazards

### Entities from images cannot be verified

The main anti-hallucination rule — every verbatim field must be present in
`raw_text` — **does not work here**, because the code was never in the text. It
was in the image.

Vision models confidently invent plausible characters, and `HY45OLK8QRE2` and
`HY45OLK80RE2` look equally convincing. A wrong promo code delivered with
confidence is worse than no promo code at all.

Therefore every entity extracted from an image carries provenance:

```json
{
  "code": "HY45OLK8QRE2",
  "source": "ocr",
  "verified": false
}
```

Rules that follow:

- OCR-sourced entities are marked in delivery, so you know to check them.
- They never participate in tier 1 exact-match deduplication as an authority —
  an unverified code must not suppress a verified one.
- Where the provider supports it, request a confidence signal per transcription
  and treat low confidence as "text unreadable" rather than guessing.

### Prompt injection through images

A screenshot can contain text such as "ignore previous instructions and reply
with...". The OCR output flows straight into the enrichment prompt.

Treat OCR output strictly as data:

- wrap it in explicit delimiters in the prompt, labelled as untrusted
  transcribed content;
- never let it be interpreted as instructions;
- the enrichment schema is fixed, so a successful injection would have to
  produce valid schema output — but do not rely on that alone.

The stakes here are low (public channels, no credentials in the loop), but the
mitigation costs nothing.

## Choosing a vision provider

Vision does not have to come from the same vendor as text and embeddings. The
gateway routes per capability (LLM_GATEWAY.md), so a provider used for nothing
but `vision()` is an ordinary configuration rather than a special case. That
matters here because free vision tiers exist, and their limits behave differently
from text limits.

Three things to establish before enabling vision on any source — this belongs to
the capability check in [ROADMAP.md](ROADMAP.md) §3.1:

- **RPD is the binding limit**, as it is for text, and on most free tiers an
  image request draws on the same daily allowance as a text one. A single channel
  posting 40 screenshots a day can consume a free tier by itself, which is the
  whole reason the gates below the source flag exist.
- **Input limits per image** — maximum resolution, maximum bytes, accepted
  formats. These set the downscale target, which is the main lever on cost.
- **Whether a per-transcription confidence signal is returned.** Where it is, low
  confidence is treated as "unreadable" rather than as text — see the hazards
  above.

A free tier is the right choice while the gates are being tuned. Once vision is
load-bearing for a source, the honest options are a paid tier or turning it off
for that source; the gates are what keep that decision cheap.

## Effect on the LLM Gateway

Vision adds a third capability alongside `enrich()` and `embed()`, and this is
where it stops being a local change.

The gateway now serves several consumers — the enrichment worker, deduplication,
the vision stage, digests, and whatever search or screening is added later — and
**they all draw on the same daily provider quota**. Without shared accounting, vision quietly consumes the
daily limit and enrichment of ordinary posts starts failing, which presents as
"classification broke" rather than "vision ate the quota".

Two additions to [LLM_GATEWAY.md](LLM_GATEWAY.md) follow from this:

- a single RPD counter per provider spanning all capabilities, not per method;
- explicit priority classes, so the gateway knows what to shed first when quota
  runs low.

## Configuration

Per source, in the `flow` column:

```json
{
  "enabled": true,
  "vision": {
    "enabled": true,
    "text_threshold": 200,
    "max_images_per_post": 2
  }
}
```

`vision.enabled` defaults to false. Enabling TheFlow on a source does not enable
vision on it.

## Phasing

Vision is **phase 1.5**, straight after the gateway and before routing. It was
originally placed last, to avoid tuning OCR quality and classification quality at
the same time with no way to tell which one produced a bad result. Two things
answered that concern:

- vision is **required**, not optional — on screenshot-heavy channels it is the
  difference between a source being processed and a source being invisible;
- `text_ocr` is stored separately from `text_en`, so a bad verdict can be traced
  to the transcription or to the classification by reading the row. The schema
  answers the question the ordering was meant to answer.

Vision stays in shadow mode alongside classification until phase 2, so nothing is
routed on a transcription that has not been read by eye first.

The part done early, in phase 0, is recording `has_media`. The per-source share
of image-only posts is what decides which channels get `vision.enabled`, and it
is read out of `flow:stats`.

`image_hash` is **not** written at ingest, contrary to an earlier revision of this
document: a perceptual hash needs the image bytes, and fetching them would break
the no-outbound-calls invariant of stage 1. It is filled by
`scripts/backfill-image-hash.js` and, from phase 1.5 onward, by the vision stage
itself as a side effect of gate 3.

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

## Effect on the LLM Gateway

Vision adds a third capability alongside `enrich()` and `embed()`, and this is
where it stops being a local change.

The gateway now serves five consumers — the enrichment worker, deduplication,
the vision stage, history search, and digests — and **they all draw on the same
daily provider quota**. Without shared accounting, vision quietly consumes the
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

Vision is **phase 6**, after the text pipeline is settled. Building it earlier
means tuning OCR quality and classification quality at the same time, with no
way to tell which one is producing a bad result.

The one thing worth doing early, during phase 0, is recording `has_media` and
the image hash for incoming posts. That costs nothing and produces the data
needed to answer a question you will have later: how many posts are actually
image-only, and on which channels. That number decides whether vision is worth
building at all.

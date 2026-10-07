# TheFlow — vision and screenshots

> Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [LLM_GATEWAY.md](LLM_GATEWAY.md) · [DATA_MODEL.md](DATA_MODEL.md)

Built, **off on every source** until `flow.vision.enabled` is set. Code:
`src/module/theflow/VisionStage.js`, `src/shared/image.js`,
`src/services/ai/prompts/vision.js`, `LLMGateway.vision()`,
`models/VisionCache.js`.

## The gap it closes

A large share of channel content carries its payload in an image: a
screenshot of a tweet, a project admin's Discord announcement, patch notes, a
promo code. The text beside it is often one emoji. Without vision such a post
has nothing to classify or deduplicate and ends up `skipped_empty` or in
`#unsorted`.

## Design: OCR, not vision classification

The vision model returns **transcribed text plus a one-line description of
the image**, never a category. The result goes into `posts.text_ocr`, and
enrichment reads `raw_text` + `text_ocr` as usual:

```text
image -> vision -> text_ocr -> enrich(raw_text + text_ocr) -> … unchanged
```

Classifying from the image would be a second pipeline with its own
reliability and its own tuning. Producing text keeps one pipeline — the same
principle as translating to English first.

## Where it runs

Stage 1.5, inside the enrich worker before enrichment — never during ingest,
which makes no outbound calls. It is the one place media is fetched before
delivery, and only for images that pass the gates.

```text
gates -> download (photos and image documents, ≤ N) -> downscale (sharp) -> dHash
      -> vision_cache by Hamming distance -> gateway.vision() -> UPDATE posts.text_ocr
```

`text_ocr` is written **immediately**, before enrichment: a failed enrichment
retry never pays for the transcription twice, and vision needs no status of
its own — `NULL` means not tried, `""` means tried and nothing legible.

## Gates

1. **Source flag** — `flow.vision.enabled`, off by default. Enable it only on
   channels that post meaningful screenshots (the share of image-only posts is
   in `flow stats`).
2. **Text length** — a post with more than `vision.text_threshold` (200)
   characters has a decorative image; skip it.
3. **Image type and size, before download** — `photo`, and documents of type
   `image/png|jpeg|webp` up to `VISION_MAX_DOCUMENT_MB` (20) (screenshots sent as files to avoid
   compression). The format is checked by magic bytes before decoding: the MIME
   type is the sender's claim. SVG, HEIC and GIF are refused.
4. **Album cap** — at most `vision.max_images_per_post` (2) images.
5. **Cache** — a near-identical image already transcribed is reused from
   `vision_cache` (TTL `VISION_CACHE_TTL_HOURS`, 72). The match is by
   **Hamming distance ≤ 10** on the dHash, not equality: a recompressed repost
   lands 4–7 bits from the original, different screenshots 15–23. This is the
   largest saving — screenshots are reposted as heavily as text.

## Local image processing

`sharp` (`src/shared/image.js`) downscales to at most `VISION_MAX_SIDE` (1024 px) on the long side
before sending — cost scales with resolution and screenshots stay legible —
and computes the 64-bit dHash (9×8 grayscale) the cache compares.

## Two vision-specific hazards

### Entities from images cannot be verified

Verbatim validation checks that a
code is in the source text, and an OCR code never was. Vision models invent
plausible characters (`HY45OLK8QRE2` vs `HY45OLK80RE2`). So every extracted
item has provenance: found in the text → `verified`; only in `text_ocr` →
kept with `source: "ocr"`, `verified: false`; in neither → discarded. An
unverified item is marked on delivery ("read from an image, check it") and is
**never a tier 1 dedup key** — a misread must not merge events or suppress a
verified post.

### Prompt injection through images

OCR text goes into the enrich prompt
inside the nonced untrusted-data block, labelled as transcribed content. The
schema is fixed as well, but the delimiter is what is relied on.

## Quota

Vision draws on the same daily allowance as enrichment: with the default
Gemini setup the complete model serves both, and the ledger counts per
`provider:model` as Google does. Vision runs at `normal` priority, so under
quota pressure it sheds before enrichment (LLM_GATEWAY.md). A shed returns
the claim; it never costs the post an attempt.

## Configuration

Per source, in `flow`:

```json
{ "enabled": true, "vision": { "enabled": true, "text_threshold": 200, "max_images_per_post": 2 } }
```

Enabling TheFlow on a source does not enable vision. `GEMINI_VISION_MODEL`
(default: the complete model) and `GEMINI_VISION_RPD` / `_RPM` select a
separate vision model; another provider is a config change, since the gateway
routes per capability.

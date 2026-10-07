# TheFlow — delivery contract

> Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [DEDUPLICATION.md](DEDUPLICATION.md) ·
> [VISION.md](VISION.md) · [DATA_MODEL.md](DATA_MODEL.md) · [ROADMAP.md](ROADMAP.md)

Stage 3 sends a post and then keeps it current as its cluster grows. This
document is the mechanism (decisions 1–3), the constraints other documents put
on the message, and the template as built. Code:
`src/module/theflow/delivery/render.js` (pure) and `FlowDelivery.js`.

## Decision 1 — full re-render, never string append

```js
render({ post, cluster, members, source, resolved, link, platform })
```

A pure function. Every edit calls it again over the current database state and
**rewrites the message whole**. Nothing is ever appended to a string that was
already sent.

This collapses a whole class of problems in DEDUPLICATION.md step 3:

- the addition cap becomes a rendering rule — show three, then a counter —
  rather than mutable state that has to be correct at every append;
- replacing the canonical post stops being a special case; it is the same
  function over a different input;
- the platform length limit is checked once, on the output, instead of at every
  append;
- being pure, it is testable (`test/render.test.js`).

## Decision 2 — compose by segments, rebase entity offsets

Telegram carries formatting as **MTProto entities with absolute offsets**, not as
Markdown: `parseMode: "markdown"` is unreliable in GramJS for user accounts, so
the project passes `formattingEntities` straight into the protocol
(`src/destinations/telegram/TelegramDestination.js`). Classic delivery already
composes a two-segment message this way — a source-name header plus the body —
and shifts the body's entities by the header's length:

```js
const plainText    = sourceName + "\n" + rawBody;
const entityOffset = sourceName.length + 1;
const formattingEntities = this.buildFormattingEntities(messageData.entities ?? [], entityOffset);
```

`render()` is the generalization: N segments instead of two, each contributing
its own entities, every offset rebased by the length of everything before it.
`buildFormattingEntities(entities, offsetDelta)` already accepts that shift, so
no change is needed on the adapter side.

`String.prototype.length` counts UTF-16 code units, which is exactly the unit
MTProto offsets use — so emoji in a header are counted correctly with no special
handling.

**This requires `posts.entities`.** The original entity array is what makes
"deliver the post as it was written" possible; without it the only path is
re-parsing Markdown back into entities, which is lossy. It is written at ingest
and added by migration `002` — see [DATA_MODEL.md](DATA_MODEL.md). Note that the
offsets index the text **before** text replacements; `_syncMarkdown()` already
tolerates the drift a replacement can introduce, and the same tolerance applies
here.

## Decision 3 — a correction is a new message, not an edit

**Editing a message produces no notification.** A retraction delivered only as an
edit is a retraction nobody sees, and DEDUPLICATION.md names exactly that as the
worst failure this system can produce: a cancelled event with a cheerful
announcement still standing.

| Relation | Delivery |
|---|---|
| `adds` | Re-render and edit. No new message — that is the point of clustering |
| `corrects` | Re-render the canonical message with a correction banner **and** send a new message as a reply to it |
| `denies` | Same as `corrects`, and the cluster closes |

The addition cap never applies to `corrects` or `denies`.

A failed edit is not a failed delivery: message deleted, permissions lost, edit
window expired — fall back to a reply carrying the re-rendered content.

## Platform limits

| Platform | Where the body goes | Limit |
|---|---|---|
| Telegram | message text, or media caption | Text 4096. Caption 1024 without Telegram Premium on the sending account, 4096 with it (`TELEGRAM_PREMIUM`). `render()` budgets a post with media to the caption limit, so the mandatory lines survive; the adapter also cuts and clips entities as a last resort |
| Discord | `embed.description` | 4096, within a 6000-character budget across the whole embed |

Discord delivery goes **exclusively through embeds** (`DiscordDestination`):
`content` is unused, so the 2000-character message limit never applies. Because
the platforms differ, `platform` is a parameter of `render()`, and truncation
is decided once on the rendered output.

## Constraints the template must satisfy

Whatever the final wording, these are fixed by other documents:

| Element | Rule | Source |
|---|---|---|
| Body | `text_md` with its original entities, delivered as written. `raw_text` is the plain text those offsets index | this document |
| Lead | `summary_uk` when the enrichment produced one — one line, above the body | THEFLOW.md open questions |
| Translation | A routed post not in Ukrainian goes out with `analysis.text_uk` as its body (plain text, no entities); on any failure the original | this document |
| Ads | `analysis.is_ad: true` resolves to `#unsorted` with reason `ad`, whatever the rules say | ResolveStage.js |
| Axes | `topic` and `signal_type` are visible, so a mis-route is obvious at a glance | TAXONOMY.md |
| Unverified OCR | Any entity carrying `verified: false` is marked as unverified. It is never presented indistinguishably from a verified one | VISION.md |
| Cluster size | `members_count > 0` renders the "also reported by N" line | DATA_MODEL.md |
| Additions | At most three shown, then a counter. `corrects` and `denies` are exempt | DEDUPLICATION.md |
| Diagnostics | `confidence`, `model_used` and `taxonomy_version` render **only** into `#unsorted`. That channel exists to be debugged; everywhere else they are noise | ROADMAP.md 13.4 |

## Implementation

- Every wording is in the one `TEMPLATE` object at the top of `render.js`:
  header, lead, unverified line, "also reported by N", additions and their
  counter, correction and denial banners, the original-post link,
  diagnostics, axis labels. Changing the template means editing that object,
  not the mechanism.
- Output fits the adapters as they are. Telegram: `{ header, body, entities }`
  — `TelegramDestination` already sends `source.name + "\n" + rawText` and
  shifts the entities by the header, so the header goes in `source.name` and
  the entities are relative to the body. Discord: `{ author, description,
  footer, color, url }` — the body is `text_md` (Markdown); `DiscordDestination`
  reads the optional `messageData.embed` for colour, footer and the author
  link (an `embed.url` without a title is not shown).
- Only the original is ever cut. Lead and banners go above it, the mandatory
  lines below it, and truncation leaves both intact — a denial survives any
  length. Entities are clipped to the text they index even without a cut:
  offsets index the text before replacements, and an entity past the end is
  refused by Telegram. A cut never splits a surrogate pair.
- `FlowDelivery.js` does the rest: selection, resolve, lazy media (types and
  count limited before download; a media failure sends the text with the
  error recorded), one `routeMessage` per platform, `posts.delivery` and
  `clusters.delivered`.
- Delivery selects canonical posts that passed dedup (plus `failed` ones, for
  `#unsorted`) and never sends a post older than `FLOW_DELIVERY_MAX_AGE_HOURS`
  (24, recorded as `too_old`), so switching delivery on cannot flood a channel
  with history. A delivered cluster is never sent again.
- Updates to a sent message (ROADMAP §6.6) follow Decision 1 and 3 exactly:
  every update is a full re-render of the cluster through the adapter's
  `editMessageData()`; additions are edited in up to `FLOW_DELIVERY_MAX_APPENDS` (3) times per cluster (`planClusterUpdate()`, pure);
  a `corrects` or `denies` is edited in **and** sent as a reply
  (`renderNotice()`), cap or no cap; a failed edit becomes a reply. Where the
  length would not fit, the original is cut, not the addition — so the
  "reply instead of edit when too long" rule from DEDUPLICATION.md is not
  needed.

## The template

Ukrainian throughout, like the translation and the lead — delivery is
addressed to a Ukrainian reader.

- **Axes** read as words: `🕹️ Ігри · 🎟 Промокод` (`TEMPLATE.topicLabel`,
  `signalLabel`, `signalEmoji`); an unknown key is shown as is.
- **Discord** is a full embed: the source is the author, the Ukrainian lead
  (`summary_uk`, or the article title for news and Reddit) is the title, both
  linking to the original; the body is the description; promo codes, the
  event, additions and — in `#unsorted` only — the diagnostics are fields;
  axes and "also reported by N" are the footer; the post's time is the embed
  timestamp. Codes are inline code (`` `SAVE20` ``) — copyable — with the
  expiry and an "read from an image, check it" note; times are Discord
  timestamps (`<t:…:f>` plus relative), so every reader sees their own zone;
  a date without a time stays text, because midnight UTC would show as the
  previous day in western zones. The description gets what is left of the
  6000-character embed budget after everything else.
- **Telegram** keeps text: lead and event above the body, then one line per
  code with a `MessageEntityCode` over the code — one tap copies it — and the
  rest of the mandatory lines. `composeBody()` takes lines as plain strings or
  `{ text, entities }` and rebases their entities.
- `DiscordDestination` reads `title`, `fields` and `timestamp` from
  `messageData.embed`, besides colour, footer and the link.

## Translation

The readers are Ukrainian; most source channels are not. A post the model
found not to be in Ukrainian (`lang` ≠ `uk`) and that resolves to a topic
channel is translated before rendering: `FlowDelivery._ensureTranslation()`
calls `LLMGateway.translate()` once, stores the result in
`analysis.text_uk` (and the model in `text_uk_model`), and `render()` uses
it as the body. Retries, `flow preview` and cluster re-renders reuse it.

- **Only routed posts.** `#unsorted` is read by the operator, for whom the
  original is more useful; and enrichment sees every post while delivery
  sends a fraction — translating at ingest would spend quota on posts
  nobody reads.
- **Never blocks delivery.** Shed, an error, or a translation left partly in
  the source language — the original goes out, and the next render tries
  again only if nothing was stored.
- **Plain text.** The original's entities index a different string, so the
  translated body carries none; links stay in the text as URLs and the
  original is one link away.
- `node src/cli.js flow preview --translate` shows what delivery would send,
  translating as it would (one provider call per post, saved).

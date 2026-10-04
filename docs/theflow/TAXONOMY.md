# TheFlow — taxonomy and routing

> Related: [THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md)

> The axis values below are the illustrative set. The **v1 draft written against
> the real sources** — including the required `security` signal for platform and
> exchange hacks — is in [ROADMAP.md](ROADMAP.md) appendix A, and the shipped
> file is [`src/config/categories.json`](../../src/config/categories.json).
>
> Two things the illustrative JSON below gets differently from the shipped file:
> the real topics are `steam / games / airdrop / p2e / crypto / tools / health /
> mind / money / markets / other` (v2 added the four news topics and the
> `research` and `report` signals, v3 `games`, `p2e` and the `meme` signal —
> see Versioning), and
> `dedup_window_hours` lives on each **signal**, not on the topic — a
> `promo_code` is stale in hours and `analysis` in days regardless of topic
> ([DEDUPLICATION.md](DEDUPLICATION.md)). A source still overrides with
> `flow.dedup_window_hours`.

## Two axes instead of one list

Classification decomposes into two independent things, and they must not be
merged.

**Axis 1 — topic.** What the post is about.

```text
games · market · crypto · tools · other
```

**Axis 2 — signal type.** What kind of event it is.

```text
promo_code · freebie · analysis · event · launch · patch · outage · opinion
```

Why this way:

- a model chooses more accurately from two short lists than from one long one;
- the output is a routing matrix rather than two dozen separate destinations;
- the axes change at different rates: topics are stable for months, signal types
  get refined more often.

## Both axes are closed enums

The model picks **only** from the lists in `categories.json`. Free-form category
generation produces `games`, `gaming`, `Game News`, and `gaming_news` as four
distinct entities within a month, and routing becomes unpredictable.

If the model cannot place a post in any category, it returns `other` with low
`confidence` and the post goes to `#unsorted`. It never invents a new label.

## `src/config/categories.json`

```json
{
  "version": 1,
  "unsorted_destinations": {
    "telegram": ["-1001111111111"]
  },
  "topics": {
    "games": {
      "description": "Games: releases, updates, events, promo codes, giveaways",
      "examples": [
        "Genshin Impact 5.3 update goes live March 14",
        "Free promo code for 300 gems, expires Friday"
      ],
      "dedup_window_hours": 48
    },
    "market": {
      "description": "Market news that affects the price or availability of assets",
      "examples": ["Fed holds rates", "Company X announces buyback"],
      "dedup_window_hours": 72
    },
    "crypto": {
      "description": "Analysis and specifics only: listings, breakdowns, on-chain data. Not price shouting, not advertising",
      "examples": ["On-chain analysis of X accumulation", "Token Y lists on Binance"],
      "dedup_window_hours": 72
    },
    "tools": {
      "description": "Free offers, service discounts, non-obvious solutions to technical problems",
      "examples": ["Service X free tier expanded to 100GB", "How to work around Y limitation"],
      "dedup_window_hours": 24
    },
    "other": {
      "description": "Does not fit any topic above",
      "dedup_window_hours": 24
    }
  },
  "signals": {
    "promo_code": { "description": "Contains a code that can be redeemed" },
    "freebie":    { "description": "Something is given away free or at a steep discount" },
    "analysis":   { "description": "A breakdown with data and reasoning that bears on the state of the market (see below)" },
    "event":      { "description": "An event with a date: start, deadline, active window" },
    "launch":     { "description": "A release, a listing, something new going live" },
    "patch":      { "description": "An update, changes, patch notes" },
    "outage":     { "description": "A failure, an outage, a problem" },
    "opinion":    { "description": "An opinion without supporting data, or one whose data is incidental" }
  },
  "routing": [
    {
      "when": { "topic": "games", "signal_type": ["promo_code", "freebie"] },
      "destinations": { "telegram": ["-1002222222222"] },
      "priority": 10
    },
    {
      "when": { "topic": "games" },
      "destinations": { "discord": ["333333333333333333"] },
      "priority": 1
    },
    {
      "when": { "topic": ["market", "crypto"], "signal_type": ["analysis", "launch"] },
      "destinations": { "telegram": ["-1004444444444"] },
      "priority": 10
    },
    {
      "when": { "topic": "tools" },
      "destinations": { "telegram": ["-1005555555555"] },
      "priority": 5
    }
  ]
}
```

### Boundaries that were actually contested

Signal descriptions are the model's only instruction, so the ones that split
near-identical posts are recorded here with the case that forced them. Without
the case, the next reader re-litigates the decision — or worse, labels both
ways in `flow review` and poisons the `post_feedback` set that phase 5 draws
few-shot examples from.

**`analysis` vs `opinion` — does the post let you judge the market?**

Two posts from the same channel, same shape: a long write-up on a Valve content
drought, dates and patch history cited, poll at the end.

- *"524 days without a new case in CS2, 871 days without a new Arcana"* —
  **analysis.** It says nothing tradeable shipped in that window, which is a
  fact about supply. Supply bears on price.
- *"CS2 turns three and there has been no content for two months"* —
  **opinion.** The occasion is a birthday. The dates are decoration; nothing
  about what to buy, sell or claim follows from them.

The test is not "does it contain data" — both do — but **whether the data
changes what a reader would buy, sell or claim.** A retrospective pegged to a
calendar occasion is an opinion however well researched.

No regex can draw this line, and no amount of per-source filtering can either:
the two posts differ only in what their numbers are *about*. It belongs in the
taxonomy, which is why it is here.

**`freebie` vs `event` — do you keep it?** Settled in `v4.14.4`: `freebie` is
something that stays yours after claiming; time-boxed access (a free weekend, a
trial) is an `event`, which already meant "a start, a deadline, an active
window".

### How resolve works

1. `routing` rules are evaluated in descending `priority` order.
2. The first rule whose `when` matches supplies the destinations.
3. If nothing matches, `unsorted_destinations` is used.
4. If `confidence` is below the source's `flow.min_confidence`,
   `unsorted_destinations` is used regardless of what matched.

A single value and an array are equivalent in `when`: `"games"` equals
`["games"]`.

**Implemented** in [`ResolveStage.js`](../../src/module/theflow/ResolveStage.js)
(`v4.24.0`). Two things the rules above did not settle, decided there:

- **A topic outside the source's `flow.topics` goes to `#unsorted`**, with its
  own reason. The spec defined `topics: null` as "all topics" and said nothing
  about a post outside a set list. Dropping it would make a topic-restricted
  source the one place posts vanish without a trace — the exact failure
  `#unsorted` exists to prevent.
- **A rule that matches but has no destinations is skipped**, not taken. A
  half-written rule should not swallow the posts that reach it.

Two additions beyond the spec (`v4.58.0`):

- **`when.source`** matches the post's source by its `channel_id` (Telegram
  chat id, feed URL, subreddit) or its `channel_name`. A channel that covers
  one subject — one game — is routed by it more reliably than by topic:
  `{ "when": { "source": "-1001234567890" }, "destinations": … }`.
- **`"also": true`** makes a rule *add* its destinations without ending the
  search. It applies whenever it matches, whatever its priority; among the
  other rules the first by priority still wins. Typical use — every promo
  code also goes to one shared channel:
  `{ "when": { "signal_type": "promo_code" }, "destinations": …, "also": true }`.
  A post matched only by `also` rules is routed there, not to `#unsorted`.
  The gates (ad, low confidence, `other`, source topics) still come first.

`validateRouting` also rejects destination ids no platform accepts (a
Discord id that is not a snowflake, a Telegram id that is neither numeric nor
`@username`) — a placeholder such as `TODO:claims` left in `routing.json`
fails `flow preflight`.

The checks run in a fixed order and the **first one that applies becomes the
recorded reason**: `model_failed` → `low_confidence` → `topic_other` →
`topic_not_in_source` → rule match → `no_rule`. Confidence comes before topic
because rule 4 applies "regardless of what matched". The reason is what makes
`#unsorted` readable: it says whether to fix a description, a threshold, a
source's topic list, or a routing rule.

Routing lives in `src/config/routing.json`, not in `categories.json` as the
example above shows — the example predates the `v4.17.0` split. Note too that
the example's topics (`games`, `market`) are not in v1; `validateRouting()`
flags that at startup as `[ROUTING]` warnings, because a rule naming an unknown
topic does not fail — it silently never matches.

## `#unsorted` is mandatory

**Nothing disappears silently.** It receives everything where:

- the model failed or returned invalid output after all attempts;
- `confidence` is below the threshold;
- the topic is `other`;
- no routing rule matched.

Without this channel you will stop trusting the system within a week and will
not be able to tell why a particular story never arrived. It is also the primary
material for refining the taxonomy: whatever keeps landing in `#unsorted` is
either a new category you need or a gap in an existing description.

## "Importance" is a threshold, not a category

The temptation is to add an `importance: 1..10` field and filter on it. That
does not work: a numeric score from an LLM is not reproducible between calls,
and the same post will score 6 and 8 across two runs.

Instead:

- **importance is expressed as a signal type** with explicit criteria
  (`event` with a date, `outage`, `launch`), not as an adjective in the prompt;
- a numeric score may be kept for **ordering within a digest**;
- **never use a score to decide whether to deliver.**

The same applies to the phrase "important market news" — that is not a category.
It is `market` plus a specific set of signal types.

## "Interesting posts" is a special case

The `tools` category — free offers, discounts, non-obvious solutions — differs
from the rest fundamentally: it is not a topic, it is **personal taste**. No
perfect prompt exists for it, and trying to write one is wasted effort.

The working approach:

1. Keep the category description deliberately broad — better too much than
   missed.
2. Route to a separate review channel rather than the main one.
3. **Build the feedback loop in from the start** (the `post_feedback` table):
   a reaction to a post writes a label, and those labels later become few-shot
   examples for the prompt.

Collecting that feedback retroactively is expensive — it means going through
history by hand. At the start it is nearly free.

## Versioning

**v3 (2026-10-03).** The first gaming and GameFi channels had nowhere to go:
gacha and general game news would have landed in `steam` or `other`. New
topics `games` (the games themselves — releases, patches, events, banners,
leaks, in-game promo codes, gacha included) and `p2e` (play-to-earn and
GameFi: blockchain games that pay in tokens, NFTs or drop points, split out
of `airdrop` and `crypto`). `steam` narrowed to the platform and the CS2
item economy. New signal `meme` (24 h): a joke is a *kind* of post, so it
lives on the signal axis and the topic still says what it is about — a
later split into finance and gaming memes is a routing rule on
`topic × meme`, not a new category. Memes are excluded from the digest.

**v2 (2026-10-03).** News sources (NEWS_INTAKE.md) brought content v1 had no
place for: topics `health`, `mind`, `money`, `markets`, and signals
`research` (a study and what it found, 72 h) and `report` (a development that
already happened — results, a share move, a central-bank decision, 48 h).
`crypto` now says that stocks and macro belong to `markets`, `money` that
market moves do. Verdicts made under v1 keep `taxonomy_version = 1`; nothing
is re-enriched automatically.

`categories.json` carries a `version` field. It is incremented whenever a
category description or the set of axes changes, and the value is written into
`posts` alongside the verdict. Without it there is no way to distinguish "the
model started making mistakes" from "I changed a category description last
Tuesday".

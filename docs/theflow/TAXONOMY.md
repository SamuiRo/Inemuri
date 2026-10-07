# TheFlow — taxonomy and routing

> Related: [THEFLOW.md](../THEFLOW.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DEDUPLICATION.md](DEDUPLICATION.md)

## Two axes instead of one list

Classification is two independent, **closed** enums, both in
[`src/config/categories.json`](../../src/config/categories.json) (tracked,
currently `version: 3`):

| Axis | Values |
|---|---|
| **Topic** — what the post is about | `steam` · `games` · `airdrop` · `p2e` · `crypto` · `tools` · `health` · `mind` · `money` · `markets` · `other` |
| **Signal** — what kind of event it is | `promo_code` · `freebie` · `analysis` · `event` · `launch` · `patch` · `outage` · `opinion` · `security` · `research` · `report` · `giveaway_result` · `stream` · `meme` |

Why two axes:

- a model chooses more accurately from two short lists than from one long one;
- the result is a routing matrix (`topic × signal`), not two dozen mappings;
- they change at different rates: topics stay for months, signals get refined.

`security` is the case for the split: an exchange hack is `crypto` +
`security`, a Steam scam wave `steam` + `security`. One topic could not hold
them, three topics would fragment routing.

The model picks **only** from these lists — free-form labels drift into
`games`, `gaming`, `Game News` within a month. A post that fits nothing is
`other` and goes to `#unsorted`; the model never invents a label.

## `categories.json`

```json
{
  "version": 3,
  "topics": {
    "steam": { "description": "The Steam platform and the CS2 item economy: …", "examples": ["Free case drop this weekend for CS2 players"] }
  },
  "signals": {
    "promo_code": { "description": "Contains a code that can be redeemed", "dedup_window_hours": 24 }
  }
}
```

Descriptions are the model's only instruction, injected into the enrich
prompt. `dedup_window_hours` lives on the **signal**: a promo code is stale in
hours, analysis in days, whatever the topic (DEDUPLICATION.md). A source can
override it with `flow.dedup_window_hours`. Routing is **not** here — channel
ids are deployment data and live in `routing.json`.

Three signals are classified so they can be kept out: `giveaway_result`,
`stream` and `meme` are excluded from the digest (`FLOW_DIGEST.excludeSignals`)
and, unless a rule routes them, land in `#unsorted` with `no_rule`.
`giveaway_result` and `stream` replaced hand-kept blacklists on several
sources.

### Boundaries that were contested

The cases that forced a description are recorded so the decision is not
re-litigated — or labelled both ways in `flow review`, which would poison the
few-shot examples.

**`analysis` vs `opinion` — does the data change what a reader would buy,
sell or claim?** *"524 days without a new case in CS2"* is **analysis**: it
is a fact about supply. *"CS2 turns three and there has been no content for
two months"* is **opinion**: the occasion is a birthday, the dates are
decoration. Both contain data; a retrospective pegged to a calendar occasion
is an opinion however well researched.

**`freebie` vs `event` — do you keep it?** `freebie` stays yours after
claiming; time-boxed access (a free weekend, a trial) is an `event`.

**`games` vs `steam`.** A game's own news is `games` even when it ships on
Steam; `steam` is the platform and the CS2 item economy.

**`crypto` vs `markets` vs `money`.** Stocks, companies and macro are
`markets`; `money` is how people and companies earn, not market moves.

## routing.json

```json
{
  "unsorted_destinations": { "telegram": ["-1001234567890"] },
  "routing": [
    { "when": { "signal_type": ["promo_code", "freebie"] }, "destinations": { "discord": ["123456789012345678"] }, "also": true, "priority": 100 },
    { "when": { "source": "-1001234567890" }, "destinations": { "discord": ["123456789012345678"] }, "priority": 50 },
    { "when": { "topic": "tools" }, "destinations": { "telegram": ["-1001234567890"] }, "priority": 10 }
  ],
  "health_destinations": { "telegram": ["-1001234567890"] },
  "digest_destinations": { "telegram": ["-1001234567890"] },
  "status_destinations": { "discord": ["123456789012345678"] }
}
```

`when` keys are `topic`, `signal_type` and `source` (a source's `channel_id`
— chat id, feed URL, subreddit — or its `channel_name`). A single value equals
a one-element array. Every key present must match.

### How resolve works

`ResolveStage.resolve()` (pure) checks in a fixed order; **the first that
applies is the recorded reason**:

1. `model_failed` — the post is `failed` → `#unsorted`.
2. `ad` — `analysis.is_ad` → `#unsorted`, whatever the rules say.
3. `low_confidence` — below the source's `flow.min_confidence` → `#unsorted`.
4. `topic_other` → `#unsorted`.
5. `topic_not_in_source` — outside the source's `flow.topics` → `#unsorted`.
   Dropping it instead would make a topic-restricted source the one place
   posts vanish.
6. Rules: every matching `also` rule adds its destinations; among the other
   rules, the first by descending `priority` supplies the main ones
   (`matched_rule`). A matching rule with no destinations is skipped. A post
   matched only by `also` rules goes there, not to `#unsorted`.
7. `no_rule` → `#unsorted`.

`validateRouting()` runs at startup (`[ROUTING]` warnings) and in
`flow preflight`: an unknown topic or signal in a rule (it would silently
never match), an unknown `when` key, and destination ids no platform accepts —
a placeholder such as `TODO:claims` fails preflight.

## `#unsorted` is mandatory

**Nothing disappears silently.** Every post resolve does not route lands in
`#unsorted` with its reason and, there only, the diagnostics (`confidence`,
`model_used`, `taxonomy_version`). The reason says what to fix: a
description, a threshold, a source's topic list, or a rule. Whatever keeps
landing there is a missing category or a too-narrow description.

## "Importance" is a signal, not a score

An LLM's numeric score is not reproducible — the same post scores 6 and 8
across two runs. Importance is expressed as a signal type with explicit
criteria (`security`, `outage`, `event` with a date); a deterministic score
may only **order** posts within a digest, never decide whether to deliver.
"Important market news" is not a category: it is `markets` plus specific
signals.

`tools` (free offers, discounts, non-obvious solutions) is personal taste
rather than a topic: keep its description broad, route it to a review
channel, and let `flow review` labels teach the prompt (few-shot).

## Versioning

`version` is bumped whenever a description or the set of values changes, and
written into `posts.taxonomy_version` with every verdict — so "the model got
worse" can be told apart from "a description changed". Old verdicts are not
re-enriched automatically: `flow requeue --status enriched` does it, at a
quota cost.

- **v3 (2026-10-03)** — topics `games` (games themselves, gacha included) and
  `p2e` (play-to-earn, split out of `airdrop` and `crypto`); `steam` narrowed
  to the platform and the CS2 economy; signal `meme` (a joke is a kind of
  post; the topic still says what about).
- **v2 (2026-10-03)** — news topics `health`, `mind`, `money`, `markets`;
  signals `research` (72 h) and `report` (48 h).
- **v1** — topics `steam`, `airdrop`, `crypto`, `tools`, `other`; eleven
  signals, `security`, `giveaway_result` and `stream` drafted from the real
  sources (ROADMAP appendix A).

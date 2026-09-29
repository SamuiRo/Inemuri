> **Role:** Reference for the `text_replacements` preprocessing feature · **Audience:** Anyone configuring a source

# Text replacements

## Overview

Text replacements are a preprocessing step applied to a message's text
**before** any filter runs. They exist to strip footers, headers, repeated
boilerplate and other noise — the kind of text that carries keywords and
would otherwise trigger a whitelist or a blacklist by accident.

## Where it sits

```
Incoming message
       ↓
  Preprocessing (text_replacements)
       ↓
  Filtering (keywords / blacklist)
       ↓
  Delivery to destinations   ──or──  ingest into TheFlow
```

Three properties worth knowing:

1. **Order is fixed.** Replacements always run before filters, never after.
2. **Patterns compile once.** Every regex is compiled at startup and cached.
3. **Cost.** An O(1) cache lookup per message, plus one pass per pattern.

For a TheFlow-enabled source the branch after preprocessing differs — the
post is written to `posts` instead of being forwarded — but preprocessing
itself is identical, and `posts.raw_text` stores the text **after**
replacements. That matters: it is the text the model sees and the text
verbatim validation checks against. See
[theflow/ARCHITECTURE.md](theflow/ARCHITECTURE.md).

## Configuration

Shape in the `Source` model:

```javascript
{
  "text_replacements": {
    "enabled": true,
    "patterns": [
      {
        "pattern": "text or regex",
        "replacement": "text to substitute (empty to delete)",
        "is_regex": true,
        "flags": "gi"
      }
    ]
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | Turn preprocessing on or off for this source |
| `patterns` | array | The rules, applied in order |
| `pattern` | string | Literal text, or a regular expression |
| `replacement` | string | Text to substitute; empty string deletes |
| `is_regex` | boolean | Treat `pattern` as a regular expression |
| `flags` | string | Regex flags (`g`, `i`, `s`, `m`, `u`) |
| `comment` | string | Free-text note. Ignored at runtime, read by humans |

Supplying `flags` implies `is_regex` — `MessageFilter.compileReplacements()`
treats a pattern as a regex when either is present. A regex that fails to
compile is logged and skipped; the rest of the patterns still apply.

## Examples

### 1. Delete a decorative separator

```json
{
  "pattern": "━━━━━━━━━━━━━━━",
  "replacement": "",
  "is_regex": false
}
```

**Before:**
```
New game on Steam!
━━━━━━━━━━━━━━━
📢 Channel: @gamechannel
```

**After:**
```
New game on Steam!


📢 Channel: @gamechannel
```

### 2. Delete a line that links back to the channel

```json
{
  "pattern": "📢 Channel:.*?\\n",
  "replacement": "",
  "is_regex": true,
  "flags": "gi"
}
```

**Before:**
```
New game on Steam!
📢 Channel: @gamechannel
50% off!
```

**After:**
```
New game on Steam!
50% off!
```

### 3. Delete a block between markers

```json
{
  "pattern": "🎮 FOOTER:.*?END FOOTER",
  "replacement": "",
  "is_regex": true,
  "flags": "gis"
}
```

The `s` flag is what lets `.` match a newline, so the pattern can span lines.

**Before:**
```
New game on Steam!
🎮 FOOTER:
Advertisement
Subscribe
END FOOTER
Discount!
```

**After:**
```
New game on Steam!

Discount!
```

### 4. Substitute rather than delete

```json
{
  "pattern": "@gamechannel",
  "replacement": "[CHANNEL]",
  "is_regex": false
}
```

`New game from @gamechannel` becomes `New game from [CHANNEL]`.

### 5. Strip every @mention

```json
{
  "pattern": "@\\w+",
  "replacement": "",
  "is_regex": true,
  "flags": "g"
}
```

`Check @channel1 and @channel2 for updates` becomes
`Check  and  for updates` — note the doubled spaces. Replace with a single
space instead of an empty string if that matters downstream.

### 6. Strip URLs

```json
{
  "pattern": "https?://\\S+",
  "replacement": "",
  "is_regex": true,
  "flags": "gi"
}
```

Be careful with this one on a TheFlow source: `candidates.urls` is extracted
from `raw_text`, so stripping URLs here removes them from the model's input
as well.

### 7. Strip a reaction-prompt footer

A common shape is a run of lines like `<emoji> - <text>` inviting reactions.
Requiring **two or more consecutive** such lines keeps the pattern from
eating a single emoji-led line that is genuine content:

```json
{
  "pattern": "(?:\\n[ \\t]*[\\p{Extended_Pictographic}\\uFE0F]+[ \\t]*[-\\u2013\\u2014][ \\t]*[^\\n]*){2,}",
  "replacement": "",
  "is_regex": true,
  "flags": "gu",
  "comment": "Reaction-prompt footer, two lines or more"
}
```

The `u` flag is required for `\p{...}`. The character class covers the hyphen,
en dash and em dash, because channels are inconsistent about which they use.

## Full source example

```json
{
  "platform": "telegram",
  "channel_id": "-1001234567890",
  "channel_name": "Gaming News",
  "is_active": true,
  "text_replacements": {
    "enabled": true,
    "patterns": [
      {
        "pattern": "━━━━━━━━━━━━━━━",
        "replacement": "",
        "is_regex": false,
        "comment": "Decorative separators"
      },
      {
        "pattern": "📢 Channel:.*?\\n",
        "replacement": "",
        "is_regex": true,
        "flags": "gi",
        "comment": "Back-links to the source channel"
      },
      {
        "pattern": "\\[AD\\].*?\\[/AD\\]",
        "replacement": "",
        "is_regex": true,
        "flags": "gis",
        "comment": "Marked advertising blocks"
      },
      {
        "pattern": "@\\w+",
        "replacement": "",
        "is_regex": true,
        "flags": "g",
        "comment": "All @mentions"
      }
    ]
  },
  "filters": {
    "enabled": true,
    "keywords": ["game", "free", "discount"],
    "blacklist": ["spam", "ad"],
    "case_sensitive": false
  },
  "destinations": {
    "telegram": ["-123456"],
    "discord": ["987654321"]
  }
}
```

## Useful patterns

**Text spanning several lines** — the `s` flag makes `.` match `\n`:

```javascript
{ "pattern": "START.*?END", "flags": "gis" }
```

**Emoji** — the `u` flag is required:

```javascript
{ "pattern": "[\\u{1F300}-\\u{1F9FF}]", "flags": "gu" }
```

**Phone numbers:**

```javascript
{ "pattern": "\\+?\\d{1,3}[\\s-]?\\(?\\d{1,4}\\)?[\\s-]?\\d{1,4}[\\s-]?\\d{1,9}", "flags": "g" }
```

**Email addresses:**

```javascript
{ "pattern": "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "flags": "g" }
```

## Practice

**Write a `comment` on every non-obvious pattern.** A regex with no
explanation is unmaintainable six months later, and the field costs nothing
at runtime.

**Never use a pattern that can match everything.** `".*"` with an empty
replacement deletes the whole message; the post then fails
`THEFLOW_MIN_TEXT_LENGTH` and is stored as `skipped_empty`, which looks like
a source problem rather than a config problem.

**Order matters**, because patterns apply in sequence. Remove large blocks
first, then small elements — the reverse can leave a block's delimiters
behind after their contents are gone:

```json
{
  "patterns": [
    { "pattern": "\\[AD\\].*?\\[/AD\\]", "replacement": "", "is_regex": true, "flags": "gis" },
    { "pattern": "@\\w+",                "replacement": "", "is_regex": true, "flags": "g" }
  ]
}
```

**Prefer a literal over a regex** when the text is fixed — `is_regex: false`
uses `String.replaceAll()`, which is faster and cannot backtrack.

**Keep the list short.** Five to ten patterns per source is a reasonable
ceiling; past that, the thing being removed is usually better handled by a
blacklist entry or, for a TheFlow source, by the model.

## Testing a pattern

Run it through the real `MessageFilter` rather than a hand-rolled copy —
compilation has its own behaviour around flags and invalid patterns:

```javascript
import messageFilter from "./src/module/filters/MessageFilter.js";

const compiled = messageFilter.compileReplacements(1, {
  enabled: true,
  patterns: [{ pattern: "━━━━━━", replacement: "", is_regex: false }],
});

console.log(messageFilter.preprocessText(compiled, "Test ━━━━━━ Footer"));
// "Test  Footer"
```

`checkMessageDetailed()` reports both the original and the processed text,
which is what you want when a message is being filtered and it is not
obvious whether the replacement or the filter is responsible:

```javascript
const detailed = messageFilter.checkMessageDetailed(source, "Test ━━━━━━ game");
// { passed, reason, originalText, processedText }
```

## Schema changes

`text_replacements` is a JSON column on `sources` and needs no migration to
change its contents — it is configuration, not schema.

Adding or altering a **column** is different: apply it as a numbered
migration under `database/migrations/` and run `npm run migrate`. Do not rely
on `sync({ alter: true })` against a database that holds real data — SQLite
rebuilds the whole table. See `CLAUDE.md` § Operational cautions.

Sources seeded before the column existed have `text_replacements` as `null`;
`Source.prototype.preprocessText()` treats that as disabled and returns the
text unchanged.

## Troubleshooting

**Filters behave as though the old configuration is still in place.**
Compiled patterns are cached per source id. Clear the cache and reload:

```javascript
messageFilter.clearCache();          // or clearCache(sourceId)
await telegramListener.reloadWhitelist();
```

**A pattern seems to be ignored.** It probably failed to compile — an invalid
regex is logged by `compileReplacements()` and dropped, and the remaining
patterns still run, so the symptom is one rule silently missing rather than
an error. Check it in isolation:

```javascript
try { new RegExp(pattern, flags); }
catch (error) { console.error("Invalid regex:", pattern, error.message); }
```

**The whole message disappears.** The pattern is too broad. Narrow it to the
block you actually mean:

```javascript
".*"                    // wrong: matches everything
"FOOTER:.*?END FOOTER"  // right: bounded, non-greedy
```

**Backslashes vanish.** In JSON, `\d` must be written `\\d`. A pattern that
works in a JavaScript regex literal needs every backslash doubled when it
moves into a config file.

## API

`MessageFilter`:

```javascript
compileReplacements(sourceId, textReplacements)   // compile and cache
preprocessText(compiledReplacements, messageText) // apply replacements
checkMessageFast(compiledReplacements, compiledFilter, messageText)
checkMessageDetailed(source, messageText)         // with diagnostics
clearCache(sourceId = null)
getCacheStats()
```

`Source`:

```javascript
source.preprocessText(messageText)  // replacements only
source.passesFilter(messageText)    // replacements, then filters
```

## History

Initial version added the `text_replacements` column to the `Source` model,
support for both literal and regex patterns, caching of compiled patterns,
integration into `TelegramSourceListener`, and the guarantee that
preprocessing runs before filtering.

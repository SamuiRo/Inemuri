# Media and embeds

> **Role:** How media travels from a Telegram source to a destination, and what each side decides · **Audience:** Anyone changing media handling, adding a media type, or explaining why a file did not arrive

This replaces the retired `USE_EMBED.md`, which described an opt-in embed API
(`useEmbed: true`, a caller-supplied `embed` object) that the code does not
have. Every symbol below was checked against the tree at `v4.19.0`.

Media crosses **three independent stages**, and each drops things for its own
reasons. When a file does not arrive, the question is always *which stage*.

```
parse                    download                 deliver
TelegramMessageParser -> TelegramMediaDownloader -> DiscordDestination
.parseMedia()            DOWNLOADABLE_MEDIA_TYPES  supportedMediaTypes
classifies everything    downloads a subset        embeds/attaches a subset
```

## Stage 1 — parsing

[`TelegramMessageParser.parseMedia()`](../src/sources/telegram/TelegramMessageParser.js:349)
turns a raw MTProto media object into `{ type, raw, ... }`. It classifies
everything and rejects nothing.

The outer class maps to a coarse type:

| MTProto class | `type` |
|---|---|
| `MessageMediaPhoto` | `photo` |
| `MessageMediaDocument` | `document` |
| `MessageMediaWebPage` | `webpage` |
| `MessageMediaGeo` | `location` |
| `MessageMediaContact` | `contact` |
| `MessageMediaPoll` | `poll` |
| anything else | `unknown` |

A `document` is then refined by its attributes, so the final `type` is more
specific than the table above:

| Attribute | Becomes | Extra fields |
|---|---|---|
| `DocumentAttributeVideo` | `video`, or `video_note` when `roundMessage` | `duration`, `width`, `height` |
| `DocumentAttributeAnimated` | `animation` | — |
| `DocumentAttributeAudio` | `audio` | `duration`, `title`, `performer` |
| `DocumentAttributeFilename` | *(type unchanged)* | `filename` |

Two details that matter downstream:

- **A photo is always reported as `image/jpeg`.** `parseMedia()` sets it
  unconditionally and returns early — Telegram photos carry no document, so
  there is no MIME type to read. This is why `photo.defaultExtension: "png"` in
  `DiscordDestination` almost never applies in practice: the MIME lookup
  resolves first and yields `.jpg`.
- `mimeType`, `fileSize` and `filename` come from the document when there is
  one, and are simply absent for photos.

## Stage 2 — downloading

[`TelegramMediaDownloader`](../src/sources/telegram/TelegramMediaDownloader.js)
downloads only types listed in `DOWNLOADABLE_MEDIA_TYPES`
([`app.config.js`](../src/config/app.config.js)):

```js
export const DOWNLOADABLE_MEDIA_TYPES = ["photo", "video", "document", "animation"];
```

Anything else is skipped silently — `_downloadMany` does a bare `continue`, and
`_downloadOne` returns `null`. **`audio` and `video_note` parse correctly but
are never downloaded**, and neither is `webpage` / `location` / `contact` /
`poll`. If an audio file "disappears", this is the stage that dropped it, and
the fix is one entry in this array.

The result is `messageData.downloadedMedia`, an array of
`{ type, data, filename, mimeType, fileSize, duration, width, height }` —
`data` being a `Buffer`.

TheFlow does **not** use this path: ingestion never touches the network, so it
stores a `media_ref` and re-fetches later through
[`MediaResolver`](../src/module/theflow/media/MediaResolver.js), which reuses
`parseMedia()` and this same downloader.

## Stage 3 — Discord delivery

**Discord messages are always an embed, never plain `content`.** There is no
`useEmbed` flag and no way to pass an embed in; `_buildPayload()` composes it
from the message every time.

| Embed field | Source |
|---|---|
| `author` | `messageData.source.name` |
| `description` | `messageData.text`, truncated to 4096 chars |
| `color` | `0x5865f2` (Discord Blurple), fixed |
| `image` | `attachment://<filename>` of the **first** embeddable file |
| `footer` | Only when files were skipped for size |

Truncation appends `\n\n*(…)*` and logs a warning, so a cut message is visible
in both the channel and the log.

`supportedMediaTypes` decides what may become `embed.image`:

| `type` | Allowed extensions | Default | `canEmbed` |
|---|---|---|---|
| `photo` | jpg, jpeg, png, gif, webp | png | **yes** |
| `animation` | gif | gif | **yes** |
| `video` | mp4, mov, webm, mkv | mp4 | no |
| `document` | pdf, doc, docx, txt, zip | file | no |
| `audio` | mp3, wav, ogg, m4a | mp3 | no |

`canEmbed` governs the embed *image only*. Every file that passes the size
check is attached to `payload.files` regardless — a video is delivered, it just
does not become the embed's picture.

Note `audio` is listed here but never reaches this stage, because stage 2 does
not download it. The two lists are not kept in sync by anything.

### File size

The limit starts at 25 MB. `setFileSizeLimit(true)` raises it to 100 MB for a
Nitro-boosted server; nothing calls it automatically, so a boosted server needs
the call wiring in `src/inemuri.js`.

Oversized files are dropped individually — the rest of the message still goes
out — and the embed gains a footer:

```
⚠️ 2 file(s) skipped — exceeds 25MB limit
```

There is no video compression. The archived doc listed it as a TODO; it is
still not implemented.

### Filenames

`_getFilename()` resolves in priority order:

1. `media.filename` from the document, as-is;
2. the MIME type through `_extFromMime()`, **but only if the resulting
   extension is in that type's `extensions` list** — an `image/png` photo
   resolves because `png` is allowed there, while a MIME type outside the list
   falls through;
3. `attachment<i>.<defaultExtension>`.

An unknown `media.type` yields `attachment<i>.bin` and a warning.

## Adding a media type

Three places, in pipeline order. Skipping any one of them fails silently rather
than loudly:

1. **`parseMedia()`** — recognise it, if the coarse class map and the document
   attributes do not already. Photos and documents are already covered; a new
   *document attribute* is a `switch` case.
2. **`DOWNLOADABLE_MEDIA_TYPES`** in `app.config.js` — otherwise it parses and
   is never downloaded. This is the step most easily missed, because nothing
   logs it.
3. **`supportedMediaTypes`** in `DiscordDestination` — extensions,
   `defaultExtension`, and whether it can be an embed image. Without an entry
   the file still sends, as `attachment<i>.bin`.

Add the MIME type to `_extFromMime()`'s map as well if the new type brings one
that is not already there.

## Telegram delivery

`TelegramDestination` takes the same `downloadedMedia` and sends through
`sendMediaGroup()` / `sendWithMedia()`, letting GramJS build the `InputMedia`
rather than assembling `InputMediaUploadedPhoto` by hand. It declares
`{ edit: true }` in `capabilities`, which is what the phase 3 `linked`
mechanism will need — see [theflow/DELIVERY.md](theflow/DELIVERY.md).

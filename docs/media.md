# Media and embeds

> **Role:** How media travels from a Telegram source to a destination, and what each side decides · **Audience:** Anyone changing media handling, adding a media type, or explaining why a file did not arrive

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
  there is no MIME type to read.
- `mimeType`, `fileSize` and `filename` come from the document when there is
  one, and are simply absent for photos.

## Stage 2 — downloading

[`TelegramMediaDownloader`](../src/sources/telegram/TelegramMediaDownloader.js)
downloads only types listed in `DOWNLOADABLE_MEDIA_TYPES`
([`app.config.js`](../src/config/app.config.js)):

```js
export const DOWNLOADABLE_MEDIA_TYPES = ["photo", "video", "document", "animation"];
```

Anything else is skipped, and the skip is logged with the type, the effective
list, and what to do about it.

`audio`, `video_note`, `webpage`, `location`, `contact` and `poll` are all
outside the global list. That is deliberate for the last four (there is nothing
to download) and a choice for the first two.

**A source can opt into more.** `sources.extra_media_types` (a JSON array) is
added to the global list for that source only:

```json
{ "channel_name": "Podcast", "extra_media_types": ["audio"] }
```

`Source.getDownloadableMediaTypes(global)` merges and de-duplicates; `NULL`,
an empty array, or anything malformed means "global list only".

The field is **additive, never a substitute**, on purpose: a full per-source
list invites omitting `photo` by accident and silently losing every image on
that source. It can only ever add.

`video_note` stays out of the global list by decision — round video messages
are not worth forwarding — but a source that wants them can name it.

The result is `messageData.downloadedMedia`, an array of
`{ type, data, filename, mimeType, fileSize, duration, width, height }` —
`data` being a `Buffer`.

TheFlow does **not** use this path: ingestion never touches the network, so it
stores a `media_ref` and fetches later, only for posts it delivers, through
[`MediaResolver`](../src/module/theflow/media/MediaResolver.js) — a registry
that `src/inemuri.js` fills: `src/sources/telegram/TelegramMediaResolver.js`
reuses `parseMedia()` and this same downloader,
`src/sources/feeds/UrlMediaResolver.js` fetches feed images. Types and the count are limited before
download.

## Stage 3 — Discord delivery

**Discord messages are always an embed, never plain `content`.**
`_buildPayload()` composes it from the message:

| Embed field | Source |
|---|---|
| `author` | `messageData.source.name` |
| `description` | `messageData.text`, truncated to 4096 chars |
| `color` | `0x5865f2` (Discord Blurple) unless `messageData.embed.color` is set |
| `image` | `attachment://<filename>` of the **first** embeddable file |
| `footer` | When files were skipped for size, or `messageData.embed.footer` |

Classic forwarding sets none of `messageData.embed`; TheFlow delivery uses it
for title, colour, fields, footer, timestamp and the author link
(theflow/DELIVERY.md).

Truncation appends `\n\n*(…)*` and logs a warning, so a cut message is visible
in both the channel and the log.

`supportedMediaTypes` decides what may become `embed.image`:

| `type` | Allowed extensions | Default | `canEmbed` |
|---|---|---|---|
| `photo` | jpg, jpeg, png, gif, webp | jpg | **yes** |
| `animation` | gif | gif | **yes** |
| `video` | mp4, mov, webm, mkv | mp4 | no |
| `document` | pdf, doc, docx, txt, zip | file | no |
| `audio` | mp3, wav, ogg, m4a | mp3 | no |

`canEmbed` governs the embed *image only*. Every file that passes the size
check is attached to `payload.files` regardless — a video is delivered, it just
does not become the embed's picture.

`audio` is listed here but only reaches this stage on a source whose
`extra_media_types` names it. The two lists are still not kept in sync by
anything: an entry here without the corresponding download permission is inert,
and a downloaded type with no entry here sends as `attachment<i>.bin`.

### File size

The limit is `DISCORD_UPLOAD_LIMIT_MB` (default 20). Oversized files are
dropped individually — the rest of the message still goes out — and the embed
gains a footer:

```
⚠️ 2 file(s) skipped — exceeds 20MB limit
```

There is no video compression.

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
   is never downloaded. Add it here if every source should get the type; leave
   it out and use a source's `extra_media_types` if only some should.
3. **`supportedMediaTypes`** in `DiscordDestination` — extensions,
   `defaultExtension`, and whether it can be an embed image. Without an entry
   the file still sends, as `attachment<i>.bin`.

Add the MIME type to `_extFromMime()`'s map as well if the new type brings one
that is not already there.

## Telegram delivery

`TelegramDestination` takes the same `downloadedMedia` and sends through
`sendMediaGroup()` / `sendWithMedia()`, letting GramJS build the `InputMedia`
rather than assembling `InputMediaUploadedPhoto` by hand. The text of a post
with media is its caption, cut to 1024 characters (4096 with
`TELEGRAM_PREMIUM`), its entities clipped to the cut; a text message holds
4096. Both adapters declare `{ edit: true }` and implement
`editMessageData()`, which TheFlow uses to keep a delivered message current
([theflow/DELIVERY.md](theflow/DELIVERY.md)).

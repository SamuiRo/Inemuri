> **Role:** Spec of the Discord source (platform `discord`) · **Audience:** Anyone configuring, running or changing it

# Discord as a source

Sources with `"platform": "discord"` read channels on Discord servers the
operator does not run, through a **user account**. Messages go through the
same replacements and filters as every other source, then to classic
forwarding or TheFlow. This replaces CloakCord, a separate service that did
the same with its own webhooks and database.

Delivery to Discord is unrelated: it stays on the bot (`DISCORD_BOT_TOKEN`,
REST). discordapp is unrelated too — the source neither uses nor needs it.

## Setup

What is needed, in order. The same on the dev copy and on the VPS; on the VPS
`.env` and `sources.json` are copied by hand ([DEPLOYMENT.md](DEPLOYMENT.md),
"What git pull does not bring").

### 1. The reading account

- **A dedicated secondary Discord account**, not your main one. Automating a
  user account is against Discord's terms and the account can be banned
  without warning. It only reads; nothing is ever sent from it.
- **Join it to every server** you want to read. It sees exactly what a person
  logged in as it would see: a channel it has no access to cannot be read.
- Its **token** (the `Authorization` header of any request the logged-in web
  client makes to `discord.com/api`, in the browser's developer tools) goes in
  `.env`:

  ```bash
  DISCORD_USER_TOKEN="..."
  ```

  Nowhere else — not in `sources.json`, not in git. Logging out of that
  account in the browser, or changing its password, revokes the token; the
  reader then stops with `Fix DISCORD_USER_TOKEN` in the log and does not
  retry.

### 2. Where the posts go

Delivery is the **Inemuri bot** (`DISCORD_BOT_TOKEN`), as for every other
source — not the reading account and not webhooks. For each destination
channel on your server, the bot needs **View Channel, Send Messages, Embed
Links and Attach Files** there. Telegram destinations work too.

### 3. Channel ids

Discord → User Settings → Advanced → **Developer Mode** on. Then right-click
a channel → **Copy Channel ID** — both for the channels to read (as the
reading account) and for the destination channels. A **channel** id, not the
server id: the seeder refuses anything that is not 17–20 digits.

### 4. `src/config/sources.json`

One entry per channel to read, in the same `sources` array as the other
sources:

```json
{
  "platform": "discord",
  "channel_id": "123456789012345678",
  "channel_name": "Server name · #announcements",
  "is_active": true,
  "filters": { "enabled": true, "keywords": ["airdrop", "giveaway"], "blacklist": [], "case_sensitive": false },
  "destinations": { "telegram": [], "discord": ["234567890123456789"] }
}
```

| Field | Notes |
|---|---|
| `channel_id` | The channel to read |
| `channel_name` | Shown as the author of every forwarded post — put the server name in it |
| `is_active` | `false` stops reading the channel. Deleting the entry does **not**: `npm run seed` adds and updates, never deletes |
| `filters.enabled` | **Must be `true` for `keywords` and `blacklist` to apply.** `false` (or no `filters`) forwards everything |
| `filters.keywords` | Any one of them in the text passes the post; case-insensitive unless `case_sensitive`. Empty list = everything, including posts that are only an image |
| `filters.blacklist` | Any one of them drops the post, even with a keyword |
| `filters.require_media` | `true` drops every message without an image or video, whatever its text — for art channels where people also chat. A YouTube link is not media (its preview is a thumbnail) |
| `destinations` | Bot-reachable channel ids from step 2 |
| `text_replacements`, `filters.reject_shouty`, `filters.min_length` | Optional, as for Telegram ([README](../README.md#sources)) |
| `flow` | `{ "enabled": true }` sends the channel to TheFlow (enrichment, routing by topic) instead of `destinations`; costs model quota per message |

`mode` and `poll_interval_min` do not apply: the source only listens.

Role mentions and custom emoji of the source server mean nothing on yours:
in a forwarded embed they stay as raw `<@&…>` and `<:name:id>`. Remove them
with two regex `text_replacements`, pattern `<@&[0-9]+>[ ]*` and
`<a?:[A-Za-z0-9_]+:[0-9]+>[ ]*`, flags `g`. Mentions never ping: delivery
puts the text in an embed.

What the keywords are matched against: the message text **and the text of
its embeds** (title, description, fields) — bots and announcement feeds often
post an empty message with everything in an embed. Image and video
attachments and embed images are forwarded (up to 4); other files are not.

### 5. Check a channel before relying on it

```bash
npm run seed
node src/cli.js discord check 123456789012345678 --limit 30
```

`discord check` reads the latest messages through the account (one request)
and marks what the filter would pass (`✓`) and drop (`·`). A 403/404 means the
account cannot read the channel. Tune `keywords`, seed again, check again.
More in [Checking a channel](#checking-a-channel-discord-check) below.

### 6. Start and watch

```bash
node src/cli.js flow preflight      # blocks without DISCORD_USER_TOKEN or with a bad destination id
pm2 restart inemuri                 # or npm start on the dev copy
```

`.env` options, all with working defaults:

| Variable | Default | |
|---|---|---|
| `DISCORD_SOURCE_TRANSPORT` | `library` | `own` — the own client instead of the archived library |
| `DISCORD_SOURCE_SHADOW` | `false` | `true` — run the other transport alongside and compare ([Shadow](#shadow-comparing-the-transports)). **Recommended for the first week** |
| `DISCORD_SOURCE_MAX_RSS_MB` | `450` | Restart the reader above this memory |
| `DISCORD_SOURCE_HEAP_MB` | `256` | Heap ceiling of the reader |
| `DISCORD_SOURCE_STATS_MIN` | `10` | How often the stats line is logged |

In the log, in this order:

1. `[DISCORD] reader (library) ready as <account>: N server(s), watching M channel(s)` —
   logged in. With the shadow on, the same line again with `[DISCORD:shadow own]`.
2. `… channel(s) not visible to the account …` — only if some configured
   channel cannot be read; it lists them by name. Fix or deactivate them.
3. Every 10 minutes `[DISCORD] stats …` and, with the shadow,
   `[DISCORD] shadow own vs library: …` — what to expect is in
   [The stats line](#the-stats-line).

Healthy after a day: `rss` flat, `watched` equal to the number of channels,
`seen` growing, `matched` > 0, and forwarded posts in the destination
channels. With the shadow: `only-library=0`.

Adding or changing a channel later: edit `sources.json`, `npm run seed`,
restart — the channel list is read at startup.

## How it runs

```text
inemuri (main process)                           child process (fork)
DiscordSelfSource ── watch, login(token) ──IPC──> selfbotChild.js | ownChild.js
  filters → message.received / FlowIngest <──IPC── message (plain object)
  watchdog: RSS, restarts                 <──IPC── status, stats, log
```

- `src/sources/discord/DiscordSelfSource.js` (main process) loads the active
  discord sources, starts the child, and handles what comes back: filters and
  classic forwarding or `FlowIngest`, the status board's last-seen time, the
  stats line.
- The child is one of two **transports**, chosen by
  `DISCORD_SOURCE_TRANSPORT`:
  - `library` (default) — `transport/selfbotChild.js` on
    `discord.js-selfbot-v13`, with CloakCord's cache limits;
  - `own` — `transport/ownChild.js` on the own client,
    [`src/lib/discord-user-client`](../src/lib/discord-user-client/README.md):
    no object cache, keeps only server and channel ids from READY.

  Both speak the same IPC and send the parent only messages from watched
  channels, as the same plain objects (`normalizeMessage` /
  `fromRawMessage`); the parent cannot tell them apart.
- The token travels over IPC, not in the child's arguments, which any user
  on the host can list.
- Pure parts, tested: `discordMessage.js` (normalize, text with embeds, media
  URLs, the classic pass rule) and `supervisor.js` (restart delay, fatal close
  codes, RSS verdict, stats line).

### Why a child process

The library keeps a cache of every server the account is in, and it forces
all gateway events of all those servers on a user account. In CloakCord this
grew without bound: every member seen in any event stayed cached (heap
snapshots, 2025-08: +1 000 `GuildMember` in 4 minutes against 55 messages).
The fix, carried over unchanged, limits the caches through `makeCache`:
members and users to the account itself plus one, messages, presences,
reactions and voice states to zero. Verified on CloakCord: 19 h on 92
servers, RSS flat at 205–250 MB, heap 65–72 MB.

The baseline (servers, channels, roles, permission overwrites) cannot be
limited and grows with the number of servers the account is in. Leaving
servers you do not need is the only way to shrink it.

The child process makes any remaining problem the child's alone:

| Event | What happens |
|---|---|
| RSS above `DISCORD_SOURCE_MAX_RSS_MB` (450) | The child is killed and restarted |
| Heap above `DISCORD_SOURCE_HEAP_MB` (256) | V8 stops the child; it is restarted |
| Crash, lost connection the library gave up on, no READY within 2 min | Restart after 30 s, doubling to at most 15 min; READY resets it |
| Token refused (login, or gateway close 4004) | **No restart.** Error in the log: fix `DISCORD_USER_TOKEN` and restart Inemuri. Repeated logins with a dead token are what anti-abuse watches |
| Inemuri stops | The child is asked to exit, killed after 5 s; a child whose parent died exits by itself |

### The stats line

Every `DISCORD_SOURCE_STATS_MIN` (10) minutes:

```text
[DISCORD] stats uptime=120m rss=210MB heap=70MB | guilds=92 channels=15188 members=170 users=2 | events=8123 watched=74/76 seen=310 | matched=14 ingested=0 errors=0
```

| Field | Expected |
|---|---|
| `rss` | Rises in the first hour, then flat. Steady growth is a leak — compare `members` |
| `members`, `users` | At most ~2 per server and 1–2; growth means a cache escaped its limit |
| `events` | Every message the account saw on any server |
| `watched` | Configured channels visible to the account / configured |
| `seen` | Messages from watched channels, before filters |
| `matched` | Passed the filter and went to classic forwarding |
| `ingested` | New posts in TheFlow |

`seen=0` with `watched` below total: the account lost access. `seen>0`,
`matched=0`: the keywords did not occur. With the `own` transport `members`
and `users` are always 0 and `channels` counts only channel ids.

### Large servers

Discord sends a user account `MESSAGE_CREATE` automatically only from
servers under 75 000 members; from larger ones nothing arrives until the
client subscribes (gateway op 37). The `own` transport subscribes to large
servers that hold a watched channel, right after READY
(`subscribed to N large server(s)` in the log). The `library` transport does
not — a watched channel on such a server stays at `seen=0`. This may be part
of why CloakCord saw `matched=0` on keyword channels.

### Shadow: comparing the transports

`DISCORD_SOURCE_SHADOW=true` runs the other transport next to the chosen
one, as a second session of the same account (like a second open client).
The shadow forwards nothing; it only reports what it saw. On each stats
line of the main transport:

```text
[DISCORD] shadow own vs library: both=41 only-library=0 only-own=3 | since start both=… only-library=… only-own=…
```

Only messages older than a minute are compared (the other side may lag).
`only-…` above zero is a warning. The shadow has its own stats line
(`[DISCORD:shadow own] stats …`), its own watchdog and restarts; a refused
token stops it without touching the main transport.

### Checking a channel: `discord check`

```bash
node src/cli.js discord check 123456789012345678 --limit 20
```

Reads the channel's latest messages through the account (REST, one
request; the own client's `RestClient`) and prints them oldest first. With a
discord source for that channel in the database, each line shows whether
classic forwarding would pass it (`✓`) or not (`·`), or `→` for a TheFlow
source. Use it while writing `sources.json`: it shows that the account can
read the channel (403/404 otherwise) and what the keywords catch. Needs
`DISCORD_USER_TOKEN` and runs without the service.

## Limits

- **No history.** What is posted while Inemuri is down is lost (as Telegram
  `listener`). The own client can read a channel's history (`RestClient`), but
  only `discord check` uses it; backfilling after downtime is not built.
- **Edits and deletes are ignored.** A post that gets its keyword in an edit
  is not forwarded.
- **Threads:** a message in a thread has the thread's id, not the channel's,
  so it is only seen if the thread itself is configured.
- **Media links expire.** Discord CDN links are signed for about a day.
  Classic forwarding downloads at once; a TheFlow post keeps the links and
  downloads at delivery, which happens within `FLOW_DELIVERY_MAX_AGE_HOURS`
  (24) — a post delivered late can lose its image.
- **The library is dead.** `discord.js-selfbot-v13` is archived and
  deprecated (3.7.0, pinned exactly), and GPL-3.0. It is an npm dependency
  only, never copied or modified here. When Discord changes what a user
  client must send, it will break with no fix upstream.
- **Neither transport looks like a browser at the TLS level.** Node's TLS
  fingerprint is not Chrome's (discord.py-self imitates it with curl_cffi).
  This is also why the own client sends no `Origin` header on the gateway
  handshake: with it Cloudflare answers 403.

## Next: switching to the own client

The own client is built and checked against the real gateway with an empty
token (HELLO over zlib-stream, IDENTIFY, close 4004, no retry). Not yet with
a real account. The rollout:

1. Run `library` with `DISCORD_SOURCE_SHADOW=true` for about a week: the
   shadow line should show `only-library=0`; `only-own` > 0 is expected on
   large servers (the library does not subscribe to them).
2. Switch: `DISCORD_SOURCE_TRANSPORT=own`, keep the shadow for a few days the
   other way round.
3. Remove `discord.js-selfbot-v13`, `selfbotChild.js` and the transport
   switch.

When Discord changes the user-client protocol, compare
`src/lib/discord-user-client/protocol.js` and `properties.js` with
discord.py-self (the module's README maps each value to its file there).

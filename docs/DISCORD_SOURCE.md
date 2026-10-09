> **Role:** Spec of the Discord source (platform `discord`) · **Audience:** Anyone configuring, running or changing it

# Discord as a source

Sources with `"platform": "discord"` read channels on Discord servers the
operator does not run, through a **user account**. Messages go through the
same replacements and filters as every other source, then to classic
forwarding or TheFlow. This replaces CloakCord, a separate service that did
the same with its own webhooks and database.

Delivery to Discord is unrelated: it stays on the bot (`DISCORD_BOT_TOKEN`,
REST). discordapp is unrelated too — the source neither uses nor needs it.

## The account

- **Automating a user account is against Discord's terms.** The account can be
  banned without warning. Use a dedicated secondary account that only reads;
  never send from it.
- The token goes in `.env` as `DISCORD_USER_TOKEN`, nowhere else. Without it
  the discord sources are not started (one warning at startup) and
  `flow preflight` reports a blocker.
- The account sees what it has joined. A configured channel it cannot see is
  listed by name at startup (`… not visible to the account`) and shows in the
  stats line as `watched=visible/total`.

## Configuring a source

One entry per channel in `src/config/sources.json`:

```json
{
  "platform": "discord",
  "channel_id": "123456789012345678",
  "channel_name": "Server name · #announcements",
  "filters": { "enabled": true, "keywords": ["airdrop", "giveaway"], "blacklist": [], "case_sensitive": false },
  "destinations": { "telegram": [], "discord": ["234567890123456789"] }
}
```

- `channel_id` is the **channel** id (17–20 digits; Developer Mode → Copy
  Channel ID), not the server id. The seeder refuses anything else.
- `channel_name` is the embed author on delivery, so put the server name in it.
- `filters`, `text_replacements` and `destinations` work as for Telegram
  ([README](../README.md#sources)). An empty `keywords` list forwards
  everything, including posts that are only an image.
- `flow` puts the channel through TheFlow instead.
- `mode` and `poll_interval_min` do not apply: the source only listens.
- Run `npm run seed` after editing, then restart. The channel list is read at
  startup.

What is matched and forwarded: the message text **and the text of its
embeds** (title, description, fields) — bots and announcement feeds often
post an empty message with everything in an embed. Image and video
attachments and embed images are downloaded and forwarded (up to 4); other
files are not.

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

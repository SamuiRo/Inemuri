# discord-user-client

A minimal, read-only Discord client for a **user account**: the gateway
(`MESSAGE_CREATE`, which servers and channels the account sees) and REST
(a channel's messages). No object cache — memory does not grow with the
account. Inside Inemuri it is the `own` transport of the Discord source
([docs/DISCORD_SOURCE.md](../../../docs/DISCORD_SOURCE.md)).

Automating a user account is against Discord's terms; use a dedicated,
read-only account.

## Boundary

Self-contained so it can move to its own package unchanged: it imports only
its own files, `node:` built-ins and `ws`, and never reads the environment —
`test/discord-user-client.test.js` enforces it. Token, logger and options are
passed in.

| File | What |
|---|---|
| `protocol.js` | Pure gateway core: opcodes, capabilities, packets, `decide(state, packet)`, `closeAction`, READY/guild summaries |
| `properties.js` | Pure: super properties of the Chrome web client, user agent, launch signature, build number parsing |
| `rest.js` | Pure: paths, headers, `parseRateLimit` |
| `ClientIdentity.js` | Resolves build number (discord.com/login) and Chrome version (versionhistory.googleapis.com), with fallbacks |
| `ZlibStream.js` | `compress=zlib-stream` decompression |
| `GatewayClient.js` | Socket and timers: heartbeat, resume, reconnect, subscriptions |
| `RestClient.js` | One request at a time, gap between requests, 429 waits |

```js
import { GatewayClient, RestClient, resolveClientIdentity } from "./index.js";

const identity = await resolveClientIdentity({ log });
const gateway = new GatewayClient({ token, identity, log });
gateway.on("ready", ({ user, guilds }) => { /* guilds: [{ id, name, memberCount, channelIds }] */ });
gateway.on("message", (raw) => { /* raw MESSAGE_CREATE */ });
gateway.on("fatal", ({ reason }) => { /* token refused: stop, do not retry */ });
gateway.connect();

const rest = new RestClient({ token, identity });
const page = await rest.messages(channelId, { limit: 50 });
```

## Protocol reference

Values follow **discord.py-self** (MIT, actively maintained), which picks up
changes to the user-client protocol first. Knowledge, not code. When Discord
changes something, compare with these files there:

| Here | There |
|---|---|
| `OP`, `identifyPacket`, `resumePacket`, `heartbeatPacket` (op 40, QoS v27), `timeSpentPacket` (op 41), `voiceStatePacket` | `discord/gateway.py` (`DiscordWebSocket`, `KeepAliveHandler`) |
| `CAPABILITIES` | `discord/flags.py`, `Capabilities.default()` |
| `superProperties`, `chromeUserAgent`, `launchSignature`, build number | `discord/tracking.py`, `HeadersContext.default()` |
| `AUTO_SUBSCRIBE_MAX_MEMBERS`, `subscribePacket` (op 37) | `discord/state.py`, `GuildSubscriptions` |
| `guildSummary` (`properties`, `channels`, `threads`) | `discord/state.py`, `parse_ready_supplemental` |

Deliberate differences:

- **No `auth_token_refresh` capability.** With it the server may hand out a new
  token in READY, which nothing could write back to `.env`.
- **No `Origin` header on the gateway handshake.** With
  `Origin: https://discord.com` Cloudflare answers 403 (checked 2026-10-09),
  most likely because Node's TLS fingerprint is not a browser's. discord.py-self
  impersonates Chrome's TLS through curl_cffi; Node cannot, so this client is
  distinguishable from a browser at the TLS level — as the old library was.
- **No third-party info API.** discord.py-self first asks cordapi.dolfi.es for
  ready-made properties; here the build number is read from discord.com/login
  (their fallback path).
- **Servers of 75 000+ members** do not send `MESSAGE_CREATE` until subscribed;
  `guildsToSubscribe` + `subscribe()` (op 37, `typing: true`) do it only for
  servers with watched channels.

## Not built

Voice, sending anything, member lists, presence, interactions, captcha,
remote auth. `MESSAGE_UPDATE` / `MESSAGE_DELETE` are ignored.

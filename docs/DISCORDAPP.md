> **Role:** Specification of the discordapp subsystem — decisions, module layout, feature contracts, work plan · **Audience:** Anyone implementing or changing Inemuri's Discord server management

# discordapp — Discord server management

discordapp is the part of Inemuri that **manages Discord servers**: it answers
slash commands and buttons, exports channel history, hands out roles, and
provisions a server from a declarative config. It is a module of Inemuri, not a
separate bot — it runs in the same process, shares the database and the
`EventBus`, and is built so that it could be cut out into its own process later
without rewriting its logic.

The bot is **private**: it serves only the operator's own servers, several of
them, and is never offered for public install.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Same process, hard module boundary.** discordapp talks to the rest of Inemuri only through `EventBus` events; the core never imports discordapp. | Its most valuable features read core data (`posts`, `sources`), and a second process would need IPC, a second SQLite writer and a split gateway session for the same token. The boundary keeps a later split mechanical. |
| D2 | **Delivery does not use the gateway.** `DiscordDestination` sends through REST only (`src/module/discord/DiscordRest.js`). The gateway session belongs to discordapp alone. | Forwarding must never depend on the bot being up. Before this, a failed Discord login stopped the whole process, Telegram-to-Telegram forwarding included. |
| D3 | **discordapp starts last and never stops the process.** A failed login is a warning and a background retry. `DISCORD_APP_ENABLED=false` switches it off. | Server management is an operator convenience; delivery is the product. |
| D4 | **Business logic is pure functions.** Config validation, the provisioning planner, export formatters, permission guards and customId parsing take plain data and return plain data. The code that calls Discord is a thin shell around them. | Testable with `node --test` and no Discord, like the rest of the repo's pure layers. |
| D5 | **Everything is ephemeral.** The registry defers every reply as ephemeral before a handler runs, so no handler can post publicly by accident. Slash-command invocations themselves are never visible to other members when the reply is ephemeral. | No channel noise from managing the server. |
| D6 | **Commands are registered per guild, never globally**, and are never unregistered on shutdown. | Guild commands appear instantly; global ones take time to propagate, and unregistering on every stop made them flicker across restarts and burned registration rate limit. |
| D7 | **Admin commands fail closed.** They require the user to be in `DISCORD_COMMAND_WHITELIST`; an empty whitelist denies them. They also carry `default_member_permissions = Administrator`, which hides them from everyone else in the client. | Export reads private channels; provisioning rewrites the server. |
| D8 | **Guild allowlist, no auto-leave.** `DISCORD_GUILD_IDS` lists the servers discordapp serves; interactions from any other guild are refused and logged. An empty list means every guild the bot is in. The bot never leaves a guild on its own. | The bot is private (Public Bot off in the Developer Portal). Auto-leave would turn a missing env entry into the bot kicking itself from the operator's own server. |
| D9 | **Provisioning never deletes.** A managed channel removed from the config is moved into a mandatory private archive category; restoring it is putting it back in the config. Roles removed from the config are reported, never touched. | Deletion loses history irreversibly; an archive keeps it one config line away. |
| D10 | **Self-assign roles cannot carry dangerous permissions** and must sit below the bot's highest role. Checked when a panel is validated, not when a button is pressed. | One config typo must not become "anyone can click to get admin". |
| D11 | **Stateless components.** A button's `customId` encodes everything its handler needs (`<feature>:<action>:<args>`). | Buttons keep working across restarts with no table behind them. |

## Module layout

```text
src/module/discord/                  # transport, shared
  DiscordRest.js                     # REST client + payload conversion; used by delivery and discordapp
  DiscordGateway.js                  # gateway session (discord.js Client); used by discordapp only
src/module/discordapp/
  DiscordApp.js                      # lifecycle: soft start, login retry, command registration
  CommandRegistry.js                 # routes commands and components, enforces D5
  guard.js                           # pure: who may run what, in which guild
  commands/                          # one file per slash command
  features/
    export/                          # /export-chats
    roles/                           # role panels and their buttons
    provision/                       # server-as-code: schema, planner, applier, state
src/config/discordapp/               # git-ignored deployment data + *.sample
  servers/<name>.json
  messages/*.md
```

### Command module contract

```js
export default {
  data: new SlashCommandBuilder().setName("export-chats") /* ... */,
  admin: true,                                   // D7
  async execute(interaction, ctx) {              // ctx = { eventBus, rest, ... }
    return "text" | { content, files };          // edited into the deferred ephemeral reply
  },
};
```

A component handler has the same shape with `prefix` instead of `data`, and is
routed by the part of `customId` before the first `:`.

## Permission model

The bot is invited with a minimal set and never holds `Administrator` in
normal operation:

| When | Permissions |
|---|---|
| Always | `ViewChannel`, `ReadMessageHistory`, `SendMessages`, `EmbedLinks`, `AttachFiles`, `ManageRoles` |
| During `/provision apply` | `Administrator`, through a separate role (e.g. `Inemuri Setup`) the operator assigns to the bot before applying and removes afterwards |

Three rules follow from how Discord checks permissions:

1. **Discord refuses an overwrite that grants a permission the bot does not
   hold**, so `apply` always runs elevated. A preflight check refuses to start
   and says which role to assign, instead of failing halfway.
2. **Role hierarchy is independent of `Administrator`.** The bot's highest role
   must stay above every role it provisions or hands out.
3. **Without `Administrator` the bot cannot see private channels** — the
   archive, staff areas, opt-in groups — unless it has its own overwrite there.
   The planner adds `ViewChannel` + `ReadMessageHistory` for the bot's role to
   every private category and channel automatically. It is not something the
   config has to remember.

Reading message content additionally needs the **Message Content** privileged
intent enabled in the Developer Portal. Without it Discord returns empty
`content`, `embeds` and `attachments` for other users' messages — over REST
too, not only on the gateway.

## Feature: `/export-chats`

> **Implemented (v4.32.0).** Code: `src/module/discordapp/commands/export-chats.js`,
> `src/module/discordapp/features/export/` — `collector.js` (the only part that
> calls Discord), `snapshot.js` and `format.js` (pure), `ChatExporter.js`.

`/export-chats limit:<1–100> format:<md|json|both> scope:<this|all>`, admin.
Defaults: `format: md`, `scope: this`. `scope: all` means every server in
`DISCORD_GUILD_IDS` (or every server the bot is in, when that is empty).

- Walks every text-bearing channel the bot can read: text, announcement, the
  text chat of voice channels, and **threads** — active and archived, which is
  the only place a forum channel has messages.
- One REST request per channel: `limit` is at most 100, which is exactly one
  page of the API. Channels the bot cannot read are listed in the file as
  `skipped: no access`, not silently dropped. Three channels are read at a time
  (`DISCORD_EXPORT_CONCURRENCY`).
- Archived threads: one API page (100) per channel
  (`DISCORD_EXPORT_ARCHIVED_THREADS`), private ones only where the bot has
  `ManageThreads`. A channel with more is marked "older archived threads not
  exported" rather than turning a large forum into thousands of requests.
- Messages come newest first and are reversed into chronological order.
- **Markdown** (default, for reading and for LLM analysis): server → category →
  channel headings, one line per message
  `[2026-09-29 14:02] author: text`, with reply, attachment and reaction
  markers. **JSON**: the full structure with ids, reply targets, attachments,
  reactions and thread parentage.
- The file is always written to the git-ignored `exports/` directory, and is
  attached to the ephemeral reply when it fits `DISCORD_UPLOAD_LIMIT_MB`
  (20 MB, measured), gzipped otherwise. Attachment URLs inside it are signed CDN
  links and expire.
- Progress is edited into the reply at most every 2 s. An interaction token
  lives 15 minutes; a run longer than that still writes its files to disk and
  logs their names — the reply is what is lost. (A log channel for this is
  future work.)
- **Missing Message Content intent is detected**, not just documented: when at
  least 80% of five or more human, non-system messages come back with no text,
  attachment, embed or sticker, the reply says to enable the intent. 80%, not
  100%, because messages that mention the bot keep their text without it.

The formatters are pure: `(guildSnapshot, messagesByChannel) → string`.

## Feature: role panels

A panel is a message with buttons, each toggling one role.

- `customId` = `roles:<mode>:<panelKey>:<roleId>` (D11).
- Modes: `toggle` (press to add, press again to remove) and `exclusive` (one
  role of the group at a time — pressing one removes the others).
- More than 25 roles in a panel uses a select menu instead of buttons
  (a message holds at most 5 rows of 5 buttons).
- The reply is ephemeral: `Added: X · Removed: Y`.
- Panels are **declared in the provisioning config** as a message kind, not
  created by a separate command: a panel is part of the server's shape.

**Opt-in groups** are the main use: a narrow category that appears for members
who press a button and disappears when they press it again. The config states
it once and the planner expands it:

```json
{ "key": "rust", "name": "🦀 RUST", "optIn": { "role": "topic-rust", "panel": "topics" }, "channels": [] }
```

expands to `@everyone` deny `ViewChannel`, `topic-rust` allow `ViewChannel`,
the bot's own overwrite, and a `topic-rust` button in the `topics` panel.

Validation refuses (D10) a self-assign role that carries any of
`Administrator`, `ManageGuild`, `ManageRoles`, `ManageChannels`,
`ManageWebhooks`, `BanMembers`, `KickMembers`, `ModerateMembers`,
`ManageMessages`, `MentionEveryone`, or sits at or above the bot's highest role.

## Feature: provisioning (server as code)

A server's shape — roles, categories, channels, permission overwrites, pinned
content, role panels, AutoMod rules — is described in
`src/config/discordapp/servers/<name>.json` and applied Terraform-style:
**plan, then apply**.

### Config

```json
{
  "guildId": "123456789012345678",
  "archive": { "key": "archive", "name": "🗄 ARCHIVE", "roles": ["admin"] },
  "presets": {
    "readonly": { "@everyone": { "allow": ["ViewChannel", "ReadMessageHistory"], "deny": ["SendMessages"] } },
    "staff":    { "@everyone": { "deny": ["ViewChannel"] }, "role:mod": { "allow": ["ViewChannel"] } }
  },
  "roles": [
    { "key": "mod", "name": "Moderator", "color": "#e67e22", "hoist": true,
      "permissions": ["ManageMessages", "KickMembers", "ModerateMembers"] },
    { "key": "topic-rust", "name": "Rust", "permissions": [] }
  ],
  "categories": [
    { "key": "info", "name": "📌 INFO", "overwrites": "readonly", "channels": [
      { "key": "rules", "name": "rules", "type": "text",
        "messages": [{ "key": "rules-main", "file": "messages/rules.md", "embed": true }] },
      { "key": "get-roles", "name": "get-roles", "type": "text",
        "messages": [{ "key": "topics", "rolePanel": { "mode": "toggle", "roles": ["topic-rust"] } }] }
    ]}
  ],
  "automod": []
}
```

- **Identity is the `key`**, stable across renames; ids are unknown before the
  first apply. Renaming a channel in the config is an edit, not a new channel.
- **Permissions are named by `PermissionFlagsBits`**; an unknown name fails
  config loading, as a malformed local config already does.
- `presets` keep a shared overwrite set in one place; overwrites refer to roles
  as `role:<key>` and to `@everyone` by name.
- Message bodies live in `.md` files next to the config.
- `"requires": "community"` on a resource skips it on a non-Community server.
  Without the flag, a Community-only resource (announcement channels, rules and
  updates channels, onboarding) on a plain server is a **plan error** with the
  reason — never a failure halfway through apply. The planner reads
  `guild.features`.
- The archive block is **mandatory**; a config without it does not validate.

### State

Migration `009` adds `discord_resources(guild_id, kind, key, discord_id,
content_hash, archived_at, archived_from)`.

- `key → discord_id` is what makes an update reliable instead of a guess by name.
- `content_hash` makes a message **edited in place** when its `.md` changes,
  never reposted.
- The first plan on an existing server **imports**: resources matching config
  entries by name are adopted into state.

### Plan and apply

`planner(desired, current, state) → ops` is a pure function. Each op is one of:

| Op | Meaning |
|---|---|
| `+ create` | In config, not on the server |
| `~ update` | Managed, differs from the config |
| `→ archive` | Managed channel no longer in the config: moved into the archive, permissions synced to it, previous parent recorded |
| `← restore` | Archived channel back in the config: moved to its declared place, overwrites reapplied |
| `? unmanaged` | On the server, not in state — reported, never touched |
| `? orphaned` | Managed role no longer in the config — reported, never touched |

`/provision plan server:<name>` shows the ops and changes nothing.
`/provision apply server:<name>` recomputes the plan, shows it, and runs it only
after an ephemeral confirm button. Apply order: roles → role positions →
categories → channels with overwrites → channel positions → messages and
panels → AutoMod. Every step is idempotent; a rerun after a failure continues
where the last one stopped.

A category holds at most 50 channels, so the archive rolls over into
`archive-2`, `archive-3`, … under the same permissions.

### AutoMod

AutoMod rules (keyword, keyword preset, spam, mention spam) are another
resource kind, applied last. They need `ManageGuild`, which apply already has.
Discord caps how many rules of each type a guild may hold; the validator checks
the caps before apply.

### `/provision export`

The reverse direction: snapshot an existing server into the config format, so
the first config is edited rather than written from scratch.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Bot token. Without it neither delivery nor discordapp runs; the rest of Inemuri does. |
| `DISCORD_APP_ENABLED` | `true` | `false` skips the gateway session entirely. Delivery is unaffected. |
| `DISCORD_GUILD_IDS` | empty | Comma-separated guilds discordapp serves (D8). Empty = every guild the bot is in. |
| `DISCORD_COMMAND_WHITELIST` | empty | Comma-separated user ids allowed to run admin commands (D7). Empty = nobody. |
| `DISCORD_UPLOAD_LIMIT_MB` | `20` | Largest file sent as an attachment, by delivery and by export. |

## Work plan

| # | Step | Status |
|---|---|---|
| 0 | This specification | Done (v4.30.2) |
| 1 | REST-only delivery, `DiscordGateway`, `DiscordApp` skeleton: soft start, per-guild registration, guild allowlist, fail-closed guard, ephemeral registry | Done (v4.31.0) |
| 2 | `/export-chats` | Done (v4.32.0) |
| 3 | Provisioning config schema and validator, pure planner with tests, `/provision plan` with permission preflight | — |
| 4 | State migration, applier, import, archive and restore, `/provision apply` with confirmation | — |
| 5 | Messages from `.md` edited in place, role panels, opt-in groups | — |
| 6 | AutoMod as a resource | — |
| 7 | `/provision export` | — |

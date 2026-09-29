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
- The file is written to the git-ignored `exports/` directory and, when
  `DISCORD_EXPORT_TELEGRAM_CHAT` is set, also sent to that Telegram chat
  (v4.39.0). **It is not attached in Discord** — a whole server's messages
  should not sit as an attachment there; the Discord reply is a short summary.
  The Telegram copy goes through `EventBus` → `MessageRouter` →
  `TelegramDestination`, the same path as forwarding (D1: discordapp does not
  call Telegram itself), so its failures land in the same log. Telegram's
  limit is 2 GB, so nothing is compressed. Attachment URLs inside the export
  are signed CDN links and expire.
- No progress updates (v4.38.1): Discord already shows the deferred reply as
  "thinking…", and every update would be one more request. An interaction
  token lives 15 minutes; a run longer than that still writes its files to
  disk and logs their names — the reply is what is lost.
- **Missing Message Content intent is detected**, not just documented: when at
  least 80% of five or more human, non-system messages come back with no text,
  attachment, embed or sticker, the reply says to enable the intent. 80%, not
  100%, because messages that mention the bot keep their text without it.

The formatters are pure: `(guildSnapshot, messagesByChannel) → string`.

## Feature: role panels

> **Implemented (v4.35.0).** Code: `src/module/discordapp/features/roles/rolePanel.js`
> (pure), `src/module/discordapp/components/role-panel.js` (the button),
> `features/provision/messages.js` (renders the panel).

A panel is a message with buttons, each toggling one role.

- `customId` = `roles:<t|x>:<roleId>` (D11). The exclusive group is every
  panel button on the same message, read from the message itself — there is
  no panel table.
- Modes: `toggle` (press to add, press again to remove) and `exclusive` (one
  role of the group at a time — pressing one removes the others).
- At most 25 roles per panel (5 rows of 5 buttons); more is a config error.
  A select menu for larger panels is future work.
- Buttons are open to every member of a served server, not only admins. The
  reply is ephemeral: `✅ Added @X` / `➖ Removed @Y`.
- Panels are **declared in the provisioning config** as a message kind, not
  created by a separate command: a panel is part of the server's shape.
- Button labels default to the role name; `{ "role": "key", "label": "…",
  "emoji": "🦀" }` overrides either. Only plain emoji — a custom one has an id
  that differs between servers.

**Opt-in groups** are the main use: a narrow category that appears for members
who press a button and disappears when they press it again. The config states
it once and the planner expands it:

```json
{ "key": "rust", "name": "🦀 RUST", "optIn": { "role": "topic-rust", "panel": "topics" }, "channels": [] }
```

expands to `@everyone` deny `ViewChannel`, `topic-rust` allow `ViewChannel`,
the bot's own overwrite, and a `topic-rust` button in the `topics` panel.

`optIn` keeps the category's other `@everyone` bits and only takes
`ViewChannel` away; its channels inherit it like any category's overwrites.
`panel` is optional — without it the role is handed out some other way.

A self-assign role is refused (D10) if it carries any of `Administrator`,
`ManageGuild`, `ManageRoles`, `ManageChannels`, `ManageWebhooks`,
`ManageGuildExpressions`, `ManageEvents`, `ManageThreads`, `ManageMessages`,
`ManageNicknames`, `BanMembers`, `KickMembers`, `ModerateMembers`,
`MentionEveryone`, `ViewAuditLog`, is managed by an integration, or sits at or
above the bot's highest role. Checked three times: by the validator for
permissions the config sets, by the planner for the role's permissions on the
server (someone may have added them by hand), and **on every button press**.

## Feature: provisioning (server as code)

A server's shape — roles, categories, channels, permission overwrites, pinned
content, role panels, AutoMod rules — is described in
`src/config/discordapp/servers/<name>.json` and applied Terraform-style:
**plan, then apply**.

> **Plan implemented (v4.33.0), apply (v4.34.0).** Code:
> `src/module/discordapp/features/provision/` — `schema.js`, `overwrites.js`,
> `planner.js`, `formatPlan.js` (pure), `readGuild.js` (reads Discord),
> `applier.js` (writes Discord), `configStore.js`, `Provisioner.js`; command
> `commands/provision.js`. Messages and role panels since v4.35.0; AutoMod is
> a later step and the validator does not accept `automod` yet. A working
> starting point is `servers/example.sample.json` with `messages/rules.sample.md`.

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
- **Messages.** A text or announcement channel may carry `messages`: either
  `{ "key", "file": "rules.md", "embed"?: true | { "title"?, "color"? } }`
  with the text in `src/config/discordapp/messages/` (git-ignored except
  `*.sample.md`), or `{ "key", "rolePanel": { "mode"?, "text"?, "roles" } }`.
  Text over Discord's limit (2000, or 4096 in an embed) is a config error
  before anything is read from the server. Provisioned messages never ping:
  `@everyone` in a rules text is text.
- `"requires": "community"` on a resource skips it on a non-Community server.
  Without the flag, a Community-only resource (announcement channels, rules and
  updates channels, onboarding) on a plain server is a **plan error** with the
  reason — never a failure halfway through apply. The planner reads
  `guild.features`.
- The archive block is **mandatory**; a config without it does not validate.
- **Only what is set is managed.** A role without `color` keeps whatever color
  it has; a channel without `topic` keeps its topic; a category or channel
  whose chain declares no `overwrites` keeps its permissions. The name is
  always managed. Fields starting with `_` are comments.
- **Overwrites inherit.** A channel's effective overwrites are its category's
  plus its own, its own winning for the same target. A channel that declares
  none is therefore in sync with its category.
- **Overwrites of targets the config does not manage are kept.** Managed
  targets are `@everyone`, the bot and the config's roles; for those the
  config is authoritative, and an extra overwrite is removed. A manual
  per-member overwrite or one for a role outside the config is carried over
  untouched — Discord replaces a channel's overwrites as a whole, so the
  applier passes them back explicitly.
- Text-like channel names are compared the way Discord stores them — lowercase,
  spaces as dashes — so `"Staff Chat"` does not show up as a rename forever.
- Configs are read on every command, not at startup: edit, plan, apply, no
  restart. `server:` picks a config by file name; without it the one whose
  `guildId` matches the server is used.

### State

Migration `009` adds `discord_resources(guild_id, kind, key, discord_id,
content_hash, archived_at, archived_from)`.

- `key → discord_id` is what makes an update reliable instead of a guess by name.
- `content_hash` makes a message **edited in place** when its `.md` changes,
  never reposted.
- The first plan on an existing server **imports**: resources matching config
  entries by name are adopted into state (`⇄ adopt`). Two resources with the
  same name are a plan error — adoption never guesses.

### Plan and apply

`planner(desired, current, state) → ops` is a pure function. Each op is one of:

| Op | Meaning |
|---|---|
| `+ create` | In config, not on the server |
| `⇄ adopt` | Exists on the server under the configured name, not yet in state: taken over, then updated like any managed resource |
| `~ update` | Managed, differs from the config |
| `→ archive` | Managed channel no longer in the config: moved into the archive, permissions synced to it, previous parent recorded |
| `← restore` | Archived channel back in the config: moved to its declared place, overwrites reapplied |
| `? unmanaged` | On the server, not in state — reported, never touched |
| `? orphaned` | Managed role or category no longer in the config — reported, never touched |
| `· forget` | Managed channel deleted on Discord by hand — only its state row goes |
| `⏭ skip` | `requires: community` on a plain server |
| `+ post` | Message not posted yet, deleted by hand, or moved to another channel in the config (the old copy stays) — posted at the end of its channel |
| `~ edit` | The rendered message differs from what was posted (compared by a hash in state, not by reading the message) — **edited in place**, never reposted |
| `↕ reorder` | Roles or channels are not in config order. Order is applied by **slots**: the managed resources swap among the positions they already hold, so nothing outside the config moves |

`/provision plan server:<name>` shows the ops and changes nothing.
`/provision apply server:<name>` shows the same plan with **Apply** and
**Cancel** buttons, and only when there is something to apply, no plan error
and nothing blocking (Administrator). The Apply button carries a fingerprint of
the plan it was shown under; if the server or the config changed before the
click, nothing is applied and the plan has to be looked at again. The button
edits its own ephemeral message, so it cannot be pressed twice, and one apply
runs per server at a time.

Apply order: roles → role positions → categories → channels (create, update,
adopt, restore, archive) → channel positions → AutoMod → messages → state
cleanup. **After a phase that changed something, the server and the state
are read again and the plan recomputed**, so later phases see the ids of what
earlier ones created, and a rerun after a failure continues with whatever is
left. A phase that changed nothing costs no extra read (v4.38.1): applying to
a server that already matches is one read. A failed operation is logged and
the rest of its phase still runs. Apply shows no progress updates, only the
result.

When a moved or restored channel has no overwrites of its own in the config,
it is synced with its new category, as Discord does when a channel is dragged;
restored to no category, it only loses the archive's rights.

A category holds at most 50 channels, so the archive rolls over into
`archive-2`, `archive-3`, … under the same permissions.

### `archiveUnmanaged`

> **Implemented (v4.40.0).**

`"archiveUnmanaged": true` at the root of a config clears away what was made by
hand, still without deleting anything — for rebuilding a server after its
structure changed:

| On the server, not in the config or state | What happens |
|---|---|
| A channel | `→ archive`: moved into the archive, synced with its rights |
| A category | `→ hide`: gets exactly the archive's overwrites, so members no longer see it (a category cannot be put inside another) |
| A channel the server uses itself — Community rules, public updates, safety alerts, the system (welcome) channel, the AFK channel | `· keep`: left in place, and so is its category. Moving it would break Community settings and take the rules away from members |
| A role, an AutoMod rule | Reported only — there is no archive for them, and stripping a role's permissions is not "archiving" |

Nothing of this goes into state: an archived hand-made channel stays "not from
the config", and bringing it back is adding it to the config — the plan
adopts it by name. Off by default.

The plan's **Not in the config** section keeps three groups apart (v4.40.1):
`?` left as they are, `🗄` in the archive, `🙈` categories hidden with the
archive's rights — so what was put away does not read as "never touched".

### AutoMod

> **Implemented (v4.37.0).** Code: `features/provision/automod.js` (pure).

AutoMod rules are another resource kind, in the `automod` list of the config:

```json
{ "key": "scam-links", "name": "Scam links", "type": "keyword",
  "keywords": ["*free nitro*"], "regex": ["disc[o0]rd\\.gift"], "allow": [],
  "actions": [{ "type": "block", "message": "Looks like a scam" },
              { "type": "alert", "channel": "mod-log" },
              { "type": "timeout", "seconds": 600 }],
  "exempt": { "roles": ["mod"], "channels": [] }, "enabled": true }
```

- Types: `keyword` (`keywords`, `regex`, `allow`), `preset` (`presets`:
  `profanity`, `sexual-content`, `slurs`; `allow`), `spam`, `mention-spam`
  (`limit` 1–50, `raidProtection`). A field that does not apply to the type is
  an error. Discord's caps are checked before apply: 6 keyword rules, one of
  each other type, `timeout` only on keyword and mention-spam, list sizes and
  lengths. `alert` goes to a text channel of the config; `exempt` names roles
  and channels by key.
- Compared in a canonical form — sorted lists, the same shape for the config
  and for what Discord returns — so a rule does not show up as changed
  because Discord reordered its keywords.
- A rule of a type the server can hold only one of is **adopted by type**,
  whatever its name: a Community server already has one, and a second cannot
  be created.
- **Measured on a live server:** a rule Discord created itself (the default
  *Block Mention Spam* of a Community server) can be read but not edited — the
  API answers 404. Apply then fails that one rule with an explanation (delete
  it in Server Settings → AutoMod and apply again, or drop it from the config)
  and does **not** record it as managed, so the plan does not pretend
  otherwise.
- Reading rules needs Manage Server. Without Administrator the plan says it
  could not read them (a warning, not an error); apply has Administrator.
- Applied after channels, since alerts and exemptions need their ids. Never
  deleted: a rule removed from the config is reported as orphaned.

### `/provision export`

> **Implemented (v4.38.0).** Code: `features/provision/exporter.js` (pure).
> Also `node scripts/discordapp.js export <guildId>`.

The reverse direction: snapshot an existing server into the config format, so
the first config is edited rather than written from scratch. The file goes to
`exports/config-<server>.json` and is attached to the reply — never into the
configs folder, where it would start acting as a config.

The acceptance test is a round trip: the export, planned against the same
server, **only adopts**. The one deliberate exception is the bot's own
overwrite in private channels, which provisioning always sets (see Permission
model) and the export leaves out. Verified on the live test server.

- Keys come from state for resources already managed, from names otherwise
  (Latin letters, digits, dashes; `<kind>-N` for names without Latin letters;
  `-2` for repeats). Without the state lookup the plan would not recognise a
  managed resource under a new key and would propose a duplicate — found on
  the live server.
- A channel synced with its category gets no `overwrites`; one that is not
  gets its own, with an empty `{}` for a category target it lacks, so the
  inherited overwrite is neutralised. An empty overwrite and no overwrite are
  the same to Discord, and the plan treats them the same.
- An existing category named like "archive" becomes the archive block, with
  its view roles as the archive roles.
- Left out, and listed in the reply: per-member overwrites, the bot's
  overwrite, integration roles, media channels, channels already in the
  archive, AutoMod actions with no config equivalent, and messages.
- Permission bits discord.js does not know yet (bit 47 on the live server's
  `@everyone`) cannot be written in a config: the plan compares only known
  bits and the applier keeps unknown ones as they were.

## Setup

What the bot needs, once per server. The bot is private (D8); these steps
are the operator's.

**Developer Portal** (discord.com/developers → the application):

- *Bot* → **Message Content Intent** on (for `/export-chats`). Server Members
  and Presence intents stay off; nothing needs them.
- *Bot* → **Public Bot** off, so only the owner can invite it. (Discord asks
  for the Installation tab's install link to be set to *None* first.)

**Invite link** — replace `APP_ID` with the application id (*General
Information*):

```text
https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=17448422400
```

`17448422400` is the normal-operation set: `ViewChannel`, `SendMessages`,
`EmbedLinks`, `AttachFiles`, `ReadMessageHistory`, `ManageRoles`,
`ManageThreads` (the last one only so `/export-chats` can read private
archived threads). Both scopes matter: without `applications.commands` the
slash commands cannot be registered in that server.

**In the server:**

1. Server Settings → Roles: drag the bot's role (named like the bot) **above
   every role the config manages or a panel hands out**. Administrator does
   not bypass this.
2. Create a role with `Administrator`, e.g. `Inemuri Setup`, placed below the
   bot's role. Give it to the bot only for `/provision apply`, take it away
   after.

**`.env`:** the server id in `DISCORD_GUILD_IDS`, your user id in
`DISCORD_COMMAND_WHITELIST` (Developer Mode → right-click → Copy ID). Restart.
The log should list the server under "command(s) registered".

**Check it from the terminal** — read-only, safe next to the running service:

```bash
node scripts/discordapp.js check <guildId> [config]
```

It reports the bot's identity, where its role sits and what it lacks, the
registered slash commands, whether Message Content works, and the provisioning
plan. `node scripts/discordapp.js apply <guildId> [config]` shows the plan;
with `--yes` it applies it, exactly like the Apply button.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Bot token. Without it neither delivery nor discordapp runs; the rest of Inemuri does. |
| `DISCORD_APP_ENABLED` | `true` | `false` skips the gateway session entirely. Delivery is unaffected. |
| `DISCORD_GUILD_IDS` | empty | Comma-separated guilds discordapp serves (D8). Empty = every guild the bot is in. |
| `DISCORD_COMMAND_WHITELIST` | empty | Comma-separated user ids allowed to run admin commands (D7). Empty = nobody. |
| `DISCORD_UPLOAD_LIMIT_MB` | `20` | Largest file Discord delivery sends as an attachment. |
| `DISCORD_EXPORT_TELEGRAM_CHAT` | empty | Telegram chat id or `@username` that also receives `/export-chats` files. Empty = disk only. |

## Work plan

| # | Step | Status |
|---|---|---|
| 0 | This specification | Done (v4.30.2) |
| 1 | REST-only delivery, `DiscordGateway`, `DiscordApp` skeleton: soft start, per-guild registration, guild allowlist, fail-closed guard, ephemeral registry | Done (v4.31.0) |
| 2 | `/export-chats` | Done (v4.32.0) |
| 3 | Provisioning config schema and validator, pure planner with tests, `/provision plan` with permission preflight | Done (v4.33.0) |
| 4 | State migration, applier, import, archive and restore, `/provision apply` with confirmation | Done (v4.34.0) — migration and import landed with step 3 |
| 5 | Messages from `.md` edited in place, role panels, opt-in groups | Done (v4.35.0) |
| 6 | AutoMod as a resource | Done (v4.37.0) |
| 7 | `/provision export` | Done (v4.38.0) |

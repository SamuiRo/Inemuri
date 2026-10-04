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

> **Status: complete, in production (v4.42.3).** Every step of the work plan is
> done. Provisioning was run on a live test server and then on the operator's
> main server: a full rebrand of an existing server — 86 changes, history
> kept, a clean plan afterwards. What it deliberately does not do is listed in
> [Status and known limitations](#status-and-known-limitations).
>
> **Running a server with it day to day:** [PROVISIONING.md](PROVISIONING.md) —
> the loop, recipes, taking over an existing server, troubleshooting. This
> document is the contract behind it.

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
| D10 | **Self-assign roles cannot carry dangerous permissions** and must sit below the bot's highest role. Checked by the validator, by the planner against the server, and again on every button press. | One config typo — or a permission added by hand later — must not become "anyone can click to get admin". |
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
  customId.js                        # pure: stateless component ids (D11)
  channelKinds.js                    # ChannelType <-> kind names
  reply.js                           # long replies become an attached text file
  commands/                          # one file per slash command; index.js lists commands and components
  components/                        # button handlers not tied to a command (role-panel.js)
  features/
    export/                          # /export-chats: collector (Discord I/O), snapshot + format (pure), ChatExporter
    roles/                           # role panels: button ids, role change, self-assign safety (pure)
    provision/                       # server as code: schema, overwrites, messages, automod, planner,
                                     #   exporter, formatPlan (pure); readGuild, applier, configStore, Provisioner
src/module/teapot/models/DiscordResource.js   # provisioning state (migrations 009, 010)
src/config/discordapp/               # git-ignored deployment data + *.sample
  servers/<name>.json
  messages/*.md
scripts/discordapp.js                # check | apply | export from a terminal
```

### Command module contract

```js
export default {
  data: new SlashCommandBuilder().setName("export-chats") /* ... */,
  admin: true,                                   // D7
  async execute(interaction, ctx) {              // ctx = { eventBus, guildIds }
    return "text" | { content, files, components }; // edited into the deferred ephemeral reply
  },
};
```

A component handler has the same shape with `prefix` instead of `data`, and is
routed by the part of `customId` before the first `:`. With `update: true` it
edits the ephemeral message it sits on (its buttons and attachments cleared)
instead of replying anew — the Apply button uses this so it cannot be pressed
twice. A new command is a file in `commands/` and a line in `commands/index.js`.

**Asking the core for data (D1).** A command that needs an answer from the
core — not just to hand something off — uses the bus's request/reply, never an
import:

```js
const res = await ctx.eventBus.request("theflow.search", { query }, { timeoutMs: 20_000 });
```

The core registers the one handler with `eventBus.handle(name, fn)` in
`src/inemuri.js`. A missing handler or a timeout is an error, which the
registry turns into an ephemeral message like any other. Known requests:

| Request | Handler | Answers |
|---|---|---|
| `theflow.search` | `HistorySearch.search()` (`src/module/theflow/search/`) | `{ mode, query, results[], note?, error?, text }` — `text` is ready to show |

## Feature: `/search`

Search over TheFlow's corpus (theflow/ROADMAP.md §9.1). Admin (D7): the
corpus is the content of channels the operator follows. Options: `query`
(required), `mode` — `keyword` (default: SQLite FTS5, no provider call, works
with the quota spent) or `semantic` (one low-priority embedding, then cosine
over stored vectors of the same model) — and the filters `topic`, `signal`
(choices from `categories.json`), `days`, `limit` (≤ 25). One row per event:
posts of the same dedup cluster collapse into one, marked `×N`. Each row
links to the original Telegram post. The command only sends the
`theflow.search` request; the answer, and its formatting, come from the core.

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
  channel headings, one header line per message
  `[2026-09-29 14:02] author: text`, with reply, attachment and reaction
  markers. **Nothing is truncated** — neither the text nor embeds, which are
  written whole with their author, title, description, fields and footer
  (v4.40.3; before, an embed was one line cut at 200 characters, so bot posts
  and Inemuri's own forwards came out cut). **JSON**: the full structure with ids, reply targets, attachments,
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

A server's shape — roles, categories, channels, permission overwrites,
messages, role panels, AutoMod rules — is described in
`src/config/discordapp/servers/<name>.json` and applied Terraform-style:
**plan, then apply**.

> **Plan implemented (v4.33.0), apply (v4.34.0).** Code:
> `src/module/discordapp/features/provision/` — `schema.js`, `overwrites.js`,
> `planner.js`, `formatPlan.js` (pure), `readGuild.js` (reads Discord),
> `applier.js` (writes Discord), `configStore.js`, `Provisioner.js`; command
> `commands/provision.js`. Messages and role panels since v4.35.0, AutoMod
> since v4.37.0, `archiveUnmanaged` since v4.40.0. A working starting point is
> `servers/example.sample.json` with `messages/rules.sample.md`, or
> `/provision export` of the server as it is.

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
  A panel takes `"embed"` too (v4.58.0): the text goes into one embed above
  the buttons (up to 4096 instead of 2000), a first line `# Title` becomes its
  title, `color` its stripe. Still posted by the bot, never a persona.
  Text over Discord's limit (2000, or 4096 in an embed) is a config error
  before anything is read from the server. Provisioned messages never ping:
  `@everyone` in a rules text is text.
- **Several embeds, links, personas** (v4.42.0):
  - In an embed message, a line `---` starts the next embed (up to 10, 6000
    characters in all), and a first line `# Title` becomes that embed's
    title. One message then carries a stack of small embeds, each with its
    own side bar.
  - `{{#channel-key}}` and `{{@role-key}}` in a text become `<#id>` and
    `<@&id>` at apply, so a rename or re-creation never breaks a link. A key
    the config does not have is a config error; a resource created in the
    same apply is linked once it exists. Limits count a link at its resolved
    length.
  - `"personas": { "guide": { "name": "Guide", "avatar": "folder/guide.png" } }`
    at the root, and `"as": "guide"` on a text message, post it through a
    webhook with that name and avatar instead of as the bot. Provisioning
    creates the webhook in the channel itself and finds it again by owner and
    name (Discord returns the token of the bot's own webhooks), so there is
    nothing to set up and no secret to keep. Role panels stay with the bot:
    their buttons are the bot's interactions. A message whose author changes
    (bot ↔ persona) is posted anew — Discord does not let one author edit the
    other's message (50005, checked live) — and the old copy is left for a
    human to delete. Renaming a persona gives it a new webhook; messages of
    the old one can then only be reposted.
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
- **`"adopt": "<id>"`** on a role, category, channel or the archive block
  adopts that exact resource instead of matching by name (v4.41.0). It is what
  makes a rebrand possible in one pass: the entry carries its *new* name and
  the id of the old resource, so the first apply renames it with its history
  instead of creating an empty twin and archiving the original. It also
  resolves same-named resources (a server whose categories all share one
  decorative name). A missing id, an id already taken by another entry, a
  wrong channel kind or an integration-managed role is a plan error, never a
  silent create. Used only while the key has no state; once adopted, the id in
  the config is redundant and may be left or removed.

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
  otherwise. This is not universal: on the operator's main server (2026-09-30) the
  same default rule, with the owner as `creator_id`, answered a full PATCH
  with 200. And Discord's own UI refuses to delete the mention-spam rule on a
  Community server ("disable the rule instead"), so "delete it" is not always
  available — dropping it from the config is.
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

Every exported role, category, channel and the archive carry `"adopt": "<id>"`
(v4.43.0). Rewriting the export — new names, new grouping — then renames and
moves the existing resources on the first apply instead of creating twins, and
same-named resources are no longer a plan error.

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

## Status and known limitations

Complete as of v4.40.1: every step below is done, 100+ `node --test` cases
cover it, provisioning (create, adopt, archive, restore, edit in place,
AutoMod, export round trip, `archiveUnmanaged`) was run against a live test
server, and the operator exercised the slash commands and buttons there.

Deliberately not done — each is a small, separate change if it is ever needed:

- **Role panels hold at most 25 roles** (buttons only). A select menu for
  larger panels was specified but not built.
- **No audit log channel.** Actions are logged to the process log only. A
  command running past the 15-minute interaction token (a very large export)
  loses its reply; its files are still on disk and named in the log.
- **Messages are appended, never inserted.** A message added between existing
  ones in the config is posted at the end of its channel — Discord cannot
  insert. Messages are not pinned.
- **Server settings are not provisioned**: rules / updates / system channel
  choice, onboarding, verification level. Provisioning does respect the
  channels the server uses (`archiveUnmanaged` keeps them).
- **AutoMod**: the `member-profile` rule type is not supported. A rule
  Discord created itself may refuse edits from bots (404 on the test server;
  accepted on the main server), and on a Community server the mention-spam
  rule cannot be deleted at all — drop such a rule from the config and set it
  by hand if the edit fails.
- **Forum tags** are not provisioned.
- **Overflow archive names** are `<archive name> 2`, which sits outside a
  decorative frame such as `┍ … ┑`.
- **Plain emoji only** on panel buttons; custom emoji ids differ per server.
- **Overflow archives** (`ARCHIVE 2`, …) keep the archive rights they were
  created with; changing the archive roles later does not resync them.
- **`/export-chats` to Telegram** was built on the normal delivery path but
  has not been run live yet.

`/search` (theflow/ROADMAP.md §9.1) was added in v4.46.0, with the bus's
request/reply for asking the core. Natural next steps: anything above that
practice asks for.

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

After the plan, from the operator's use of the test server:

| Version | Change |
|---|---|
| v4.36.0 | `scripts/discordapp.js check \| apply` — setup check and provisioning from a terminal |
| v4.37.0 | AutoMod: Discord's own rules cannot be edited (found live); failures are explained and not recorded as managed |
| v4.38.0 | Export round trip found three bugs (state keys, neutral overwrites, unknown permission bits) — fixed |
| v4.38.1 | No progress edits; the applier re-reads the server only after a phase that changed something |
| v4.39.0 | `/export-chats` to disk and Telegram; nothing attached in Discord |
| v4.40.0 | `archiveUnmanaged` |
| v4.40.1 | Plan lists archived and hidden resources apart from untouched ones |
| v4.41.0 | `adopt` by id — rename on first import, same-named resources |
| v4.42.0 | Several embeds per message (`---`), `{{#key}}` / `{{@key}}` links, personas posting through the bot's own webhook |
| v4.42.2 | Plan fingerprint stable across reads — apply refused every time on a server with many overwrites |
| v4.42.3 | Exclusive role panel: switching roles lost the new role; roles now change one call each. [PROVISIONING.md](PROVISIONING.md) operator guide |

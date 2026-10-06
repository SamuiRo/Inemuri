---
name: discord-provisioning
description: How to describe, change and apply a Discord server as code with Inemuri's discordapp provisioning — server configs (roles, categories, channels, permission presets, role panels, opt-in sections, AutoMod), message texts with several embeds, {{#key}} links and personas, taking over an existing server with adopt, and running plan/apply from the terminal. Use whenever the task touches src/config/discordapp/servers/*.json or messages/*.md, /provision plan|apply|export, scripts/discordapp.js, a server rebrand or cleanup, or the provisioning code under src/module/discordapp/features/provision/ — even if the user just says "add a channel", "rename the category", "change who can post", "update the welcome text" or "set up a new server".
---

# Discord provisioning (discordapp)

A Discord server is a JSON config; the planner diffs it against the live
server; the applier makes the server match. Nothing is ever deleted.

Read these before non-trivial work — they are the source of truth, this skill
is the map:

- `docs/PROVISIONING.md` — operator guide: loop, recipes, takeover, naming,
  troubleshooting. **Start here.**
- `docs/DISCORDAPP.md` § *Feature: provisioning* — the contract: every field,
  every rule, and *Status and known limitations*.
- `src/config/discordapp/servers/example.sample.json` +
  `src/config/discordapp/messages/*.sample.md` — a complete working example.

If a per-server skill exists (`.claude/skills/server-*/`), load it too: it
holds that server's naming conventions and decisions.

## Ground rules

- **Real configs and texts never go into git.** `servers/*.json` and
  `messages/**` are git-ignored; only `*.sample.*` is tracked. Docs use made-up
  examples, never real ids or channel names.
- **Plan freely, apply only when the user asks.** Apply changes a live server
  that other people use. It also needs the bot to hold Administrator for the
  duration — the user grants it.
- **Never set `NODE_ENV=development`** (the DB sync path recreates tables).
- **Keys are identity.** Renaming `name` is an edit; changing `key` archives
  the old resource and creates a new one. Never change a key to "rename".
- Removing a channel from the config archives it (history kept). Roles are
  never deleted by provisioning — that is manual, in Server Settings.

## Commands

| What | How |
|---|---|
| Plan (read-only) | `node scripts/discordapp.js check <guildId> [config]` — also checks bot role position, permissions, intents, commands |
| Apply | `node scripts/discordapp.js apply <guildId> [config] --yes` (without `--yes` it only plans) |
| Server → config | `node scripts/discordapp.js export <guildId>` → `exports/config-<slug>.json`, with `adopt` ids |
| In Discord | `/provision plan`, `/provision apply` (button), `/provision export` |
| History backup | `/export-chats` → `exports/` |

Config and text changes need no restart. Code changes to Inemuri need a
restart before the running bot uses them.

## Config cheat sheet

Root: `guildId`, `archive` (required: `{ key, name, roles, adopt? }`),
`archiveUnmanaged`, `presets`, `personas`, `roles`, `channels` (top level, no
category), `categories`, `automod`. Any field starting with `_` is a comment.

- **Role:** `{ key, name, color?, hoist?, mentionable?, permissions?, adopt? }`.
  `permissions: []` = none server-wide; omitted = not managed.
- **Category:** `{ key, name, overwrites?, optIn?: { role, panel? }, requires?, channels, adopt? }`.
- **Channel:** `{ key, name, type?: text|voice|forum|announcement|stage, topic?, nsfw?, slowmode?, overwrites?, messages?, requires?, adopt? }`.
- **Overwrites:** a preset name or `{ "@everyone" | "role:<key>": { allow: [...], deny: [...] } }`,
  permission names from `PermissionFlagsBits`. A channel gets its category's
  overwrites plus its own (own wins per target). The bot's overwrite is added
  automatically.
- **Text message:** `{ key, file: "folder/x.md", embed?: true | { title?, color? }, as?: "<persona>" }`.
- **Role panel:** `{ key, rolePanel: { mode: toggle|exclusive, text?, roles: ["key" | { role, label?, emoji? }] } }` —
  max 25 roles, plain emoji only, roles with mod/admin permissions refused.
- **Persona:** root `personas: { "<key>": { name, avatar?: "folder/x.png" } }`;
  posts via a webhook the bot creates and reuses. Not for role panels.
- **AutoMod:** `{ key, name, type: keyword|preset|spam|mention-spam, ..., actions: [block|alert{channel}|timeout{seconds}], exempt: { roles, channels } }`.
  Rules are enforced by Discord, not Inemuri.

## Texts (`messages/**.md`)

- `---` on its own line starts the next embed (max 10, 6000 chars total, 4096
  each); a first line `# Title` becomes the embed title.
- `{{#channel-key}}` → channel link, `{{@role-key}}` → role mention; unknown
  keys are config errors. Mentions never ping.
- Editing a file edits the posted message in place. New messages are appended
  at the end of the channel (Discord cannot insert).

## Taking over an existing server

1. Export history (`/export-chats`) and the config (`export`) first.
2. Rewrite the exported config into the target shape. **Keep every `adopt`**
   — it makes the first apply rename the existing resource instead of
   creating an empty twin and archiving the original with its history.
3. `archiveUnmanaged: true` sweeps everything not in the config into the archive.
4. Plan, read every line with the user, apply on their word, plan again — it
   must come back empty.

## Discord naming facts (verified live)

Text/forum channel names: every Unicode space becomes `-`, invisible fillers
are stripped, letters are lowercased; `_`, `・`, `·` survive. Voice channels and
categories keep spaces and case.

## Code map

`src/module/discordapp/features/provision/`:

| File | Role |
|---|---|
| `schema.js` | Config validation → `desired` (pure). Field lists in `FIELDS` |
| `planner.js` | `desired` + server snapshot + state → ops (pure); `planFingerprint` |
| `readGuild.js` | Discord → snapshot (roles, channels, overwrites sorted, managed messages, AutoMod) |
| `applier.js` | Runs ops phase by phase, re-reading after each changing phase; webhooks for personas |
| `messages.js` | Render texts/panels, `---` split, `{{#key}}` links, limits, hash |
| `overwrites.js`, `permissions.js` | Overwrite resolution, permission names, dangerous bits |
| `automod.js`, `exporter.js` | AutoMod rules; server → config |
| `Provisioner.js`, `configStore.js`, `formatPlan.js` | Orchestration, file loading, plan text |

Role panel clicks: `src/module/discordapp/components/role-panel.js` +
`features/roles/rolePanel.js`. Commands: `src/module/discordapp/commands/provision.js`.
State: table `discord_resources` (key → Discord id), model `DiscordResource`.

Tests: `test/discordapp-provision.test.js`, `-apply`, `-messages`,
`-automod`, `-export-config` (`npm test`). Pure layers are tested without
Discord; add a test with every behaviour change.

## Known traps

- Two resources with the same name and no `adopt` → plan error (by design).
- Discord refuses cross-author edits (bot ↔ webhook, code 50005): changing a
  message's `as` posts a new copy; the old one is deleted by hand. Since
  v4.59.1 an edit refused because another bot (50005) or another webhook
  (10008) owns the message also posts a new copy — "posted anew" in the log.
- A Discord-created AutoMod rule may refuse bot edits (404) and on a Community
  server the mention-spam rule cannot be deleted — drop it from the config if
  the edit fails.
- Server settings (verification, notifications, onboarding) and forum tags are
  not provisioned.

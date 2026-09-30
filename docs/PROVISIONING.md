> **Role:** Operator guide to provisioning — how to run a Discord server as code, day to day · **Audience:** The person who edits a server config and applies it

# Provisioning guide — a Discord server as code

discordapp can describe a whole Discord server — roles, categories, channels,
permissions, the texts in them, role buttons, AutoMod — in one JSON file, and
bring the server to match it. This guide is the **how**: the everyday loop,
recipes for common changes, taking over an existing server, and what to do when
something refuses. The **what** — every field, every rule, why it works this
way — is the contract in [DISCORDAPP.md](DISCORDAPP.md#feature-provisioning-server-as-code).

Every example below is made up. Real server configs and texts are git-ignored
and never belong in this repository — see [Where things live](#where-things-live).

## The model in five sentences

1. **The config is the source of truth.** Change the server by changing the
   file, not by hand; a hand change is simply something the next plan offers
   to undo.
2. **Every resource has a `key`** — a stable name you choose. The key is the
   identity: renaming `"name"` is an edit of the same channel, changing
   `"key"` means a different channel.
3. **Plan, then apply.** `plan` reads the server and lists what would change;
   `apply` shows the same list with a button and does it. Nothing happens
   without the button.
4. **Nothing is ever deleted.** A channel you remove from the config is moved
   into the private archive category with its history; putting it back in the
   config brings it back. Roles you remove are left alone and reported.
5. **Provisioning remembers what it manages** (`discord_resources` in the
   database: key → Discord id). That is what makes a rename a rename and not a
   new channel.

## Where things live

| What | Path | In git? |
|---|---|---|
| Server config | `src/config/discordapp/servers/<name>.json` | **No** — ignored |
| Texts of messages | `src/config/discordapp/messages/**/*.md` | **No** — ignored |
| Persona avatars | `src/config/discordapp/messages/**/*.png` | **No** — ignored |
| Examples to start from | `servers/example.sample.json`, `messages/*.sample.md` | Yes |
| What is managed (key → id) | `discord_resources` in `database/pot.sqlite` | No |
| Plans and exports you save | `exports/` | No |

Server configs hold real ids, names and texts, so they stay out of git by
design. The flip side: **they exist only on this disk.** Keep a copy — a
private repository, or a copy next to your database backups. If a config is
lost, `/provision export` rebuilds one from the server (without message texts,
which are on disk only).

## The everyday loop

1. Edit the config or a text file. Configs are read on every command — no
   restart needed for config changes.
2. `/provision plan server:<name>` — read the list. `+ create`, `~ update`,
   `⇄ adopt`, `→ archive`, `← restore`, `~ edit` (a text changed), `+ post`.
3. Give the bot Administrator (a role such as *Inemuri Setup*) — Discord does
   not let a bot grant permissions it does not hold itself.
4. `/provision apply server:<name>` → check the list → **Apply**.
5. Read the log. Failed operations are listed with a reason; everything else
   still ran. Run plan again: an empty plan means the server matches.
6. Take Administrator away again.

From a terminal the same is `node scripts/discordapp.js check <guildId> [config]`
(setup check and plan) and `apply <guildId> [config] --yes`.

**Code changes** to Inemuri itself (a new version) need a restart before the
commands use them; config and text changes do not.

## Recipes

Snippets show only the part that changes.

### Add a channel

Add it to the category's `channels` with a new key:

```json
{ "key": "screenshots", "name": "﴾📸﴿・screenshots", "topic": "Share what you made" }
```

It inherits the category's permissions. Voice: `"type": "voice"`; forum:
`"type": "forum"`.

### Rename, move or reorder

- **Rename:** change `"name"`, keep `"key"`.
- **Move to another category:** cut the entry and paste it into the other
  category's `channels`.
- **Reorder:** order in the file is order on the server — for categories and
  for channels inside them.

### Retire a channel, and bring it back

- **Retire:** delete its entry. The plan shows `→ archive`; the channel moves
  into the archive category, hidden from members, history intact.
- **Bring back:** add the entry again with the **same key**. The plan shows
  `← restore`.

With `"archiveUnmanaged": true`, channels that were never in the config are
archived too, and categories that are not in it are hidden. That is for
cleaning up a server once; leave it on afterwards so hand-made channels do not
creep back in unnoticed.

### Who can see and who can write

Permissions are overwrites, written once as **presets** and reused:

```json
"presets": {
  "members":  { "@everyone": { "deny": ["ViewChannel"] }, "role:member": { "allow": ["ViewChannel"] } },
  "readonly": { "@everyone": { "deny": ["SendMessages"] }, "role:mod": { "allow": ["SendMessages"] } }
}
```

A category takes a preset (`"overwrites": "members"`); a channel without its
own overwrites follows its category; a channel with its own gets the
category's **plus** its own, its own winning for the same role. Typical
patterns:

- A feed only the bot and mods post in, members read and thread: deny
  `SendMessages` to `@everyone`, allow it to the mod role. The bot always gets
  its own overwrite.
- A channel everyone sees even without a role (welcome, rules): allow
  `ViewChannel` to `@everyone` there.
- Staff only: deny `ViewChannel` to `@everyone`, allow it to the staff roles.

Permission names are Discord's `PermissionFlagsBits` names; a typo is a config
error, not a silent no-op.

### Add a role, or a role people pick themselves

```json
{ "key": "herald", "name": "Herald", "color": "#e6b422", "permissions": [] }
```

`"permissions": []` means *no server-wide permissions* — access comes from
channel overwrites. Leave `permissions` out to not manage them at all.

To let members take a role with a button, add it to a **role panel** message:

```json
{ "key": "entry", "rolePanel": { "mode": "exclusive", "text": "**Pick one**", "roles": [
  { "role": "red", "label": "Red", "emoji": "🍁" },
  { "role": "blue", "label": "Blue", "emoji": "🐳" }
] } }
```

`exclusive` keeps one role of the panel at a time; `toggle` adds and removes
independently. A role with moderation or admin permissions is refused on a
panel — anyone could take it.

**Removing a role** from the config does not delete it or take it from
anyone; delete it in Server Settings if you want it gone. Removing it from a
panel only removes the button.

### A topic section people opt into

```json
{ "key": "steam", "name": "STEAM", "optIn": { "role": "topic-steam", "panel": "topics" }, "channels": [ ... ] }
```

The category becomes visible only to holders of `topic-steam`, and a button
for it appears on the `topics` panel automatically.

### Texts: edit, add, several embeds, links

A text message points at a Markdown file:

```json
{ "key": "welcome", "file": "myserver/welcome.md", "embed": { "color": "#f47c9b" }, "as": "guide" }
```

- **Edit** the `.md` file and apply: the message is edited **in place**, never
  reposted.
- **Several small embeds in one message:** separate them with a line `---`; a
  first line `# Title` becomes that embed's title. Up to 10 embeds, 6000
  characters in all.
- **Links that survive renames:** write `{{#channel-key}}` or `{{@role-key}}`;
  apply turns them into real mentions. An unknown key is an error before
  anything is sent.
- **Posted by a character, not the bot:** declare a persona once at the root,
  `"personas": { "guide": { "name": "Guide", "avatar": "myserver/guide.png" } }`,
  and add `"as": "guide"` to the message. Provisioning creates and reuses its
  own webhook in that channel; nothing to set up. Role panels always stay with
  the bot, because their buttons are the bot's.
- **Adding a message** posts it at the **end** of the channel — Discord cannot
  insert. To put a new one in the middle, delete the later ones by hand and
  apply: provisioning reposts what is missing, in config order.

See `messages/welcome.sample.md` for a complete example.

### AutoMod

Rules live in `"automod"`. They are **run by Discord**, not by Inemuri:
provisioning only writes the rule, and it keeps working if Inemuri is off.
Send alerts to a dedicated log channel, not to a chat people talk in.

## Taking over an existing server

For a server that already has channels, history and roles:

1. **Export first.** `/export-chats` for a history backup, and
   `/provision export` for a config of the server as it is.
2. **Write the target config** from the export: new names, new grouping.
3. **Keep every existing resource pinned by id** with `"adopt": "<discord id>"`
   on the role, category or channel. The export already writes it (since
   v4.43.0); keep it when you move or rename entries. Without it the first
   import matches by exact name — so a channel you are renaming would be
   *created new* and the original archived. `adopt` also resolves resources
   that share a name (a server whose categories all have the same decorative
   name). After the first apply the id is in state and `adopt` is redundant.
4. `"archiveUnmanaged": true` to sweep the rest into the archive.
5. Plan, read every line, apply. Plan again: it should be empty.

## Naming on Discord

Discord rewrites text and forum channel names, checked live:

- Every kind of space — ordinary, non-breaking, thin, ideographic — becomes
  `-`. Invisible characters (braille blank, Hangul fillers) are stripped.
- Letters are lowercased.
- `_`, `・` and `·` are kept, so `﴾💎﴿・treasure・map` is a way to separate words
  without dashes.

Voice channel and category names keep spaces and case.

## When something refuses

| Message | What it means | What to do |
|---|---|---|
| *The server or the config changed since this plan was shown* | Someone changed the server or the file between plan and the button, or the plan differs between two reads | Run apply again. If it repeats with nothing changing, that is a bug — the plan must be deterministic |
| *N channels are named #x — rename all but one* | First import cannot tell same-named resources apart | Add `"adopt"` with the right id |
| *adopt id … is not on the server / belongs to another entry / wrong kind* | The id is wrong, used twice, or points at a voice channel for a text entry | Fix the id |
| *Role … is at or above the bot's highest role* | The bot cannot manage roles above its own | Move the bot's role up in Server Settings → Roles |
| *The bot needs Administrator to apply* | See the loop above | Give it a role with Administrator for the apply |
| *now posted as … — the old copy stays* | A message changed author (bot ↔ persona); Discord does not let one author edit the other's message | Apply posts a new copy; delete the old one by hand |
| *… links to keys the config does not have* | A `{{#key}}` in a text has no matching key | Fix the key in the `.md` |
| *… characters; a message holds …* | A text is over Discord's limit | Split it with `---` or into several messages |
| AutoMod rule fails with 404 | A rule Discord created itself, not editable by bots on that server | Drop it from the config, or configure it by hand. On a Community server the mention-spam rule cannot be deleted either — only disabled |

## Things that surprise people

- Changing a `key` is not a rename — it archives the old channel and creates a
  new one.
- Removing a channel from the config archives it; it does not delete it.
- A new message goes to the end of its channel.
- Renaming a persona gives it a new webhook; the old persona's messages can
  then only be reposted.
- The config manages only what it states. A role without `color` keeps its
  colour; a channel without `topic` keeps its topic.
- Server settings (verification level, default notifications, onboarding,
  rules channel) are not provisioned — set them once in Server Settings.

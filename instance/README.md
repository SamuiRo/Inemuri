# instance/

Everything that belongs to one deployment of Inemuri: what you edit, and
what the service writes while it runs. The code (`src/`) never changes
between deployments; this folder is what makes a deployment yours.

The repository is public, so git ignores this folder except the samples
(`*.sample.json`, `provision/*.sample/`) and this file. A missing config
falls back to its sample with a `[CONFIG]` warning; `node src/cli.js flow
preflight` blocks a deployment that runs on the routing or cron sample.

| Path | Holds | You |
|---|---|---|
| `config/sources.json` | Every source: channels, filters, `flow`, `feed` | edit, then `npm run seed` |
| `config/routing.json` | TheFlow routing rules, `#unsorted`, health, digest and status destinations | edit, restart |
| `config/triage.json` | The headline-triage reader profile | edit, bump `version`, restart |
| `config/cron.json` | Cron job destinations (the daily report) | edit, restart |
| `provision/<server>/server.json` | One Discord server for `/provision`: roles, channels, panels | edit, `/provision plan`, `apply` |
| `provision/<server>/*.md`, images | The texts and avatars `server.json` points to (`"file": "welcome.md"`) | edit, `/provision plan`, `apply` |
| `knowledge/*.jsonl` | Labelled examples (`flow knowledge export` / `import`) | import on another machine |
| `database/pot.sqlite` | The working database; `backups/` next to it (`npm run migrate` writes them) | never copy between machines |
| `exports/` | `/export-chats` output — other people's messages | — |

Start from the samples: copy `config/<name>.sample.json` to `<name>.json`,
and `provision/example.sample/` to `provision/<your-server>/`.

**Moving a deployment:** copy `config/`, `provision/` and `knowledge/` — not
`database/`, which belongs to the machine it runs on (the corpus,
provisioning state, polling positions). `.env` with the secrets stays in the
repository root, outside this folder.

`INEMURI_INSTANCE_DIR` in `.env` points the service at another folder.
Before v4.67.0 these files lived in `src/config/`, `database/` and
`exports/`; `npm run instance:init` moves them here (docs/DEPLOYMENT.md).

# subagentix

Tracking and visualization of interactions between opencode subagents
(orchestrator → developer / tester / reviewer / git, …).

**Status:** early preview — usable read-only viewer, no auth, single machine.

## What it is

A single-machine, retrospective browser app. Pick an opencode **turn** and see
it as an interactive wall-clock **Gantt**: who called whom, when, how long each
agent ran, and what tokens/cost it consumed, with per-node drill-down.

## Features

- Session sidebar grouped by working directory, with search and paging.
- Turn Gantt (SVG) with delegation edges between orchestrator and subagents.
- Per-node drill-down: steps, tool calls and errors.
- Files viewer (`/files`), reached from the `Files` link in the dashboard header:
  a read-only browser of the global opencode config and each opencode project —
  `AGENTS.md`, subagents, skills and config, plus the global `references` and
  `templates` directories — with file bodies loaded on demand (512 KiB cap;
  binary files are flagged, not rendered).
- Runtime settings (opencode DB path, ziptask URL, subagents dir) in a modal.
- Optional ziptask integration (task links), gated by a runtime toggle.

## Why

- Attribute tokens, time and tool calls to a specific subagent.
- Reconstruct "who talked to whom" across parallel subagents.
- Expose waste (retries, dead loops) and coordination gaps.

## Data source & privacy

Reads the opencode SQLite database
`~/.local/share/opencode/opencode.db` (read-only). The data layer targets the
opencode **V2** schema: sessions live in `session_v2`, messages in
`session_message`, and a message's parts are the `data.content[]` JSON array,
walked with `json_each(session_message.data, '$.content')`. There is no `part`,
`message`, `session` or `todo` table any more. Messages are ordered within a
session by the `seq` column (there is no `parentID`), and the
`session_message.type` column (`user`/`assistant`/`idle`/`system`/`synthetic`/
`compaction`) replaces the old `data.role` discriminator.

Usage is read per assistant message: one `assistant` message is one **step**, so
its tokens and cost come from that message's `data.tokens` and `data.cost` — there
are no `step-finish` rows. Delegation edges come from `data.content[]` items whose
`name` is `subagent`, with the child session id at `state.metadata.sessionID`;
the session tree itself walks `session_v2.parent_id`. `synthetic` messages never
produce edges.

The data layer reads only `session_v2`, `session_message` and `project` (plus
`sqlite_master` for the V2 signature probe), and never returns `account` or
`credential`. Access is strictly read-only (`readonly:true`,
`PRAGMA query_only=1`, `busy_timeout`), never `immutable=1`; the app never
writes, checkpoints or vacuums the database.

The `/files` viewer applies the same read-only rule to the filesystem: it lists
only allowlisted opencode config and project directories and never touches
opencode runtime state under `~/.local/share/opencode`, so credentials and the
DB itself stay unreachable.

## Requirements

- [Bun](https://bun.sh/) (runtime and package manager; see `bun.lock`)
- A local opencode installation with an existing `opencode.db`

## Getting started

```sh
bun install
cp .env.example .env   # adjust OPENCODE_DB if needed
bun run dev            # http://127.0.0.1:5173
```

Production build (adapter-node):

```sh
bun run build
bun run start          # serves build/index.js on HOST:PORT
```

Quality gates:

```sh
bun test               # unit + integration suites
bun run check          # svelte-check / TypeScript
```

All test suites build their V2 SQLite fixtures from one shared module,
`src/lib/server/test-fixtures/opencode-v2.ts`.

## Configuration

Environment variables (see `.env.example`); values stored via the Settings UI
take precedence over the environment.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | Path to the live opencode DB (read-only). |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Global opencode config root (agent/skill scans and the `/files` viewer). |
| `ZIPTASK_BASE_URL` | unset | Base URL used to resolve ziptask task links. |
| `ZIPTASK_ENABLED` | derived | Feature toggle for the ziptask integration. |
| `HOST` / `PORT` | `127.0.0.1` / `3010` | Production HTTP bind address. |
| `STATE_DIRECTORY` | `./.data` | Runtime settings directory (systemd `StateDirectory`). |
| `OPENCODE_AGENTS_DIR` | unset | Custom subagents directory scan root. |

## Layout

```
src/lib/server/     read-only data layer (bun:sqlite) + services + settings
src/lib/model/      domain model (Gantt, nodes, tokens, formatting)
src/lib/components/ UI primitives and views (Gantt, sidebar, modals)
src/routes/         SvelteKit pages and /api endpoints
```

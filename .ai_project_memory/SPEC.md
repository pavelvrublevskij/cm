# CM (Claude Manager) — Project Spec

The source of truth for what CM is, how it runs, and the rules every change must keep.
Read it before planning a change. Update it in the same change when behavior described here changes.

## 1. Purpose

A local web UI for managing Claude Code configuration (`~/.claude/`, `~/.claude.json`, project `.claude/`),
browsing sessions, tracking token usage, and working in projects (files, git, terminal).
It runs entirely on the user's machine. No cloud, no accounts.

## 2. Runtime & launch

### 2.1 Launch paths

CM can be started, stopped or restarted in all of these ways. **Any change to startup behavior
(port, env vars, args, process identity) must be checked against every one of them.**

| # | Path | Where | Notes |
|---|------|-------|-------|
| L1 | `run.sh` / `run.bat` — Start (1) | repo root, menu in `scripts/run-menu.ps1` (Windows) | Prompts for the port when interactive, saves it, stops a previous CM on that port, installs deps, verifies node-pty, starts the server hidden in the background, opens the browser |
| L2 | `run.sh` / `run.bat` — Stop (2) | repo root | Stops only CM on the saved port |
| L3 | `run.sh 1` / `run.bat 1` | repo root | Non-interactive Start: no prompt, uses the saved port |
| L4 | `npm start` / `npm run dev` | `package.json` | Plain `node server.js`; never opens the browser |
| L5 | OS autostart at login | `lib/autostart.js`, toggled in the UI (`/api/autostart`) | Windows: Startup-folder shortcut → hidden PowerShell → `node <abs>/server.js --autostart-open`. macOS: LaunchAgent plist. Linux: XDG `.desktop`. Opens the browser once |
| L6 | In-app self-restart | `server.js`: `/api/update/zip`, `/api/terminal/repair` | Spawns a detached `node <abs>/server.js` with the current env + `RESTART_DELAY_MS`, then exits |

### 2.2 Port

- Resolved by `lib/port.js` `getPort()`: `PORT` env var → `port` in `data/app-config.json` → `3000`.
- The run scripts read and save it through `scripts/port.js` (`node scripts/port.js` prints, `node scripts/port.js 3001` saves).
- The last port chosen in Start is reused by Stop, by autostart (L5) and by any start without `PORT`.
- Host is always `127.0.0.1` (`HOST` env may override; never bind to the network by default).

### 2.3 Process identity

- CM is always launched with the **absolute** path to this repo's `server.js` (L1, L5, L6).
- The run scripts identify a CM process by its command line containing that path (slash- and case-insensitive on Windows).
- Start/Stop must **never** kill a process that isn't CM, even if it holds the CM port. Start refuses with
  "Port N is used by another application"; Stop reports it and leaves it alone.

### 2.4 Startup tasks

On listen: optionally open the browser (`CM_AUTOSTART_OPEN=1` or `--autostart-open`), and refresh pricing if older than 24h.
Uncaught exceptions and rejections are logged, never fatal.

## 3. Architecture

- **Server:** Node.js ≥ 18 + Express. `server.js` mounts route modules and holds the version, update, repair and pricing endpoints.
  - `lib/` — shared helpers (paths, file I/O, slug decoding, frontmatter, git, pty bridge, usage index, port, …)
  - `routes/` — one Express Router per API group; handlers are thin and wrapped in `wrapRoute()`
- **Client:** vanilla JS SPA in `public/`, no build step, no framework, no ES modules. Scripts load via `<script>` tags:
  `utils.js` first, `modal.js` second, feature modules, `app.js` last.
- **Terminal:** `lib/terminal-server.js` bridges WebSocket ↔ node-pty (Claude sessions and project shells).
- **Dependencies:** `express`, `gray-matter`, `node-pty`, `ws`, `adm-zip`; dev: `supertest`.

## 4. Data & files

### 4.1 Read/written in the user's Claude config (always `backup()` first, to `~/.claude/backups/`)

| Area | File(s) |
|------|---------|
| Settings | `~/.claude/settings.json` |
| Global CLAUDE.md | `~/.claude/CLAUDE.md` |
| User-scope MCP | `~/.claude.json` → `mcpServers` |
| Local-scope MCP | `~/.claude.json` → `projects["<path>"].mcpServers` |
| Project-scope MCP | `<project>/.mcp.json` |
| Keybindings | `~/.claude/keybindings.json` |
| Skills | `~/.claude/skills/*/SKILL.md`, `<project>/.claude/skills/*/SKILL.md` |
| Agents | `~/.claude/agents/*.md`, `<project>/.claude/agents/*.md` |
| Output styles | `~/.claude/output-styles/*.md`, `<project>/.claude/output-styles/*.md` |
| Project memory | `~/.claude/projects/<slug>/memory/*.md` + `MEMORY.md` index |
| Project settings | `<project>/.claude/settings.json`, `settings.local.json` |
| Project files | `<project>/**` (Files tab; written directly, last write wins) |

Read-only: sessions (`~/.claude/projects/<slug>/*.jsonl`), plugins (`~/.claude/plugins/`), plans,
`~/.claude/.credentials.json` (cloud MCP display only, never written).

### 4.2 App data — `data/` (gitignored; override with `CLAUDE_MANAGER_DATA_DIR`)

Written only through `writeDataJson()` / `safeDataWrite()`, which refuse any path outside `data/` or inside `~/.claude/`.

| File | Contents |
|------|----------|
| `app-config.json` | App settings: `port`, `autostartPrompted`, … |
| `usage-index.json` | Token usage index |
| `pricing-history.json` | Model pricing history and fetch URL |
| `usage-marks.json`, `usage-mark-dismissed.json` | Usage chart marks |
| `usage-insights-history.json` | Saved AI efficiency reports |
| `artifact-index.json` | Session artifact index |
| `archived-sessions.json`, `session-colors.json` | Session archive and colors |
| `skill-usage.json` | Skill usage counts |
| `task-board.json` | Task board: cards (title, notes = description, project, column, closed, sessionId) and project lanes (`parallel`, `stages` = [{ id, title, type skill|agent|prompt, ref, prompt }], `skillsSnapshot`) |

**Settings shared by several launch paths or by server and scripts belong in `app-config.json`**, never in script-local files.

## 5. Features (UI views)

Hash routing (`#view/slug/sessionId[/readonly]`) — the URL survives refresh.

| View | What it does |
|------|--------------|
| Dashboard | Recent sessions, usage summary, quick links |
| Projects | Project list → project tabs: sessions, memory, CLAUDE.md, MCP, settings, agents, skills, output styles, git, artifacts |
| Sessions | History, rename, color (cards, active bar, session header line), archive, search, conversation with tool-use views, subagents, activity, Files/Scratchpad tabs, in-page terminal, new/resume session, active sessions bar, branch-mismatch warning |
| Usage | Token/cost stats, charts, period/project breakdowns, marks, hints, AI efficiency insights |
| Task Board | Tickets across projects: one swimlane per project (project required; optional title + description/ticket number, not both empty; the description becomes the first prompt of the ticket's session); fixed columns ToDo, Ready, Move to PR, Done with the project's workflow stages between Ready and Move to PR; by hand only ToDo ↔ Ready and Move to PR → Done; delete only from ToDo/Done (sessions stay); per-lane Parallel checkbox; lane filter chips; Compact mode (stages folded into In progress; one-line cards with stage dots). Workflow editor per lane: ordered stages (skill, agent or prompt) from the project's skills/agents, global ones and user-scope or this-project plugin skills; Recommend = free name/description matching (Plan, Implement, Test, Review); lane flags "Skills changed" (compare with recommended or keep current) and "Missing skill"; a stage holding tickets cannot be removed |
| Health | Checks for broken settings, failing MCP servers, weak skills, oversized CLAUDE.md, stale memories |
| Settings | Tree editor + raw JSON for `settings.json` |
| Global CLAUDE.md | Markdown editor with preview |
| MCP Servers | User scope + cloud integrations (read-only) |
| Keybindings, Skills, Agents, Output Styles, Plugins | Global CRUD (plugins read-only) |
| Artifacts | Artifacts across sessions |
| CM Settings (`manager-settings`) | Pricing URL/history/manual pricing, editor autosave, autostart toggle |
| Changelog | Renders `CHANGELOG.md` |

Also: onboarding tour (`public/js/tour.js`, re-triggered by a minor version bump), update check and in-app update, 4 themes.

## 6. API

All JSON, all under `/api`. Groups map 1:1 to `routes/*.js`:
`dashboard`, `settings`, `projects` (projects, sessions, terminal, memory, git, scratchpad, project-files), `claude-md`, `mcp`,
`keybindings`, `skills`, `agents`, `output-styles`, `plugins`, `project-settings`, `usage`, `health`, `artifacts`, `plans`,
`file-history`, `autostart`, `task-board`, plus `version`, `changelog`, `update/zip`, `terminal/repair`, `pricing*` in `server.js`.
Terminal and shells use WebSocket upgrades on the same server.

## 7. Invariants (never break)

- Server binds to `127.0.0.1` by default.
- `~/.claude/` is written only through feature endpoints with `backup()` first; app data never goes into `~/.claude/`.
- Path traversal is blocked: `safeSlug()`, `safeMemoryFile()`, validated filenames, hex-only commit shas.
- Credentials are read, never written.
- Git runs non-interactive with a timeout; only safe operations are buttons (`pull --ff-only`, `fetch --prune`, no force push).
- Run scripts never stop a process that isn't this CM (§2.3).
- Everything works on Windows, macOS and Linux (`process.platform` branches, `path.join`, per-OS process spawning).

## 8. Conventions

- Client modules: singleton object literals on `window`; no classes, no ES modules, no frameworks, no build step, no TypeScript.
- Modals via `openModal({ title, body, buttons })`; form helpers `formGroup`, `formRow`, `selectHtml`.
- Client API calls via `api(url, opts)`; errors via `toast(message, 'error')`, never silent.
- Per-row actions use the `.action-menu` kebab dropdown; all dropdowns use the drawn `.dd-arrow`.
- Never put `active` on a `.view` div in HTML (initial-view flash).
- Branches: `release/x.y.z`, `fix/…`, `feature/…` (never bare version names).
- CHANGELOG: one-line bullets per version.

## 9. Testing & release

- `npm test` runs the full suite (`node --test`, `tests/*.test.js`, isolated HOME and data dir via `tests/helpers/app.js`).
  Every feature or fix gets tests; always run the full suite.
- CI (`.github/workflows/test.yml`): Ubuntu + macOS × Node 22/24.
- Release: bump `package.json` version, add a CHANGELOG section, branch `release/x.y.z`, PR to `main`, tag `vx.y.z`.

## 10. Change checklist

Before implementing, answer for the change:

1. **Launch paths (§2.1)** — which of L1–L6 are affected? Covered on Windows, macOS and Linux?
2. **Data (§4)** — new persistent setting? Goes into `data/app-config.json` (or a dedicated `data/*.json`), not a script-local file.
3. **Invariants (§7)** — any of them touched?
4. **UI** — does the tour need a step? Is the README/CHANGELOG affected?
5. **Tests** — new tests added, full `npm test` green.
6. **This spec** — updated if any of the above changed.

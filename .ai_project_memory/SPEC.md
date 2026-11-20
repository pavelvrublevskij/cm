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
- `/api` and the SPA fallback are rate-limited per client IP: 10000 requests/min, `CM_RATE_LIMIT` env overrides; `/api/task-board/hook` and `/api/terminal/hook` are exempt.

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
| `app-config.json` | App settings: `port`, `autostartPrompted`, `boardMaxParallel` (Task Board tickets per Parallel lane, 1–10, default 3), … |
| `usage-index.json` | Token usage index |
| `pricing-history.json` | Model pricing history and fetch URL |
| `usage-marks.json`, `usage-mark-dismissed.json` | Usage chart marks |
| `usage-insights-history.json` | Saved AI efficiency reports |
| `artifact-index.json` | Session artifact index |
| `archived-sessions.json`, `session-colors.json` | Session archive and colors |
| `skill-usage.json` | Skill usage counts |
| `task-board.json` | Task board: cards (title, notes = description, project, column, closed, sessionId, run = { status, message }, worktree, gitBranch, baseBranch, finalized, prUrl) and project lanes (`parallel`, `stages` = [{ id, title, type skill|agent|prompt|workflow, ref, prompt, next = stage id or done (default arrow), branches = [{ when, to }], pos = { x, y } }], first stage = the one Ready leads to, stored in default-arrow order, `skillsSnapshot`) |
| `board-hooks.json` | Claude Code hooks (SessionStart, UserPromptSubmit, Stop, Notification, SubagentStart, SubagentStop → `scripts/board-hook.js`), passed only to Task Board sessions with `--settings`; rewritten on each ticket start |
| `session-hooks.json` | Claude Code hooks (Notification, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, SubagentStart, SubagentStop → `scripts/session-hook.js`), passed with `--settings` and env `CM_SESSION_URL/TOKEN` to claude sessions started in the browser terminal; written on listen |

**Settings shared by several launch paths or by server and scripts belong in `app-config.json`**, never in script-local files.

## 5. Features (UI views)

Hash routing (`#view/slug/sessionId[/readonly]`) — the URL survives refresh.

| View | What it does |
|------|--------------|
| Dashboard | Recent sessions, usage summary, quick links |
| Projects | Project list → project tabs: sessions, memory, CLAUDE.md, MCP, settings, agents, skills, output styles, git, artifacts. A removed Claude worktree (`<project>/.claude/worktrees/<name>` gone, project still listed) is hidden from the project list and its sessions are always listed and searched with its project (`removedWorktreeSlugs`) |
| Sessions | History, rename, color (cards, active bar, session header line), archive, search, conversation with tool-use views, subagents, activity, Files/Scratchpad tabs, in-page terminal, new/resume session, active sessions bar (the open session's pill and sidebar row get a full accent ring), branch-mismatch warning |
| Usage | Token/cost stats, charts, period/project breakdowns, marks, hints, AI efficiency insights |
| Task Board | Tickets across projects: one swimlane per project (project required; optional title + description/ticket number, not both empty; editable only in ToDo (read-only elsewhere); the title and description become the first prompt of the ticket's session); fixed columns ToDo, Ready, Finalize, Done with the project's workflow stages between Ready and Finalize (a PR stage, if wanted, is part of the workflow); by hand only ToDo ↔ Ready and Done → ToDo (reopen after a failed manual test: edit the description, Ready reruns it in the same worktree); delete only from ToDo/Done or a Finalize ticket waiting to be merged, via the card's hover trash icon or the edit modal (sessions stay); per-lane Parallel checkbox; lane filter chips; Compact mode (stages folded into In progress; one-line cards with stage dots). Workflow editor per lane: ordered stages (skill, agent, prompt or workflow) from the project's skills/agents, global ones and user-scope or this-project plugin skills; a workflow stage asks claude to run its prompt with Claude Code's Workflow tool and wait for it (prompt prefilled with a default multi-agent review); Recommend = free name/description matching (Plan, Implement, Test, Review); lane flags "Skills changed" (compare with recommended or keep current) and "Missing skill"; a stage holding tickets cannot be removed. Runner (`lib/task-board-runner.js`, started on listen): Ready needs a workflow; a ticket waits 30 s in Ready (countdown; move it back to cancel), then starts in board order while its lane has room — one running ticket, or up to `boardMaxParallel` (CM Settings, default 3) in a Parallel lane, so two Parallel projects can run 6; in a git project (Parallel or not) each ticket runs in its own worktree that CM creates with git from the branch the project is on (`<project>/.claude/worktrees/cm-<card id 8>` on branch `worktree-cm-…`, base kept as `baseBranch`, the branch as `gitBranch`, shown on the card as `branch ← base` (compact: on hover), in its editor and in the session banner; a restarted ticket continues in it, on its current branch). Every ticket reaches Done through Finalize (after its last stage or a condition jump to Done): claude finds and runs the project's tests and fixes failures; a worktree ticket first commits only its own changes, merges the latest base branch in, resolving conflicts (or reports needs_input/conflict), and renames its branch after the project's naming rules (`git branch -m`); then CM reads the branch from the worktree — if the base has something newer claude merges it in again — and the ticket waits in Finalize (`finalized`, no longer running: frees its lane slot, not counted as in progress, badge "merge or PR"). From its editor the user picks Merge into `<base>` (`POST /cards/:id/merge`: `git merge --no-ff` in the project folder, message `Merge branch '<branch>' into <base>` + ticket title; refused while the folder is off the base branch or has staged changes; a failed merge is aborted) or Create PR (`POST /cards/:id/pr`: `git push -u origin <branch>` then `gh pr create --base <base> --head <branch>`, link kept as `prUrl`) — either moves it to Done; the worktree stays until the ticket is deleted (from ToDo, Finalize or Done), which removes it (unlocking claude-made ones; the delete confirmation warns that a worktree with uncommitted changes is kept: the DELETE answer then carries `warning`, `project`, `worktree` and a "Worktree kept" dialog offers Force remove — `POST /worktrees/force-remove` `{ project, worktree }`, `git worktree remove --force`, discarding its changes, refused for a worktree a ticket on the board still uses); the branch is never deleted by CM; pushed only by Create PR, without git they share the project folder; the session is tracked under the slug its transcript lives in (`sessionSlug`); it gets a background claude pty (`--settings data/board-hooks.json`, env `CM_BOARD_URL/CARD/TOKEN`), which on SessionStart gets title + description + stage 1 pasted and Enter pressed 1 s later, again until UserPromptSubmit confirms (3 tries, then needs input). The board polls at the conversation refresh rate and shows it in the footer. and each stage reply ends with `CM-STAGE: done | needs_input <why> | conflict <why>` read on Stop (done → next stage; after the last → Done, claude ends, card title becomes the session title); Notification → needs input, UserPromptSubmit → running; while a subagent is working (SubagentStart without SubagentStop) a Stop without a marker and an idle notification keep the ticket running, and a reported stage result or a later SessionStart (/clear, compaction) forgets them. A ticket's session runs hidden (not in the active sessions bar, badges or active lists) until it is opened from the ticket; clicking a running ticket reveals it and opens its session (live terminal), after which it behaves like any running session. Tickets waiting for the user (needs input or conflict) are watched from every view at the refresh rate: a count badge on the Task Board nav item, a warning toast when a ticket starts waiting while the board is not open, and the status badge on its session in the active sessions bar and sidebar; a toast says when the last running ticket finished and all tickets are done. Session-detail of a running ticket shows a banner with the ticket, stage (n/total) and status. Close session (header, menu, bar or sidebar) on a running ticket asks Hide and keep running (hidden again, back to the board) / Close / Cancel; Close, Stop, or claude exiting → ToDo, closed. On CM start, tickets left in a stage are closed |
| Health | Checks for broken settings, failing MCP servers, weak skills, oversized CLAUDE.md, stale memories |
| Settings | Tree editor + raw JSON for `settings.json` |
| Global CLAUDE.md | Markdown editor with preview |
| MCP Servers | User scope + cloud integrations (read-only) |
| Keybindings, Skills, Agents, Output Styles, Plugins | Global CRUD (plugins read-only) |
| Skills/Agents transfer | Global and project Skills/Agents lists (`transferKind` in `crud-frontmatter.js`): Export all / Import buttons and a per-card ⋮ menu (Export, Copy to… Global or another project, Delete). Zip: agents as `<name>.md`, skills as whole `<name>/` folders. Import/copy answer 409 with the clashing names, `?overwrite=1` replaces (agents via `backup()`, skills backed up as whole folders); import stages every file first so a failed write changes nothing. Names must be valid on every OS (`lib/config-transfer.js`) |
| Artifacts | Artifacts across sessions |
| CM Settings (`manager-settings`) | Pricing URL/history/manual pricing, editor autosave, autostart toggle |
| Changelog | Renders `CHANGELOG.md` |

Also: tab badge (`public/js/tab-badge.js`): while Task Board tickets need input or browser-terminal sessions wait for the user, the tab title shows `(N) CM` and the favicon a red dot, updated at the refresh rate. A browser-terminal session waits after a Notification (not `auth_success`, not `idle_prompt` while a subagent runs) until UserPromptSubmit or Stop, or until no started tool is left unfinished (PreToolUse → PostToolUse/PostToolUseFailure); hidden board sessions are not counted. Sessions started outside CM's terminal are not tracked.

Also: sidebar compact mode (switch in the sidebar footer, `public/js/compact-mode.js`, localStorage; shows only General and Projects), onboarding tour (`public/js/tour.js`, re-triggered by a minor version bump), update check and in-app update, 4 themes.

## 6. API

All JSON, all under `/api`. Groups map 1:1 to `routes/*.js`:
`dashboard`, `settings`, `projects` (projects, sessions, terminal, memory, git, scratchpad, project-files), `claude-md`, `mcp`,
`keybindings`, `skills`, `agents`, `output-styles`, `plugins`, `project-settings`, `usage`, `health`, `artifacts`, `plans`,
`file-history`, `autostart`, `task-board`, plus `version`, `changelog`, `update/zip`, `terminal/repair`, `terminal/hook`, `terminal/attention`, `pricing*` in `server.js`.
`skills` and `agents` also get `GET /export/{global|project/:slug}[?names=…]`, `POST /import/{scope}` (zip body) and `POST /copy/{scope}/:name` `{ target: 'global' | slug }` from `lib/config-transfer.js`.
Terminal and shells use WebSocket upgrades on the same server.

## 7. Invariants (never break)

- Server binds to `127.0.0.1` by default.
- `~/.claude/` is written only through feature endpoints with `backup()` first; app data never goes into `~/.claude/`.
- Path traversal is blocked: `safeSlug()`, `safeMemoryFile()`, `safeJoin()` for any name from a request, validated filenames, hex-only commit shas.
- Request values used as object keys go through `isSafeKey()` (no `__proto__`); OS terminals get the project folder as cwd/env, never inside a command line (`lib/terminal-launch.js`).
- Credentials are read, never written.
- `/api/task-board/hook` acts only for a running ticket and only with that run's random token.
- `/api/terminal/hook` acts only for a running browser-terminal session and only with that session's random token.
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
- CodeQL (`.github/workflows/codeql.yml`, config `.github/codeql/codeql-config.yml`) on every PR and push to `main`; GitHub's CodeQL default setup must stay off. Locally `npm run codeql` (CLI from `.codeql/codeql`, `CODEQL_PATH` or `PATH`) must report 0 findings; `.githooks/pre-push` runs it once `git config core.hooksPath .githooks` is set.
- Release: bump `package.json` version, add a CHANGELOG section, branch `release/x.y.z`, PR to `main`, tag `vx.y.z`.

## 10. Change checklist

Before implementing, answer for the change:

1. **Launch paths (§2.1)** — which of L1–L6 are affected? Covered on Windows, macOS and Linux?
2. **Data (§4)** — new persistent setting? Goes into `data/app-config.json` (or a dedicated `data/*.json`), not a script-local file.
3. **Invariants (§7)** — any of them touched?
4. **UI** — does the tour need a step? Is the README/CHANGELOG affected?
5. **Tests** — new tests added, full `npm test` green.
6. **This spec** — updated if any of the above changed.

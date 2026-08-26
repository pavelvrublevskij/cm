const path = require('path');
const fs = require('fs');
const url = require('url');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { safeSlug } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const activeSessions = require('./active-sessions');

let pty = null;
try { pty = require('node-pty'); } catch (_) { /* pty unavailable; WS will reject */ }

function nodePtyRoot() {
  try {
    return path.dirname(require.resolve('node-pty/package.json'));
  } catch (_) {
    return null;
  }
}

/**
 * node-pty puts spawn-helper under build/Release when it is compiled from source and under
 * prebuilds/<platform>-<arch> when it comes from a prebuild, which is the default since 1.1.
 * Checking only the build path made every prebuild install look like a missing helper, hiding
 * the permission and quarantine cases below — the two this actually exists to report.
 */
function spawnHelperPath() {
  const root = nodePtyRoot();
  if (!root) return null;
  const candidates = [
    path.join(root, 'build', 'Release', 'spawn-helper'),
    path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

/**
 * node-pty's native addon throws a hardcoded "posix_spawnp failed." on macOS/Linux with no errno,
 * so a spawn failure alone tells the user nothing actionable. spawn-helper (the binary posix_spawn
 * actually launches — see src/unix/pty.cc) is the one thing that can be inspected after the fact:
 * missing, non-executable, or quarantined are the three causes reinstalling node-pty doesn't always
 * fix, and each has a one-line manual workaround worth surfacing.
 */
function diagnoseSpawnFailure() {
  if (process.platform === 'win32' || !pty) return null;
  if (!nodePtyRoot()) return null;
  const helperPath = spawnHelperPath();
  if (!helperPath) {
    return 'spawn-helper is missing from the node-pty install — click Fix & Restart App to reinstall it.';
  }
  try {
    const mode = fs.statSync(helperPath).mode;
    if (!(mode & 0o111)) {
      return `spawn-helper lacks execute permission. Run: chmod +x "${helperPath}"`;
    }
  } catch (_) { /* stat failed; nothing more to say */ }
  try {
    const xattrOut = execFileSync('xattr', [helperPath], { encoding: 'utf-8' });
    if (xattrOut.includes('com.apple.quarantine')) {
      return `spawn-helper is quarantined by macOS Gatekeeper. Run: xattr -d com.apple.quarantine "${helperPath}"`;
    }
  } catch (_) { /* xattr unavailable or nothing set; not diagnostic */ }
  // spawn-helper itself looks fine — the other common cause is exhausted pty/fd slots from
  // long-running background terminals (each stays open until its process exits or is closed).
  // Restarting the app (Fix & Restart App) releases every fd it holds, which clears this case too.
  return 'spawn-helper looks fine, so this may be exhausted pty slots from background terminals. Fix & Restart App will release them.';
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch (_) {
    return false;
  }
}

const wss = new WebSocket.Server({ noServer: true });

const BUFFER_MAX_BYTES = 256 * 1024;
const GC_INTERVAL_MS = 5 * 60 * 1000;

// Long-lived ptys keyed by entry.key. An entry can be in three states:
//   - attached:   entry.ws !== null (active browser connection)
//   - detached:   entry.ws === null, entry.term alive (running in background)
//   - terminated: entry.terminated === true (removed from map)
// New-session ptys (no sessionId at spawn) are stored under a temporary key until the JSONL file
// is discovered on disk (see startNewSessionDiscovery) or the client sends {t:'session', id}.
const activeTerminals = new Map();
const activeKey = (slug, sessionId) => sessionId ? `${slug}|${sessionId}` : null;

// A project's git shell is keyed per project, not per session: it runs no claude session, so it is
// never registered as an active session and one project can hold at most one shell at a time.
const shellKey = slug => `${slug}|@shell`;

const TERMINAL_PATH_RE = /^\/api\/projects\/([^/]+)\/terminal$/;

function validateTerminal(slug, sessionId, mode) {
  if (!slug) return { ok: false, status: 400, error: 'Invalid slug' };
  const dir = safeSlug(slug);
  if (!dir) return { ok: false, status: 400, error: 'Invalid slug' };

  if (mode === 'shell') {
    const projectPath = decodeSlug(slug);
    if (!projectPath) return { ok: false, status: 400, error: 'Cannot resolve project path' };
    return { ok: true, projectPath, sessionId: '', mode: 'shell' };
  }

  if (sessionId) {
    if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
      return { ok: false, status: 400, error: 'Invalid session ID' };
    }
    const filePath = path.join(dir, sessionId + '.jsonl');
    if (!fs.existsSync(filePath)) return { ok: false, status: 404, error: 'Session not found' };
  }

  const projectPath = decodeSlug(slug);
  return { ok: true, projectPath, sessionId: sessionId || '', mode: 'claude' };
}

function rejectUpgrade(socket, status, error) {
  const reason = status === 400 ? 'Bad Request' : status === 404 ? 'Not Found' : 'Service Unavailable';
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(error)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    error
  );
  socket.destroy();
}

function handleUpgrade(req, socket, head) {
  const parsed = url.parse(req.url, true);
  const match = (parsed.pathname || '').match(TERMINAL_PATH_RE);
  if (!match) return false;

  if (!pty) {
    rejectUpgrade(socket, 503, 'node-pty is not installed');
    return true;
  }

  const slug = decodeURIComponent(match[1]);
  const sessionId = (parsed.query && parsed.query.sessionId) || '';
  const mode = (parsed.query && parsed.query.mode) === 'shell' ? 'shell' : 'claude';
  const result = validateTerminal(slug, sessionId, mode);
  if (!result.ok) {
    rejectUpgrade(socket, result.status, result.error);
    return true;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    setupSession(ws, result.projectPath, slug, result.sessionId, result.mode);
  });
  return true;
}

/**
 * Claude Code stamps these into every process it launches, so they are present whenever this
 * server was itself started from inside a session (`claude` -> `npm start`, or the app's own
 * restart). Forwarding them makes the terminal's claude come up as a *nested child* session: it
 * writes no transcript of its own, so startNewSessionDiscovery never finds a session id to bind,
 * the pty dies unrecoverably on disconnect, and /resume lists nothing. A browser terminal is a
 * new top-level session, and the messaging socket/token belong to the parent, not to it.
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID'
];

/** The environment every terminal here spawns with: ours, minus what belongs to our own session. */
function terminalEnv(base) {
  const env = Object.assign({}, base, { TERM: 'xterm-256color' });
  for (const key of INHERITED_SESSION_VARS) delete env[key];
  return env;
}

/** Spawn a pty in the project directory. Every terminal here wants the same size and environment. */
function spawnPty(cmd, args, projectPath, opts) {
  return pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: projectPath,
    env: terminalEnv(process.env)
  });
}

/** The user's own shell, so `git`, `gh` and interactive rebases behave as they do in a real terminal. */
function shellCommand() {
  if (process.platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoLogo'] };
  return { cmd: process.env.SHELL || '/bin/bash', args: [] };
}

function claudeCommand(sessionId) {
  const resumeArgs = sessionId ? ['--resume', sessionId] : [];
  return process.platform === 'win32'
    ? { cmd: 'cmd.exe', args: ['/c', 'claude'].concat(resumeArgs) }
    : { cmd: '/bin/sh', args: ['-c', 'claude "$@"', '--'].concat(resumeArgs) };
}

function spawnShellPty(projectPath, opts) {
  const { cmd, args } = shellCommand();
  return spawnPty(cmd, args, projectPath, opts);
}

function spawnClaudePty(projectPath, sessionId, opts) {
  const { cmd, args } = claudeCommand(sessionId);
  return spawnPty(cmd, args, projectPath, opts);
}

function appendBuffer(entry, data) {
  entry.buffer.push(data);
  entry.bufferBytes += Buffer.byteLength(data, 'utf-8');
  while (entry.bufferBytes > BUFFER_MAX_BYTES && entry.buffer.length > 1) {
    const dropped = entry.buffer.shift();
    entry.bufferBytes -= Buffer.byteLength(dropped, 'utf-8');
  }
}

function safeSend(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(data); } catch (_) {}
}

const NEW_SESSION_POLL_MS = 1500;
const NEW_SESSION_POLL_MAX_MS = 5 * 60 * 1000;

function listJsonlIds(dir) {
  const ids = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) ids.add(name.slice(0, -'.jsonl'.length));
    }
  } catch (_) { /* unreadable */ }
  return ids;
}

function startNewSessionDiscovery(entry, slug) {
  const dir = safeSlug(slug);
  if (!dir) return;
  const before = listJsonlIds(dir);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (entry.terminated || entry.sessionId) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt > NEW_SESSION_POLL_MAX_MS) {
      clearInterval(timer);
      return;
    }
    const now = listJsonlIds(dir);
    for (const id of now) {
      if (!before.has(id)) {
        bindSessionId(entry, id);
        clearInterval(timer);
        return;
      }
    }
  }, NEW_SESSION_POLL_MS);
  if (timer.unref) timer.unref();
  entry._discoveryTimer = timer;
}

function bindSessionId(entry, newId) {
  if (!newId || typeof newId !== 'string') return;
  // A shell has no claude session to bind, and re-keying it would register it as one.
  if (entry.mode === 'shell') return;
  if (newId.includes('..') || newId.includes('/') || newId.includes('\\')) return;
  if (entry.sessionId) return;
  const newKey = activeKey(entry.slug, newId);
  if (!newKey) return;
  if (activeTerminals.has(newKey)) return;
  activeTerminals.delete(entry.key);
  entry.key = newKey;
  entry.sessionId = newId;
  activeTerminals.set(newKey, entry);
  activeSessions.register(entry.slug, newId, 'browser-terminal');
}

function bindWs(entry, ws) {
  entry.ws = ws;
  entry.detachedAt = null;

  ws.on('error', () => { /* swallow */ });

  ws.on('message', msg => {
    if (entry.terminated) return;
    let payload;
    try { payload = JSON.parse(msg.toString()); } catch (_) { return; }
    if (!payload || typeof payload !== 'object') return;
    if (payload.t === 'i' && typeof payload.d === 'string') {
      try { entry.term.write(payload.d); } catch (_) {}
    } else if (payload.t === 'r' && Number.isFinite(payload.c) && Number.isFinite(payload.r) && payload.c > 0 && payload.r > 0) {
      try { entry.term.resize(payload.c, payload.r); } catch (_) {}
    } else if (payload.t === 'close') {
      entry.terminate('Closed by user');
    } else if (payload.t === 'session' && typeof payload.id === 'string') {
      bindSessionId(entry, payload.id);
    }
  });

  ws.on('close', () => {
    if (entry.terminated) return;
    if (entry.ws !== ws) return;
    if (entry.mode === 'shell') {
      // A shell survives its connection, so closing the git panel mid-rebase does not kill it.
      // Reopening reattaches and replays the scrollback; the footer marks a running shell so it is
      // never invisible, and the panel's close action terminates it explicitly.
      entry.ws = null;
      entry.detachedAt = Date.now();
      return;
    }
    if (!entry.sessionId) {
      // New-session pty never got a sessionId — there's no way to find it again, so don't keep it.
      entry.terminate();
      return;
    }
    entry.ws = null;
    entry.detachedAt = Date.now();
  });
}

function setupSession(ws, projectPath, slug, sessionId, mode) {
  ws.on('error', () => { /* swallow */ });

  const isShell = mode === 'shell';
  const key = isShell ? shellKey(slug) : activeKey(slug, sessionId);

  // Reconnect to a detached pty for the same session.
  if (key && activeTerminals.has(key)) {
    const existing = activeTerminals.get(key);
    if (existing.ws) {
      try {
        ws.send(isShell
          ? '\r\n\x1b[31mA shell is already open for this project in another tab.\x1b[0m\r\n'
          : '\r\n\x1b[31mAnother browser terminal is already connected to this session.\x1b[0m\r\n');
        ws.send('\x1b[31mClose it before opening a new one.\x1b[0m\r\n');
      } catch (_) {}
      ws.close();
      return;
    }
    safeSend(ws, '\x1b[33m[reconnected to background session]\x1b[0m\r\n');
    for (const chunk of existing.buffer) safeSend(ws, chunk);
    bindWs(existing, ws);
    return;
  }

  // node-pty cannot chdir into a directory that is gone, and that failure surfaces as an
  // immediate exit(1) with no output — indistinguishable from claude itself crashing. A session
  // whose git worktree was removed hits this every time, so name the real cause instead.
  if (!isDirectory(projectPath)) {
    try {
      ws.send(JSON.stringify({
        t: 'spawn-error',
        cmd: isShell ? shellCommand().cmd : 'claude',
        message: `Project directory no longer exists: ${projectPath}`,
        hint: 'The folder or git worktree for this session was moved or deleted. Reopen the project from a path that still exists.'
      }));
    } catch (_) {}
    ws.close();
    return;
  }

  let term;
  try {
    term = isShell
      ? spawnShellPty(projectPath, { cols: 80, rows: 24 })
      : spawnClaudePty(projectPath, sessionId, { cols: 80, rows: 24 });
  } catch (e) {
    try {
      ws.send(JSON.stringify({
        t: 'spawn-error',
        cmd: isShell ? shellCommand().cmd : 'claude',
        message: e.message,
        hint: diagnoseSpawnFailure()
      }));
    } catch (_) {}
    ws.close();
    return;
  }

  const entryKey = key || `${slug}|@new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    ws: null,
    term,
    slug,
    sessionId: sessionId || '',
    mode: isShell ? 'shell' : 'claude',
    key: entryKey,
    terminated: false,
    detachedAt: null,
    buffer: [],
    bufferBytes: 0,
    terminate(reason) {
      if (this.terminated) return;
      this.terminated = true;
      if (this._discoveryTimer) { clearInterval(this._discoveryTimer); this._discoveryTimer = null; }
      if (reason && this.ws) {
        safeSend(this.ws, `\r\n\x1b[33m${reason}\x1b[0m\r\n`);
      }
      try { this.term.kill(); } catch (_) {}
      if (this.ws) { try { this.ws.close(); } catch (_) {} }
      activeTerminals.delete(this.key);
      if (this.sessionId) activeSessions.unregister(this.slug, this.sessionId);
    }
  };
  activeTerminals.set(entryKey, entry);
  // A shell runs no claude session, so it neither registers as one nor waits for a JSONL to appear.
  if (!isShell && sessionId) activeSessions.register(slug, sessionId, 'browser-terminal');
  if (!isShell && !sessionId) startNewSessionDiscovery(entry, slug);

  term.onData(data => {
    appendBuffer(entry, data);
    safeSend(entry.ws, data);
  });

  term.onExit(({ exitCode }) => {
    if (entry.terminated) return;
    entry.terminated = true;
    safeSend(entry.ws, `\r\n\x1b[33m[${isShell ? 'shell' : 'claude'} exited (code ${exitCode})]\x1b[0m\r\n`);
    if (entry.ws) { try { entry.ws.close(); } catch (_) {} }
    activeTerminals.delete(entry.key);
    if (entry.sessionId) activeSessions.unregister(entry.slug, entry.sessionId);
  });

  bindWs(entry, ws);
}

function disconnectFor(slug, sessionId, reason) {
  const key = activeKey(slug, sessionId);
  if (!key) return false;
  const entry = activeTerminals.get(key);
  if (!entry) return false;
  entry.terminate(reason || 'Terminal closed by another action.');
  return true;
}

function hasActiveTerminal(slug, sessionId) {
  const key = activeKey(slug, sessionId);
  return !!(key && activeTerminals.has(key));
}

function isAttached(slug, sessionId) {
  const key = activeKey(slug, sessionId);
  if (!key) return false;
  const entry = activeTerminals.get(key);
  return !!(entry && entry.ws);
}

function getActiveTerminals() {
  const list = [];
  for (const entry of activeTerminals.values()) {
    if (entry.mode === 'shell') continue;
    list.push({ slug: entry.slug, sessionId: entry.sessionId, attached: !!entry.ws });
  }
  return list;
}

function hasShellTerminal(slug) {
  return activeTerminals.has(shellKey(slug));
}

function gcSweep() {
  for (const [key, entry] of activeTerminals) {
    if (entry.terminated) {
      activeTerminals.delete(key);
      continue;
    }
    const pid = entry.term && entry.term.pid;
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (_) {
      entry.terminated = true;
      activeTerminals.delete(key);
      if (entry.sessionId) activeSessions.unregister(entry.slug, entry.sessionId);
    }
  }
}

const gcTimer = setInterval(gcSweep, GC_INTERVAL_MS);
if (gcTimer.unref) gcTimer.unref();

function _injectFakeEntry(slug, sessionId, fake) {
  const key = (fake && fake.mode === 'shell') ? shellKey(slug) : activeKey(slug, sessionId);
  if (!key) return null;
  const entry = Object.assign({
    slug,
    sessionId,
    mode: 'claude',
    key,
    ws: null,
    term: { kill() {}, pid: process.pid },
    terminated: false,
    detachedAt: null,
    buffer: [],
    bufferBytes: 0,
    terminate(reason) {
      if (this.terminated) return;
      this.terminated = true;
      try { this.term.kill(); } catch (_) {}
      activeTerminals.delete(this.key);
      if (this.sessionId) activeSessions.unregister(this.slug, this.sessionId);
    }
  }, fake || {});
  activeTerminals.set(key, entry);
  return entry;
}

function _clearAll() {
  for (const entry of activeTerminals.values()) entry.terminated = true;
  activeTerminals.clear();
}

module.exports = {
  handleUpgrade,
  validateTerminal,
  disconnectFor,
  hasActiveTerminal,
  isAttached,
  getActiveTerminals,
  hasShellTerminal,
  shellCommand,
  gcSweep,
  _injectFakeEntry,
  _clearAll,
  _bindSessionId: bindSessionId,
  _bindWs: bindWs,
  ptyAvailable: () => !!pty,
  _diagnoseSpawnFailure: diagnoseSpawnFailure,
  _spawnHelperPath: spawnHelperPath,
  _setupSession: setupSession,
  _terminalEnv: terminalEnv
};

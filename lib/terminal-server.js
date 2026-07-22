const path = require('path');
const fs = require('fs');
const url = require('url');
const WebSocket = require('ws');
const { safeSlug } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const activeSessions = require('./active-sessions');

let pty = null;
try { pty = require('node-pty'); } catch (_) { /* pty unavailable; WS will reject */ }

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

const TERMINAL_PATH_RE = /^\/api\/projects\/([^/]+)\/terminal$/;

function validateTerminal(slug, sessionId) {
  if (!slug) return { ok: false, status: 400, error: 'Invalid slug' };
  const dir = safeSlug(slug);
  if (!dir) return { ok: false, status: 400, error: 'Invalid slug' };

  if (sessionId) {
    if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
      return { ok: false, status: 400, error: 'Invalid session ID' };
    }
    const filePath = path.join(dir, sessionId + '.jsonl');
    if (!fs.existsSync(filePath)) return { ok: false, status: 404, error: 'Session not found' };
  }

  const projectPath = decodeSlug(slug);
  return { ok: true, projectPath, sessionId: sessionId || '' };
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
  const result = validateTerminal(slug, sessionId);
  if (!result.ok) {
    rejectUpgrade(socket, result.status, result.error);
    return true;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    setupSession(ws, result.projectPath, slug, result.sessionId);
  });
  return true;
}

function spawnClaudePty(projectPath, sessionId, opts) {
  const resumeArgs = sessionId ? ['--resume', sessionId] : [];
  const isWin = process.platform === 'win32';
  let cmd, args;
  if (isWin) {
    cmd = 'cmd.exe';
    args = ['/c', 'claude'].concat(resumeArgs);
  } else {
    cmd = '/bin/sh';
    args = ['-c', 'claude "$@"', '--'].concat(resumeArgs);
  }
  return pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: projectPath,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color' })
  });
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
    if (!entry.sessionId) {
      // New-session pty never got a sessionId — there's no way to find it again, so don't keep it.
      entry.terminate();
      return;
    }
    entry.ws = null;
    entry.detachedAt = Date.now();
  });
}

function setupSession(ws, projectPath, slug, sessionId) {
  ws.on('error', () => { /* swallow */ });

  const key = activeKey(slug, sessionId);

  // Reconnect to a detached pty for the same session.
  if (key && activeTerminals.has(key)) {
    const existing = activeTerminals.get(key);
    if (existing.ws) {
      try {
        ws.send('\r\n\x1b[31mAnother browser terminal is already connected to this session.\x1b[0m\r\n');
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

  let term;
  try {
    term = spawnClaudePty(projectPath, sessionId, { cols: 80, rows: 24 });
  } catch (e) {
    try {
      ws.send(`\r\n\x1b[31mFailed to start claude: ${e.message}\x1b[0m\r\n`);
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
  if (sessionId) activeSessions.register(slug, sessionId, 'browser-terminal');
  if (!sessionId) startNewSessionDiscovery(entry, slug);

  term.onData(data => {
    appendBuffer(entry, data);
    safeSend(entry.ws, data);
  });

  term.onExit(({ exitCode }) => {
    if (entry.terminated) return;
    entry.terminated = true;
    safeSend(entry.ws, `\r\n\x1b[33m[claude exited (code ${exitCode})]\x1b[0m\r\n`);
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
    list.push({ slug: entry.slug, sessionId: entry.sessionId, attached: !!entry.ws });
  }
  return list;
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
  const key = activeKey(slug, sessionId);
  if (!key) return null;
  const entry = Object.assign({
    slug,
    sessionId,
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
  gcSweep,
  _injectFakeEntry,
  _clearAll,
  _bindSessionId: bindSessionId,
  ptyAvailable: () => !!pty
};

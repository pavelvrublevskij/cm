const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, paths } = require('./helpers/app');

const SLUG = 'terminal-test-proj';
const SESSION_ID = '99999999-9999-9999-9999-999999999999';
const PROJECT_DIR = path.join(paths.PROJECTS_DIR, SLUG);

before(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_DIR, SESSION_ID + '.jsonl'),
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hi' } }) + '\n',
    'utf-8'
  );
});

test('GET /api/projects/:slug/terminal/info without sessionId returns 200 for valid slug', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/terminal/info`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof res.body.available, 'boolean');
  assert.strictEqual(res.body.sessionId, '');
  assert.ok(typeof res.body.projectPath === 'string' && res.body.projectPath.length > 0);
});

test('GET /api/projects/:slug/terminal/info with valid sessionId returns 200', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/terminal/info`).query({ sessionId: SESSION_ID });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sessionId, SESSION_ID);
});

test('GET /api/projects/:slug/terminal/info rejects invalid slug', async () => {
  const res = await request(app).get('/api/projects/bad..slug/terminal/info');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid slug');
});

test('GET /api/projects/:slug/terminal/info rejects sessionId with traversal', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/terminal/info`)
    .query({ sessionId: '..evil' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid session ID');
});

test('GET /api/projects/:slug/terminal/info returns 404 for unknown sessionId', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/terminal/info`)
    .query({ sessionId: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Session not found');
});

test('validateTerminal: rejects empty slug, accepts valid combinations', () => {
  const { validateTerminal } = require('../lib/terminal-server');

  const noSlug = validateTerminal('', '');
  assert.strictEqual(noSlug.ok, false);
  assert.strictEqual(noSlug.status, 400);

  const badSlug = validateTerminal('a/b', '');
  assert.strictEqual(badSlug.ok, false);
  assert.strictEqual(badSlug.status, 400);

  const okNoSession = validateTerminal(SLUG, '');
  assert.strictEqual(okNoSession.ok, true);
  assert.strictEqual(okNoSession.sessionId, '');

  const okWithSession = validateTerminal(SLUG, SESSION_ID);
  assert.strictEqual(okWithSession.ok, true);
  assert.strictEqual(okWithSession.sessionId, SESSION_ID);
});

test('disconnectFor / hasActiveTerminal are no-ops when nothing is registered', () => {
  const { disconnectFor, hasActiveTerminal } = require('../lib/terminal-server');
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), false);
  assert.strictEqual(disconnectFor(SLUG, SESSION_ID, 'reason'), false);
  // empty sessionId is never registered (each empty-session terminal spawns a fresh claude session)
  assert.strictEqual(hasActiveTerminal(SLUG, ''), false);
  assert.strictEqual(disconnectFor(SLUG, '', 'reason'), false);
});

test('getActiveTerminals / isAttached: empty when nothing registered', () => {
  const { getActiveTerminals, isAttached, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  assert.deepStrictEqual(getActiveTerminals(), []);
  assert.strictEqual(isAttached(SLUG, SESSION_ID), false);
});

test('detached entry: hasActiveTerminal=true but isAttached=false', () => {
  const { hasActiveTerminal, isAttached, getActiveTerminals, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  _injectFakeEntry(SLUG, SESSION_ID, { ws: null, detachedAt: Date.now() });
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), true);
  assert.strictEqual(isAttached(SLUG, SESSION_ID), false);
  const list = getActiveTerminals();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].sessionId, SESSION_ID);
  assert.strictEqual(list[0].attached, false);
  _clearAll();
});

test('attached entry: isAttached=true', () => {
  const { isAttached, getActiveTerminals, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  _injectFakeEntry(SLUG, SESSION_ID, { ws: { readyState: 1 } });
  assert.strictEqual(isAttached(SLUG, SESSION_ID), true);
  assert.strictEqual(getActiveTerminals()[0].attached, true);
  _clearAll();
});

test('disconnectFor terminates the entry and removes it from the registry', () => {
  const { disconnectFor, hasActiveTerminal, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  let killed = false;
  _injectFakeEntry(SLUG, SESSION_ID, { term: { kill() { killed = true; }, pid: process.pid } });
  assert.strictEqual(disconnectFor(SLUG, SESSION_ID, 'bye'), true);
  assert.strictEqual(killed, true);
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), false);
});

test('gcSweep removes entries whose pty PID is dead', () => {
  const { gcSweep, hasActiveTerminal, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  // PID 0 is special on Windows and POSIX; process.kill(0, 0) on POSIX targets the process group
  // (rejected as permission/usable). To force "dead pid", use a very high number that cannot exist.
  const deadPid = 2 ** 31 - 1;
  _injectFakeEntry(SLUG, SESSION_ID, { term: { kill() {}, pid: deadPid } });
  gcSweep();
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), false);
});

test('gcSweep removes already-terminated entries', () => {
  const { gcSweep, hasActiveTerminal, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  _injectFakeEntry(SLUG, SESSION_ID, { terminated: true });
  gcSweep();
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), false);
});

test('_bindSessionId re-keys a temp entry under the discovered sessionId', () => {
  const { hasActiveTerminal, _injectFakeEntry, _bindSessionId, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  // Inject as a "real" entry then mutate it to simulate a temp-keyed new-session entry.
  const entry = _injectFakeEntry(SLUG, SESSION_ID, { sessionId: '', key: `${SLUG}|@new-test` });
  // Move it under a temp key in the map to mirror the production code path.
  // _injectFakeEntry placed it under activeKey(slug, SESSION_ID), so remove that placement first.
  const ts = require('../lib/terminal-server');
  ts._clearAll();
  // Build a fresh fake entry under temp key manually by reusing _injectFakeEntry's shape:
  // injection requires sessionId, so we put a placeholder, then have _bindSessionId reroute it.
  // Use a placeholder sessionId for keying, then verify rebinding to a NEW id succeeds when no entry exists under the new key.
  const TEMP_SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const REAL_SESSION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const placeholder = _injectFakeEntry(SLUG, TEMP_SESSION);
  // Simulate the temp-key state: clear sessionId on the entry (it's just discovered to be unknown)
  placeholder.sessionId = '';
  _bindSessionId(placeholder, REAL_SESSION);
  assert.strictEqual(hasActiveTerminal(SLUG, REAL_SESSION), true);
  // The placeholder key is now stale; _bindSessionId removed it.
  assert.strictEqual(hasActiveTerminal(SLUG, TEMP_SESSION), false);
  _clearAll();
});

test('_bindSessionId is a no-op when entry already has a sessionId', () => {
  const { hasActiveTerminal, _injectFakeEntry, _bindSessionId, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  const SESSION_X = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const SESSION_Y = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const entry = _injectFakeEntry(SLUG, SESSION_X);
  _bindSessionId(entry, SESSION_Y);
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_X), true);
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_Y), false);
  _clearAll();
});

// ── shell mode ───────────────────────────────────────────────────────────────
// The Git tab opens the user's own shell in the project directory over the same bridge, using
// ?mode=shell. It runs no claude session, so it must stay out of the active-session registry.

test('terminal/info in shell mode needs no sessionId and names the shell', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/terminal/info`).query({ mode: 'shell' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.mode, 'shell');
  assert.strictEqual(res.body.sessionId, '');
  assert.ok(res.body.shell, 'the resolved shell command is reported');
});

test('terminal/info in shell mode ignores an unknown sessionId instead of 404ing', async () => {
  const res = await request(app)
    .get(`/api/projects/${SLUG}/terminal/info`)
    .query({ mode: 'shell', sessionId: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.sessionId, '');
});

test('terminal/info in shell mode still rejects a traversal slug', async () => {
  const res = await request(app).get('/api/projects/bad..slug/terminal/info').query({ mode: 'shell' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Invalid slug');
});

test('validateTerminal: shell mode resolves a project path without a session file', () => {
  const { validateTerminal } = require('../lib/terminal-server');
  const shell = validateTerminal(SLUG, '', 'shell');
  assert.strictEqual(shell.ok, true);
  assert.strictEqual(shell.mode, 'shell');
  assert.strictEqual(shell.sessionId, '');
  assert.ok(shell.projectPath);

  const claude = validateTerminal(SLUG, '', 'claude');
  assert.strictEqual(claude.mode, 'claude');
});

test('shellCommand targets the platform shell', () => {
  const { shellCommand } = require('../lib/terminal-server');
  const { cmd, args } = shellCommand();
  assert.ok(Array.isArray(args));
  if (process.platform === 'win32') {
    assert.strictEqual(cmd, 'powershell.exe');
    assert.ok(args.includes('-NoLogo'));
  } else {
    assert.strictEqual(cmd, process.env.SHELL || '/bin/bash');
  }
});

test('a shell entry is keyed per project, apart from that session id', () => {
  const { hasShellTerminal, hasActiveTerminal, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  _injectFakeEntry(SLUG, '', { mode: 'shell', ws: { readyState: 1 } });
  assert.strictEqual(hasShellTerminal(SLUG), true);
  assert.strictEqual(hasShellTerminal('other-project'), false);
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), false, 'a shell is not a session terminal');
  _clearAll();
});

test('a shell never appears among the active terminals', () => {
  const { getActiveTerminals, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  _injectFakeEntry(SLUG, '', { mode: 'shell', ws: { readyState: 1 } });
  _injectFakeEntry(SLUG, SESSION_ID, { ws: { readyState: 1 } });
  const list = getActiveTerminals();
  assert.strictEqual(list.length, 1, 'only the claude session is listed');
  assert.strictEqual(list[0].sessionId, SESSION_ID);
  _clearAll();
});

test('a shell and a claude session for one project coexist', () => {
  const { hasShellTerminal, hasActiveTerminal, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  _injectFakeEntry(SLUG, SESSION_ID, { ws: { readyState: 1 } });
  _injectFakeEntry(SLUG, '', { mode: 'shell', ws: { readyState: 1 } });
  assert.strictEqual(hasActiveTerminal(SLUG, SESSION_ID), true);
  assert.strictEqual(hasShellTerminal(SLUG), true);
  _clearAll();
});

test('_bindSessionId is refused for a shell entry', () => {
  const { _bindSessionId, hasShellTerminal, getActiveTerminals, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  const entry = _injectFakeEntry(SLUG, '', { mode: 'shell', ws: { readyState: 1 } });
  _bindSessionId(entry, SESSION_ID);
  assert.strictEqual(entry.sessionId, '', 'a shell never takes on a session id');
  assert.strictEqual(hasShellTerminal(SLUG), true, 'the shell keeps its own key');
  assert.deepStrictEqual(getActiveTerminals(), [], 'and still never lists as a session');
  _clearAll();
});

test('terminal/info reports whether a shell is already running', async () => {
  const { _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  let res = await request(app).get(`/api/projects/${SLUG}/terminal/info`).query({ mode: 'shell' });
  assert.strictEqual(res.body.running, false);

  _injectFakeEntry(SLUG, '', { mode: 'shell', ws: { readyState: 1 } });
  res = await request(app).get(`/api/projects/${SLUG}/terminal/info`).query({ mode: 'shell' });
  assert.strictEqual(res.body.running, true);
  _clearAll();
});

test('terminal/info omits shell fields in claude mode', async () => {
  const res = await request(app).get(`/api/projects/${SLUG}/terminal/info`);
  assert.strictEqual(res.body.mode, 'claude');
  assert.strictEqual(res.body.shell, undefined);
  assert.strictEqual(res.body.running, undefined);
});

// A shell must survive its browser connection: closing the git panel mid-rebase cannot kill it.
function fakeWs() {
  const handlers = {};
  return {
    readyState: 1,
    handlers,
    on(evt, fn) { handlers[evt] = fn; },
    send() {},
    close() {},
    fire(evt, arg) { if (handlers[evt]) handlers[evt](arg); }
  };
}

test('a disconnected shell stays alive and detached, ready to reattach', () => {
  const { _bindWs, _injectFakeEntry, hasShellTerminal, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  const entry = _injectFakeEntry(SLUG, '', { mode: 'shell' });
  const ws = fakeWs();
  _bindWs(entry, ws);
  assert.strictEqual(entry.ws, ws);

  ws.fire('close');
  assert.strictEqual(entry.terminated, false, 'the pty is not killed');
  assert.strictEqual(entry.ws, null, 'but the view is detached');
  assert.ok(entry.detachedAt, 'and the detach is timestamped');
  assert.strictEqual(hasShellTerminal(SLUG), true, 'so it can be reattached');
  _clearAll();
});

test('an explicit close from the client terminates the shell', () => {
  const { _bindWs, _injectFakeEntry, hasShellTerminal, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  let killed = false;
  const entry = _injectFakeEntry(SLUG, '', { mode: 'shell', term: { kill() { killed = true; }, pid: process.pid } });
  const ws = fakeWs();
  _bindWs(entry, ws);

  ws.fire('message', JSON.stringify({ t: 'close' }));
  assert.strictEqual(killed, true);
  assert.strictEqual(entry.terminated, true);
  assert.strictEqual(hasShellTerminal(SLUG), false);
  _clearAll();
});

test('shell input and resize reach the pty', () => {
  const { _bindWs, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  const writes = [];
  const resizes = [];
  const entry = _injectFakeEntry(SLUG, '', {
    mode: 'shell',
    term: { write: d => writes.push(d), resize: (c, r) => resizes.push([c, r]), kill() {}, pid: process.pid }
  });
  const ws = fakeWs();
  _bindWs(entry, ws);

  ws.fire('message', JSON.stringify({ t: 'i', d: 'git status -sb' }));
  ws.fire('message', JSON.stringify({ t: 'r', c: 120, r: 40 }));
  assert.deepStrictEqual(writes, ['git status -sb'], 'typed text is passed through verbatim');
  assert.deepStrictEqual(resizes, [[120, 40]]);
  _clearAll();
});

test('a new-session claude terminal with no session id still dies on disconnect', () => {
  const { _bindWs, _injectFakeEntry, _clearAll } = require('../lib/terminal-server');
  _clearAll();
  let killed = false;
  const entry = _injectFakeEntry(SLUG, SESSION_ID, { term: { kill() { killed = true; }, pid: process.pid } });
  entry.sessionId = '';
  const ws = fakeWs();
  _bindWs(entry, ws);

  ws.fire('close');
  assert.strictEqual(killed, true, 'there is no way to find it again, so it is not kept');
  assert.strictEqual(entry.terminated, true);
  _clearAll();
});

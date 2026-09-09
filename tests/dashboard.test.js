const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app, paths } = require('./helpers/app');

before(() => {
  fs.mkdirSync(paths.PROJECTS_DIR, { recursive: true });
});

test('GET /api/dashboard returns stats and recentSessions on empty HOME', async () => {
  const res = await request(app).get('/api/dashboard');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.stats, 'stats present');
  assert.ok(Array.isArray(res.body.recentSessions), 'recentSessions array');
  const s = res.body.stats;
  assert.strictEqual(typeof s.projects, 'number');
  assert.strictEqual(typeof s.sessions, 'number');
  assert.strictEqual(typeof s.memoryFiles, 'number');
  assert.strictEqual(typeof s.mcpServers, 'number');
  assert.strictEqual(typeof s.skills, 'number');
  assert.strictEqual(typeof s.outputStyles, 'number');
  assert.strictEqual(typeof s.keybindings, 'number');
});

test('GET /api/dashboard picks up seeded project and session fallback', async () => {
  const slug = 'dash-proj-beta';
  const projDir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'memory', 'x.md'), '# X');
  const jsonl = JSON.stringify({ type: 'user', message: { content: 'hello world' }, timestamp: new Date().toISOString() });
  fs.writeFileSync(path.join(projDir, 'sess-xyz.jsonl'), jsonl + '\n');

  const res = await request(app).get('/api/dashboard');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.stats.projects >= 1);
  assert.ok(res.body.stats.memoryFiles >= 1);
  assert.ok(res.body.stats.sessions >= 1);
  const recent = res.body.recentSessions.find(r => r.sessionId === 'sess-xyz');
  assert.ok(recent, 'recent session should include seeded session');
  assert.strictEqual(recent.slug, slug);
  assert.strictEqual(recent.messageCount, 1);
});

test('GET /api/dashboard/active-count returns total + byProject (empty)', async () => {
  const activeSessions = require('../lib/active-sessions');
  const terminalServer = require('../lib/terminal-server');
  activeSessions._reset();
  terminalServer._clearAll();
  const res = await request(app).get('/api/dashboard/active-count');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 0);
  assert.deepStrictEqual(res.body.byProject, {});
});

test('GET /api/dashboard/active-count counts browser ptys and OS launches without double-counting', async () => {
  const activeSessions = require('../lib/active-sessions');
  const terminalServer = require('../lib/terminal-server');
  activeSessions._reset();
  terminalServer._clearAll();

  // Browser pty (would also self-register in active-sessions under real spawn; do both for dedup test)
  const SLUG_A = 'dash-active-a';
  const SLUG_B = 'dash-active-b';
  const SID_A1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const SID_A2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const SID_B1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  fs.mkdirSync(path.join(paths.PROJECTS_DIR, SLUG_A), { recursive: true });
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, SLUG_B), { recursive: true });
  for (const [slug, sid] of [[SLUG_A, SID_A1], [SLUG_A, SID_A2], [SLUG_B, SID_B1]]) {
    fs.writeFileSync(path.join(paths.PROJECTS_DIR, slug, sid + '.jsonl'), '{"type":"user","message":{"content":"x"}}\n');
  }

  terminalServer._injectFakeEntry(SLUG_A, SID_A1, { ws: null });
  activeSessions.register(SLUG_A, SID_A1, 'browser-terminal'); // dedup test: same session in both sources
  activeSessions.register(SLUG_A, SID_A2, 'os-terminal');
  activeSessions.register(SLUG_B, SID_B1, 'os-terminal');

  const res = await request(app).get('/api/dashboard/active-count');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 3);
  assert.strictEqual(res.body.byProject[SLUG_A], 2);
  assert.strictEqual(res.body.byProject[SLUG_B], 1);

  activeSessions._reset();
  terminalServer._clearAll();
});

test('GET /api/dashboard/active-count dedupes a real process plus multiple read-only instances on one session', async () => {
  const activeSessions = require('../lib/active-sessions');
  const terminalServer = require('../lib/terminal-server');
  activeSessions._reset();
  terminalServer._clearAll();

  const SLUG_A = 'dash-active-ro';
  const SID_A1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, SLUG_A), { recursive: true });
  fs.writeFileSync(path.join(paths.PROJECTS_DIR, SLUG_A, SID_A1 + '.jsonl'), '{"type":"user","message":{"content":"x"}}\n');

  // A session with a real OS launch plus two read-only viewer instances is still ONE session —
  // the card for it shows a single dot (os wins), so the badge must count it once, not three times.
  activeSessions.register(SLUG_A, SID_A1, 'os-terminal');
  activeSessions.registerReadonly(SLUG_A, SID_A1, 'instance-1');
  activeSessions.registerReadonly(SLUG_A, SID_A1, 'instance-2');

  const res = await request(app).get('/api/dashboard/active-count');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.byProject[SLUG_A], 1);

  activeSessions._reset();
  terminalServer._clearAll();
});

test('GET /api/dashboard/active-count counts a read-only-only session (no real process)', async () => {
  const activeSessions = require('../lib/active-sessions');
  const terminalServer = require('../lib/terminal-server');
  activeSessions._reset();
  terminalServer._clearAll();

  const SLUG_A = 'dash-active-ro-only';
  const SID_A1 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  fs.mkdirSync(path.join(paths.PROJECTS_DIR, SLUG_A), { recursive: true });
  fs.writeFileSync(path.join(paths.PROJECTS_DIR, SLUG_A, SID_A1 + '.jsonl'), '{"type":"user","message":{"content":"x"}}\n');

  activeSessions.registerReadonly(SLUG_A, SID_A1, 'instance-1');

  const res = await request(app).get('/api/dashboard/active-count');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.byProject[SLUG_A], 1);

  activeSessions._reset();
  terminalServer._clearAll();
});

test('GET /api/dashboard returns activeSessions array (empty when nothing is active)', async () => {
  const activeSessions = require('../lib/active-sessions');
  const terminalServer = require('../lib/terminal-server');
  activeSessions._reset();
  terminalServer._clearAll();
  const res = await request(app).get('/api/dashboard');
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.activeSessions), 'activeSessions array');
  assert.strictEqual(res.body.activeSessions.length, 0);
});

test('GET /api/dashboard recentSessions entries include remoteControlled field', async () => {
  const res = await request(app).get('/api/dashboard');
  assert.strictEqual(res.status, 200);
  for (const s of res.body.recentSessions) {
    assert.ok('remoteControlled' in s, `session ${s.sessionId} must have remoteControlled`);
    assert.strictEqual(typeof s.remoteControlled, 'boolean');
  }
});

test('GET /api/dashboard remoteControlled is true when JSONL contains bridge-session marker', async () => {
  const slug = 'dash-bridge-proj';
  const projDir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const bridgeEntry = JSON.stringify({ type: 'bridge-session', timestamp: new Date().toISOString() });
  const userEntry = JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: new Date().toISOString() });
  fs.writeFileSync(path.join(projDir, 'bridge-sess.jsonl'), bridgeEntry + '\n' + userEntry + '\n');

  const res = await request(app).get('/api/dashboard');
  assert.strictEqual(res.status, 200);
  const s = res.body.recentSessions.find(r => r.sessionId === 'bridge-sess');
  assert.ok(s, 'bridge session must appear in recent');
  assert.strictEqual(s.remoteControlled, true);
});

test('GET /api/dashboard splits active vs recent: active sessions removed from recent list', async () => {
  const activeSessions = require('../lib/active-sessions');
  const terminalServer = require('../lib/terminal-server');
  activeSessions._reset();
  terminalServer._clearAll();

  // Mark the seeded sess-xyz as active via the OS-terminal registry
  activeSessions.register('dash-proj-beta', 'sess-xyz', 'os-terminal');

  const res = await request(app).get('/api/dashboard');
  assert.strictEqual(res.status, 200);
  const inActive = res.body.activeSessions.find(s => s.sessionId === 'sess-xyz');
  const inRecent = res.body.recentSessions.find(s => s.sessionId === 'sess-xyz');
  assert.ok(inActive, 'sess-xyz should appear in activeSessions');
  assert.strictEqual(inActive.active, true);
  assert.strictEqual(inActive.activeKind, 'os');
  assert.strictEqual(inRecent, undefined, 'sess-xyz should NOT also appear in recentSessions');

  activeSessions._reset();
});

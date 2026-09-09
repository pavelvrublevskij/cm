const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { paths } = require('./helpers/app');

const SLUG = 'active-sessions-test-proj';
const SESSION_A = '44444444-4444-4444-4444-444444444444';
const SESSION_B = '55555555-5555-5555-5555-555555555555';
const PROJECT_DIR = path.join(paths.PROJECTS_DIR, SLUG);

const activeSessions = require('../lib/active-sessions');
const { ACTIVE_THRESHOLD_MS, LAUNCH_GRACE_MS, IGNORE_TTL_MS } = activeSessions;

before(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
});

beforeEach(() => activeSessions._reset());

test('a freshly registered session is active regardless of mtime', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  const ancient = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, ancient), true);
});

test('an unregistered session is not active', () => {
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('after launchedAt expires, recent mtime keeps the session active', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions._backdate(SLUG, SESSION_A, Date.now() - (ACTIVE_THRESHOLD_MS + 1000));
  const justNow = new Date().toISOString();
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, justNow), true);
});

test('after launchedAt expires AND mtime is stale, the entry is pruned and inactive', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions._backdate(SLUG, SESSION_A, Date.now() - (ACTIVE_THRESHOLD_MS + 1000));
  const stale = new Date(Date.now() - (ACTIVE_THRESHOLD_MS + 1000)).toISOString();
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, stale), false);
  // Subsequent calls confirm the entry is gone (now even fresh mtime can't revive it)
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('isActive with no mtime + stale launchedAt prunes the entry', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions._backdate(SLUG, SESSION_A, Date.now() - (ACTIVE_THRESHOLD_MS + 1000));
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, null), false);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('registerPendingNew + resolvePendingNew promotes a session inside the grace window', () => {
  activeSessions.registerPendingNew(SLUG);
  const justNow = new Date().toISOString();
  activeSessions.resolvePendingNew(SLUG, [{ sessionId: SESSION_A, created: justNow }]);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, justNow), true);
});

test('resolvePendingNew ignores sessions created outside the grace window', () => {
  activeSessions.registerPendingNew(SLUG);
  const wayBack = new Date(Date.now() - (LAUNCH_GRACE_MS + 5000)).toISOString();
  activeSessions.resolvePendingNew(SLUG, [{ sessionId: SESSION_A, created: wayBack }]);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('resolvePendingNew drops stale pending entries even when no match is found', () => {
  activeSessions.registerPendingNew(SLUG);
  // First call: nothing matches, but the pending entry is fresh so it survives.
  activeSessions.resolvePendingNew(SLUG, []);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('unregister removes an entry', () => {
  activeSessions.register(SLUG, SESSION_A, 'browser-terminal');
  activeSessions.unregister(SLUG, SESSION_A);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('register is a no-op for missing slug or sessionId', () => {
  activeSessions.register('', SESSION_A, 'os-terminal');
  activeSessions.register(SLUG, '', 'os-terminal');
  assert.strictEqual(activeSessions.isActive('', SESSION_A, new Date().toISOString()), false);
  assert.strictEqual(activeSessions.isActive(SLUG, '', new Date().toISOString()), false);
});

test('multiple sessions in one project can be active simultaneously', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions.register(SLUG, SESSION_B, 'browser-terminal');
  const iso = new Date().toISOString();
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, iso), true);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_B, iso), true);
});

// ── deactivate ────────────────────────────────────────────────────────────────

test('deactivate: removes entry from registry', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions.deactivate(SLUG, SESSION_A);
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('deactivate: re-registration within TTL is suppressed', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions.deactivate(SLUG, SESSION_A);
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), false);
});

test('deactivate: re-registration succeeds after TTL expires', () => {
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  activeSessions.deactivate(SLUG, SESSION_A);
  // Backdate the ignored entry to simulate TTL expiry
  activeSessions._backdateIgnored(SLUG, SESSION_A, Date.now() - (IGNORE_TTL_MS + 1000));
  activeSessions.register(SLUG, SESSION_A, 'os-terminal');
  assert.strictEqual(activeSessions.isActive(SLUG, SESSION_A, new Date().toISOString()), true);
});

test('deactivate: no-op for unknown session', () => {
  activeSessions.deactivate(SLUG, 'no-such-session');
  assert.strictEqual(activeSessions.isActive(SLUG, 'no-such-session', new Date().toISOString()), false);
});

// ── listActive / TTL sweep ────────────────────────────────────────────────────

test('listActive: sweeps expired ignored entries so ignored map does not grow unbounded', () => {
  activeSessions.deactivate(SLUG, SESSION_A);
  activeSessions.deactivate(SLUG, SESSION_B);
  assert.strictEqual(activeSessions._ignoredSize(), 2);

  // Expire both entries
  activeSessions._backdateIgnored(SLUG, SESSION_A, Date.now() - (IGNORE_TTL_MS + 1000));
  activeSessions._backdateIgnored(SLUG, SESSION_B, Date.now() - (IGNORE_TTL_MS + 1000));

  activeSessions.listActive();
  assert.strictEqual(activeSessions._ignoredSize(), 0);
});

test('listActive: does not sweep ignored entries still within TTL', () => {
  activeSessions.deactivate(SLUG, SESSION_A);
  activeSessions.deactivate(SLUG, SESSION_B);

  // Only expire one
  activeSessions._backdateIgnored(SLUG, SESSION_A, Date.now() - (IGNORE_TTL_MS + 1000));

  activeSessions.listActive();
  assert.strictEqual(activeSessions._ignoredSize(), 1);
});

// ── read-only viewer instances ───────────────────────────────────────────────

test('registerReadonly: listReadonly reflects a registered instance', () => {
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  assert.deepStrictEqual(activeSessions.listReadonly(), [
    { slug: SLUG, sessionId: SESSION_A, instanceId: 'instance-1' }
  ]);
});

test('registerReadonly: the same session can have multiple simultaneous instances', () => {
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-2');
  const list = activeSessions.listReadonly();
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(new Set(list.map(e => e.instanceId)), new Set(['instance-1', 'instance-2']));
});

test('registerReadonly: is a no-op for missing slug, sessionId, or instanceId', () => {
  activeSessions.registerReadonly('', SESSION_A, 'instance-1');
  activeSessions.registerReadonly(SLUG, '', 'instance-1');
  activeSessions.registerReadonly(SLUG, SESSION_A, '');
  assert.strictEqual(activeSessions.listReadonly().length, 0);
});

test('deactivateReadonly: removes only the matching instance', () => {
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-2');
  activeSessions.deactivateReadonly(SLUG, SESSION_A, 'instance-1');
  assert.deepStrictEqual(activeSessions.listReadonly(), [
    { slug: SLUG, sessionId: SESSION_A, instanceId: 'instance-2' }
  ]);
});

test('readonly instances never expire on their own (no TTL heuristic applies)', () => {
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  // listActive()/isActive() TTL machinery is unrelated to readonly instances.
  assert.strictEqual(activeSessions.listReadonly().length, 1);
});

test('hasReadonly: true once any instance is registered for that session', () => {
  assert.strictEqual(activeSessions.hasReadonly(SLUG, SESSION_A), false);
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  assert.strictEqual(activeSessions.hasReadonly(SLUG, SESSION_A), true);
});

test('hasReadonly: false after the last instance for a session is deactivated', () => {
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-2');
  activeSessions.deactivateReadonly(SLUG, SESSION_A, 'instance-1');
  assert.strictEqual(activeSessions.hasReadonly(SLUG, SESSION_A), true);
  activeSessions.deactivateReadonly(SLUG, SESSION_A, 'instance-2');
  assert.strictEqual(activeSessions.hasReadonly(SLUG, SESSION_A), false);
});

test('hasReadonly: does not match a different session in the same project', () => {
  activeSessions.registerReadonly(SLUG, SESSION_A, 'instance-1');
  assert.strictEqual(activeSessions.hasReadonly(SLUG, SESSION_B), false);
});

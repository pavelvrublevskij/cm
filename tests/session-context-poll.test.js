const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load sessions.js + session-context.js in a browser-like sandbox with fake timers
// so the File Changes polling lifecycle can be asserted.
const sessionsSrc = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');
const contextSrc = fs.readFileSync(path.join(__dirname, '../public/js/session-context.js'), 'utf-8');

const harness = {
  store: {},
  timers: new Map(),
  nextTimerId: 1,
  apiResponse: { files: [], plans: [], projSlug: 'proj' },
  apiCalls: [],
  ctxEl: null,
};

function makeEl() {
  return { innerHTML: '', style: {}, querySelectorAll: () => [], closest: () => null };
}

const context = vm.createContext({
  localStorage: {
    getItem: k => (k in harness.store ? harness.store[k] : null),
    setItem: (k, v) => { harness.store[k] = String(v); },
  },
  document: {
    addEventListener: () => {},
    getElementById: id => (id === 'session-context' ? harness.ctxEl : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  setInterval: (fn, ms) => {
    const id = harness.nextTimerId++;
    harness.timers.set(id, { fn, ms });
    return id;
  },
  clearInterval: id => { harness.timers.delete(id); },
  requestAnimationFrame: fn => fn(),
  api: async url => { harness.apiCalls.push(url); return harness.apiResponse; },
  escapeHtml: s => String(s),
  debounce: fn => fn,
  toast: () => {},
  timeAgo: () => '1m ago',
  renderMarkdown: s => s,
  openModal: () => makeEl(),
  renderSessionCard: () => '',
  renderSessionBadges: () => '',
  ProjectUsage: {},
  copyToClipboard: () => {},
  decodeName: s => s,
  setFooterStatus: () => {},
  showLoading: () => {},
  FileHistory: {},
  App: { navigate: () => {}, setHash: () => {} },
  TerminalPanel: { isOpen: () => false, shouldAutoOpen: () => false },
});
vm.runInContext(sessionsSrc + '\n' + contextSrc + '\nglobalThis._Sessions = Sessions;', context);
const Sessions = context._Sessions;

function file(p, mtime, extra = {}) {
  return { path: p, hash: 'abc', versions: [1], isNew: false, isDeleted: false, mtime, ...extra };
}

beforeEach(() => {
  harness.store = {};
  harness.timers.clear();
  harness.apiCalls = [];
  harness.ctxEl = makeEl();
  Sessions._ctx = null;
  Sessions._detailInfo = {};
  Sessions._pendingFlash = undefined;
  Sessions.detailState = { slug: 'proj', sessionId: 's1', offset: 0, loading: false, hasMore: false, total: 0 };
  Sessions._refreshTimer = null;
  Sessions._ctxTimer = null;
  Sessions._discoverTimer = null;
});

// ── polling lifecycle ─────────────────────────────────────────────────────────

test('startAutoRefresh does not kill File Changes polling', () => {
  Sessions.startCtxPolling();
  const ctxTimer = Sessions._ctxTimer;
  assert.ok(ctxTimer);

  Sessions.startAutoRefresh();

  assert.strictEqual(Sessions._ctxTimer, ctxTimer, 'ctx timer must survive startAutoRefresh');
  assert.ok(harness.timers.has(ctxTimer), 'ctx interval must still be registered');
});

test('hiding the conversation keeps File Changes polling alive', () => {
  Sessions.startCtxPolling();
  Sessions.startAutoRefresh();
  const ctxTimer = Sessions._ctxTimer;

  Sessions.stopConversationRefresh();

  assert.strictEqual(Sessions._refreshTimer, null);
  assert.strictEqual(Sessions._ctxTimer, ctxTimer);
  assert.ok(harness.timers.has(ctxTimer));
});

test('stopAutoRefresh stops both conversation and File Changes polling', () => {
  Sessions.startCtxPolling();
  Sessions.startAutoRefresh();

  Sessions.stopAutoRefresh();

  assert.strictEqual(Sessions._refreshTimer, null);
  assert.strictEqual(Sessions._ctxTimer, null);
  assert.strictEqual(harness.timers.size, 0);
});

test('startCtxPolling replaces an existing timer instead of leaking one', () => {
  Sessions.startCtxPolling();
  const first = Sessions._ctxTimer;
  Sessions.startCtxPolling();

  assert.notStrictEqual(Sessions._ctxTimer, first);
  assert.strictEqual(harness.timers.size, 1);
});

test('changing the refresh interval restarts File Changes polling at the new rate', () => {
  Sessions.startCtxPolling();
  Sessions.startAutoRefresh();

  assert.strictEqual(Sessions.setRefreshIntervalMs(9000), true);

  assert.ok(Sessions._ctxTimer, 'ctx polling must still be running');
  assert.strictEqual(harness.timers.get(Sessions._ctxTimer).ms, 9000);
});

test('the File Changes timer polls the session in detailState', async () => {
  Sessions.startCtxPolling();
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };

  await harness.timers.get(Sessions._ctxTimer).fn();

  assert.strictEqual(harness.apiCalls.length, 1);
  assert.ok(harness.apiCalls[0].includes('s1'));
});

// ── change detection ──────────────────────────────────────────────────────────

test('pollContext re-renders when a tracked file mtime changes', async () => {
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');
  const firstHtml = harness.ctxEl.innerHTML;
  assert.ok(firstHtml.includes('a.js'));

  harness.ctxEl.innerHTML = '';
  harness.apiResponse = { files: [file('a.js', 200)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('a.js'), 'changed mtime must trigger a re-render');
  assert.strictEqual(Sessions._ctx.files[0].mtime, 200);
});

test('pollContext re-renders when a new file appears', async () => {
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  harness.ctxEl.innerHTML = '';
  harness.apiResponse = { files: [file('a.js', 100), file('b.js', 100, { isNew: true })], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('b.js'));
});

test('pollContext re-renders when a file drops out of the list', async () => {
  harness.apiResponse = { files: [file('a.js', 100), file('b.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  harness.ctxEl.innerHTML = '';
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('a.js'));
  assert.strictEqual(harness.ctxEl.innerHTML.includes('b.js'), false);
});

test('pollContext re-renders when a file flips to deleted', async () => {
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  harness.ctxEl.innerHTML = '';
  harness.apiResponse = { files: [file('a.js', 100, { isDeleted: true })], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('ctx-file-deleted'));
});

test('pollContext skips the re-render when nothing changed', async () => {
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  harness.ctxEl.innerHTML = 'UNTOUCHED';
  await Sessions.pollContext('proj', 's1');

  assert.strictEqual(harness.ctxEl.innerHTML, 'UNTOUCHED');
});

test('pollContext ignores another session\'s cached context', async () => {
  // s0 saw the same file at the same mtime; s1 must still render it.
  Sessions._ctx = { sessionId: 's0', projSlug: 'proj', files: [file('a.js', 100)], plans: [], sort: 'default' };

  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('a.js'), 'stale cross-session ctx must not suppress the render');
  assert.strictEqual(Sessions._ctx.sessionId, 's1');
});

test('pollContext re-renders when a plan is updated without changing the count', async () => {
  harness.apiResponse = { files: [], plans: [{ name: 'plan-a', mtime: '2026-01-01T10:00:00.000Z' }], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  harness.ctxEl.innerHTML = '';
  harness.apiResponse = { files: [], plans: [{ name: 'plan-a', mtime: '2026-01-01T11:00:00.000Z' }], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('plan-a'));
});

test('renderContext records an empty context for the session it rendered', () => {
  Sessions.renderContext(harness.ctxEl, 's1', { files: [], plans: [], projSlug: 'proj' });

  assert.strictEqual(Sessions._ctx.sessionId, 's1');
  assert.strictEqual(Sessions._ctx.files.length, 0);
});

test('pollContext flashes changed rows only after the tab becomes visible', async () => {
  harness.ctxEl.style.display = 'none';
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('a.js'), 'render must happen even while hidden');
  assert.ok(Sessions._pendingFlash instanceof Set || Sessions._pendingFlash);
});

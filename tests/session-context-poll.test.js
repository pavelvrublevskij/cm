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
    getElementById: id => (id === 'session-context' || id === 'sf-changed' ? harness.ctxEl : null),
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
  SessionFiles: {
    open: null,
    setChangedPaths: paths => { harness.changedPaths = paths; },
    openFile: (path, opts) => { harness.opened = { path, opts }; },
  },
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
  harness.changedPaths = null;
  harness.opened = null;
  Sessions._ctxCollapsed = new Set();
  Sessions._ctx = null;
  Sessions._detailInfo = {};
  Sessions._pendingFlash = undefined;
  Sessions.detailState = { slug: 'proj', sessionId: 's1', offset: 0, loading: false, hasMore: false, total: 0 };
  Sessions._refreshTimer = null;
  Sessions._ctxTimer = null;
  Sessions._discoverTimer = null;
  harness.spPolls = 0;
  Sessions.pollScratchpad = () => { harness.spPolls++; }; // session-scratchpad.js supplies this on the page
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

test('the same timer tick also refreshes the scratchpad', async () => {
  Sessions.startCtxPolling();
  harness.apiResponse = { files: [], plans: [], projSlug: 'proj' };

  await harness.timers.get(Sessions._ctxTimer).fn();
  assert.strictEqual(harness.spPolls, 1);

  Sessions.detailState.sessionId = null;
  await harness.timers.get(Sessions._ctxTimer).fn();
  assert.strictEqual(harness.spPolls, 1, 'no session, nothing to poll');
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

// ── changed files render as a tree ─────────────────────────────────────────────

test('changed files render as nested rows, deepest paths indented', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('public/js/app.js', 100), file('public/index.html', 100), file('server.js', 100)],
  });

  const html = harness.ctxEl.innerHTML;
  assert.ok(html.includes('sf-row-dir'), 'folders render as tree rows');
  assert.ok(html.includes('--sf-depth:0'));
  assert.ok(html.includes('--sf-depth:2'), 'public/js/app.js sits two levels deep');
  assert.ok(html.includes('>public<'));
  assert.ok(html.includes('>js<'));
  assert.ok(html.includes('>app.js<'));
  assert.ok(html.includes('>server.js<'));
});

test('folders holding only one folder merge into a single row', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('src/main/java/app/Main.java', 100)],
  });

  const html = harness.ctxEl.innerHTML;
  assert.ok(html.includes('>src/main/java/app<'), 'the whole empty chain becomes one row');
  assert.strictEqual(html.includes('>src<'), false);
  assert.ok(html.includes('>Main.java<'));
  assert.ok(html.includes('--sf-depth:1'), 'the file sits one level under the merged row');
  assert.strictEqual(html.includes('--sf-depth:2'), false);
});

test('a merged chain stops where a folder has files of its own', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('lib/helpers/util.js', 100), file('lib/paths.js', 100)],
  });

  const html = harness.ctxEl.innerHTML;
  assert.ok(html.includes('>lib<'), 'lib has its own file, so it is not merged away');
  assert.ok(html.includes('>helpers<'));
  assert.strictEqual(html.includes('>lib/helpers<'), false);
});

test('collapsing a merged folder row hides its files', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('public/js/app.js', 100)],
  });

  Sessions.toggleCtxDir('public/js');
  assert.strictEqual(Sessions._renderCtxFileList().includes('app.js'), false);
  Sessions.toggleCtxDir('public/js');
  assert.ok(Sessions._renderCtxFileList().includes('app.js'));
});

test('changed rows carry no per-row action menu', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('a.js', 100)],
  });

  assert.strictEqual(harness.ctxEl.innerHTML.includes('action-menu'), false);
});

test('each changed file keeps its status badge', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [
      file('a.js', 100),
      file('b.js', 100, { isNew: true }),
      file('c.js', 100, { isDeleted: true }),
    ],
  });

  const html = harness.ctxEl.innerHTML;
  assert.ok(html.includes('ctx-file-badge-edited'));
  assert.ok(html.includes('ctx-file-badge-new'));
  assert.ok(html.includes('ctx-file-badge-deleted'));
});

test('collapsing a folder hides the files under it', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('routes/git.js', 100), file('server.js', 100)],
  });
  assert.ok(harness.ctxEl.innerHTML.includes('git.js'));

  Sessions.toggleCtxDir('routes');
  const html = Sessions._renderCtxFileList();
  assert.strictEqual(html.includes('git.js'), false);
  assert.ok(html.includes('routes'), 'the folder row stays');
  assert.ok(html.includes('server.js'), 'siblings are unaffected');

  Sessions.toggleCtxDir('routes');
  assert.ok(Sessions._renderCtxFileList().includes('git.js'));
});

test('sorting reorders each level of the tree', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('b.js', 100), file('a.js', 100)],
  });

  Sessions._ctx.sort = 'asc';
  const asc = Sessions._renderCtxFileList();
  assert.ok(asc.indexOf('a.js') < asc.indexOf('b.js'));

  Sessions._ctx.sort = 'desc';
  const desc = Sessions._renderCtxFileList();
  assert.ok(desc.indexOf('b.js') < desc.indexOf('a.js'));
});

test('clicking a changed file opens it in the pane like any project file', () => {
  Sessions._ctx = { sessionId: 's1', projSlug: 'proj', files: [file('routes/git.js', 100)], plans: [], sort: 'default' };
  Sessions._openCtxRow({ dataset: { path: 'routes/git.js', session: 's1', hash: 'abc', from: '1', isNew: '', isDeleted: '' } });

  assert.strictEqual(harness.opened.path, 'routes/git.js');
  assert.strictEqual(harness.opened.opts.mode, undefined, 'no forced mode — source, with diff a toggle away');
  assert.strictEqual(harness.opened.opts.ctx.hash, 'abc');
});

test('the tree below is told which paths are pinned above it', () => {
  Sessions.renderContext(harness.ctxEl, 's1', {
    projSlug: 'proj',
    plans: [],
    files: [file('routes/git.js', 100), file('.claude/settings.json', 100)],
  });

  assert.deepStrictEqual(harness.changedPaths, ['routes/git.js'], '.claude/ entries stay visible in the tree');
});

test('pollContext flashes changed rows only after the tab becomes visible', async () => {
  harness.ctxEl.style.display = 'none';
  harness.apiResponse = { files: [file('a.js', 100)], plans: [], projSlug: 'proj' };
  await Sessions.pollContext('proj', 's1');

  assert.ok(harness.ctxEl.innerHTML.includes('a.js'), 'render must happen even while hidden');
  assert.ok(Sessions._pendingFlash instanceof Set || Sessions._pendingFlash);
});

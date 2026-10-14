const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Returning to a session (active sessions bar, back navigation, or a page reload) used to always
// reset it: scroll to top, tab back to Files, only the first page of messages, search cleared.
// Sessions.captureSnapshot()/loadDetail() now remember and restore that state per session.
const sessionsSrc = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');
const contextSrc = fs.readFileSync(path.join(__dirname, '../public/js/session-context.js'), 'utf-8');
const messagesSrc = fs.readFileSync(path.join(__dirname, '../public/js/session-messages.js'), 'utf-8');

const harness = {
  localStore: {},
  sessionStore: {},
  elementsById: {},
  timers: new Map(),
  nextTimerId: 1,
  apiCalls: [],
  totalMessages: 5,
  openFileCalls: [],
};

function makeEl() {
  return {
    innerHTML: '', textContent: '', title: '', value: '', scrollTop: 0,
    style: { display: '', cssText: '' },
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    insertAdjacentHTML() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    closest: () => null,
  };
}

function fakeMessage(i) {
  return { timestamp: null, role: 'user', content: [{ type: 'text', text: 'msg' + i }], model: null };
}

async function fakeApi(url) {
  harness.apiCalls.push(url);
  // A file "changed" so the Files tab has content to show — otherwise loadContext auto-switches
  // to Conversation, which is real (documented) behavior but not what these tests are about.
  if (url.includes('/context')) {
    return { files: [{ path: 'a.js', hash: 'x', versions: [1], isNew: false, isDeleted: false, mtime: 1 }], plans: [], projSlug: 'proj' };
  }
  const m = url.match(/offset=(\d+)&limit=(\d+)/);
  if (m) {
    const offset = parseInt(m[1], 10);
    const limit = parseInt(m[2], 10);
    const total = harness.totalMessages;
    const messages = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) messages.push(fakeMessage(i));
    return { total, hasMore: offset + messages.length < total, messages, stats: null };
  }
  return {};
}

const context = vm.createContext({
  localStorage: {
    getItem: k => (k in harness.localStore ? harness.localStore[k] : null),
    setItem: (k, v) => { harness.localStore[k] = String(v); },
  },
  sessionStorage: {
    getItem: k => (k in harness.sessionStore ? harness.sessionStore[k] : null),
    setItem: (k, v) => { harness.sessionStore[k] = String(v); },
  },
  document: {
    addEventListener: () => {},
    getElementById: id => (harness.elementsById[id] || (harness.elementsById[id] = makeEl())),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
  },
  setInterval: (fn, ms) => { const id = harness.nextTimerId++; harness.timers.set(id, { fn, ms }); return id; },
  clearInterval: id => { harness.timers.delete(id); },
  requestAnimationFrame: fn => fn(),
  api: (...args) => fakeApi(...args),
  escapeHtml: s => String(s),
  escapeAttr: s => String(s),
  decodeName: s => s,
  debounce: fn => fn,
  toast: () => {},
  timeAgo: () => '1m ago',
  renderMarkdown: s => s,
  renderChatMarkdown: s => s,
  shortModel: s => String(s),
  addCodeCopyButtons: () => {},
  openModal: () => makeEl(),
  renderSessionCard: () => '',
  renderSessionBadges: () => '',
  ProjectUsage: {},
  copyToClipboard: () => {},
  setFooterStatus: () => {},
  showLoading: () => {},
  FileHistory: {},
  SessionFiles: {
    treeLoaded: true,
    editor: null,
    open: null,
    reset() { this.open = null; },
    loadTree: () => {},
    setChangedPaths: () => {},
    openFile(path, opts = {}) {
      harness.openFileCalls.push({ path, opts });
      this.open = { path, mode: opts.mode || 'source', ctx: opts.ctx || null };
    },
  },
  App: { navigate: () => {}, setHash: () => {} },
  TerminalPanel: { isOpen: () => false, shouldAutoOpen: () => false, open: () => {} },
  ActiveSessionsBar: { poll: () => {} },
});
vm.runInContext(sessionsSrc + '\n' + contextSrc + '\n' + messagesSrc + '\nglobalThis._Sessions = Sessions;', context);
const Sessions = context._Sessions;
const SessionFiles = context.SessionFiles;

// Tab content for these three tabs lives in files this harness doesn't load — stub them so
// switchTab()/loadDetail() don't crash reaching into scratchpad/artifacts/activity loading.
Sessions.checkScratchpad = async () => {};
Sessions.checkArtifacts = async () => {};
Sessions._updateScratchpadTabVisibility = () => {};
Sessions._updateArtifactsTabVisibility = () => {};
Sessions.loadArtifactsTab = () => {};
Sessions.loadActivity = () => {};
Sessions.loadScratchpad = () => {};

beforeEach(() => {
  harness.localStore = {};
  harness.sessionStore = {};
  harness.elementsById = {};
  harness.timers.clear();
  harness.apiCalls = [];
  harness.totalMessages = 5;
  harness.openFileCalls = [];
  Sessions.detailState = { slug: null, sessionId: null, offset: 0, loading: false, hasMore: false, total: 0 };
  Sessions._activeTab = null;
  Sessions._detailSearchQuery = '';
  SessionFiles.open = null;
});

test('captureSnapshot does nothing without an open session', () => {
  Sessions.captureSnapshot();
  assert.deepStrictEqual(Object.keys(Sessions._loadSnapshots()), []);
});

test('captureSnapshot records tab, scroll, offset and search for the current session', () => {
  Sessions.detailState = { slug: 'proj', sessionId: 's1', offset: 40, loading: false, hasMore: true, total: 100 };
  Sessions._activeTab = 'scratchpad';
  Sessions._detailSearchQuery = 'needle';
  harness.elementsById['session-messages-pane'] = makeEl();
  harness.elementsById['session-messages-pane'].scrollTop = 777;

  Sessions.captureSnapshot();

  const snap = Sessions._getSnapshot('proj', 's1');
  assert.strictEqual(snap.tab, 'scratchpad');
  assert.strictEqual(snap.scrollTop, 777);
  assert.strictEqual(snap.offset, 40);
  assert.strictEqual(snap.searchQuery, 'needle');
});

test('captureSnapshot records the file open in the Files tab', () => {
  Sessions.detailState = { slug: 'proj', sessionId: 's1', offset: 20, loading: false, hasMore: false, total: 20 };
  SessionFiles.open = { path: 'routes/git.js', mode: 'diff', ctx: { path: 'routes/git.js', hash: 'abc' } };

  Sessions.captureSnapshot();

  const snap = Sessions._getSnapshot('proj', 's1');
  // _getSnapshot() round-trips through sessionStorage's JSON store, so the result is a plain
  // Node object — but SessionFiles.open.ctx above lives in the vm sandbox's separate realm, and
  // deepStrictEqual treats same-shape objects from different realms as unequal. Compare via JSON.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(snap.file)), { path: 'routes/git.js', mode: 'diff', ctx: { path: 'routes/git.js', hash: 'abc' } });
});

test('captureSnapshot records no file when none is open', () => {
  Sessions.detailState = { slug: 'proj', sessionId: 's1', offset: 20, loading: false, hasMore: false, total: 20 };
  SessionFiles.open = null;

  Sessions.captureSnapshot();

  assert.strictEqual(Sessions._getSnapshot('proj', 's1').file, null);
});

test('loadDetail with no prior snapshot starts on Files with one page loaded', async () => {
  harness.totalMessages = 45;
  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(Sessions._activeTab, 'file-changes');
  assert.strictEqual(Sessions.detailState.offset, 20);
  assert.strictEqual(Sessions._detailSearchQuery, '');
});

test('loadDetail restores the saved tab, message offset, search and scroll position', async () => {
  harness.totalMessages = 45;
  const map = { 'proj|s1': { tab: 'conversation', scrollTop: 321, offset: 40, searchQuery: 'msg2', ts: Date.now() } };
  harness.sessionStore[Sessions.SNAPSHOT_KEY] = JSON.stringify(map);

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(Sessions._activeTab, 'conversation');
  assert.strictEqual(Sessions.detailState.offset, 40, 'should have paged in messages up to the saved offset');
  assert.strictEqual(Sessions._detailSearchQuery, 'msg2');
  assert.strictEqual(harness.elementsById['session-messages-pane'].scrollTop, 321);
});

test('loadDetail reopens the file that was selected in the Files tab', async () => {
  harness.totalMessages = 45;
  const map = {
    'proj|s1': {
      tab: 'file-changes', scrollTop: 0, offset: 20, searchQuery: '',
      file: { path: 'routes/git.js', mode: 'diff', ctx: { path: 'routes/git.js', hash: 'abc' } },
      ts: Date.now()
    }
  };
  harness.sessionStore[Sessions.SNAPSHOT_KEY] = JSON.stringify(map);

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(harness.openFileCalls.length, 1);
  assert.strictEqual(harness.openFileCalls[0].path, 'routes/git.js');
  assert.strictEqual(harness.openFileCalls[0].opts.mode, 'diff');
  // ctx round-trips through the sandbox's JSON.parse (loadDetail runs inside the vm), so it's a
  // different-realm object from this literal — compare structurally via JSON instead.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.openFileCalls[0].opts.ctx)), { path: 'routes/git.js', hash: 'abc' });
  assert.strictEqual(SessionFiles.open.path, 'routes/git.js');
});

test('loadDetail does not reopen a file when the snapshot has none', async () => {
  harness.totalMessages = 45;
  const map = { 'proj|s1': { tab: 'file-changes', scrollTop: 0, offset: 20, searchQuery: '', file: null, ts: Date.now() } };
  harness.sessionStore[Sessions.SNAPSHOT_KEY] = JSON.stringify(map);

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(harness.openFileCalls.length, 0);
});

test('loadDetail does not over-fetch beyond a small saved offset', async () => {
  harness.totalMessages = 45;
  const map = { 'proj|s1': { tab: 'file-changes', scrollTop: 0, offset: 10, searchQuery: '', ts: Date.now() } };
  harness.sessionStore[Sessions.SNAPSHOT_KEY] = JSON.stringify(map);

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(Sessions.detailState.offset, 20, 'a single default page already covers a 10-message snapshot');
});

test('captureSnapshot evicts the oldest entry once the cap is exceeded', () => {
  for (let i = 0; i < Sessions.SNAPSHOT_MAX; i++) {
    Sessions.detailState = { slug: 'proj', sessionId: 's' + i, offset: 1, loading: false, hasMore: false, total: 1 };
    Sessions._activeTab = 'conversation';
    Sessions.captureSnapshot();
  }
  assert.strictEqual(Object.keys(Sessions._loadSnapshots()).length, Sessions.SNAPSHOT_MAX);

  Sessions.detailState = { slug: 'proj', sessionId: 'extra', offset: 1, loading: false, hasMore: false, total: 1 };
  Sessions.captureSnapshot();

  const keys = Object.keys(Sessions._loadSnapshots());
  assert.strictEqual(keys.length, Sessions.SNAPSHOT_MAX, 'the cap must not grow unbounded');
  assert.ok(!('proj|s0' in Sessions._loadSnapshots()), 'the oldest entry should have been evicted');
  assert.ok('proj|extra' in Sessions._loadSnapshots());
});

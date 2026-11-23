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
  resizeCalls: 0,
  widthCalls: 0,
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
  // A file "changed" so the Files tab has content to show.
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
  TerminalPanel: { isOpen: () => false, hasAttachedPty: () => false, shouldAutoOpen: () => false, open: () => {}, _sendResize: () => { harness.resizeCalls++; }, applySavedWidth: () => { harness.widthCalls++; } },
  ActiveSessionsBar: { _sessions: [], poll: () => {} },
  SessionColors: { applyToDetailHeader: () => {} },
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
  harness.resizeCalls = 0;
  harness.widthCalls = 0;
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
  const map = { 'proj|s1': { tab: 'activity', scrollTop: 321, offset: 40, searchQuery: 'msg2', ts: Date.now() } };
  harness.sessionStore[Sessions.SNAPSHOT_KEY] = JSON.stringify(map);

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(Sessions._activeTab, 'activity');
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
    Sessions._activeTab = 'activity';
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

// The Conversation moved out of the left tabs into the right pane, next to the Terminal.

function trackedEl() {
  const el = makeEl();
  const classes = new Set();
  el.classList = {
    toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
    add(c) { classes.add(c); },
    remove(c) { classes.delete(c); },
    contains: c => classes.has(c),
  };
  return el;
}

function rightPaneEls() {
  for (const id of ['right-tab-btn-conversation', 'right-tab-btn-terminal']) harness.elementsById[id] = trackedEl();
  return {
    msgs: harness.elementsById['session-messages-wrap'] = trackedEl(),
    term: harness.elementsById['terminal-pane'] = trackedEl(),
    cvBtn: harness.elementsById['right-tab-btn-conversation'],
    tmBtn: harness.elementsById['right-tab-btn-terminal'],
  };
}

test('switchRightTab shows the terminal, hides the conversation and refits xterm', () => {
  const el = rightPaneEls();

  Sessions.switchRightTab('terminal');

  assert.ok(el.msgs.classList.contains('right-tab-hidden'));
  assert.ok(!el.term.classList.contains('right-tab-hidden'));
  assert.ok(el.tmBtn.classList.contains('active'));
  assert.ok(!el.cvBtn.classList.contains('active'));
  assert.strictEqual(harness.resizeCalls, 1);
});

test('switchRightTab back to conversation hides the terminal', () => {
  const el = rightPaneEls();
  Sessions.switchRightTab('terminal');

  Sessions.switchRightTab('conversation');

  assert.ok(!el.msgs.classList.contains('right-tab-hidden'));
  assert.ok(el.term.classList.contains('right-tab-hidden'));
  assert.ok(el.cvBtn.classList.contains('active'));
  assert.ok(!el.tmBtn.classList.contains('active'));
});

test('loadDetail opens the right pane on Conversation even if Terminal was selected before', async () => {
  const el = rightPaneEls();
  Sessions.switchRightTab('terminal');

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(Sessions._activeRightTab, 'conversation');
  assert.ok(el.term.classList.contains('right-tab-hidden'));
  assert.ok(!el.msgs.classList.contains('right-tab-hidden'));
});

test('loadDetail for a read-only session also opens on Conversation', async () => {
  rightPaneEls();
  Sessions.switchRightTab('terminal');

  await Sessions.loadDetail('proj', 's1', {}, true);

  assert.strictEqual(Sessions._activeRightTab, 'conversation');
  assert.strictEqual(harness.widthCalls, 1, 'the right pane gets its saved width even without a terminal');
});

test('a saved Conversation tab from before the move opens Files on the left', async () => {
  const map = { 'proj|s1': { tab: 'conversation', scrollTop: 0, offset: 20, searchQuery: '', ts: Date.now() } };
  harness.sessionStore[Sessions.SNAPSHOT_KEY] = JSON.stringify(map);

  await Sessions.loadDetail('proj', 's1', {}, false);

  assert.strictEqual(Sessions._activeTab, 'file-changes');
});

test('loadDetail with no session id yet starts on Files and Conversation', async () => {
  rightPaneEls();
  Sessions._activeTab = 'activity';
  Sessions.switchRightTab('terminal');
  Sessions._startDiscovery = () => {};

  await Sessions.loadDetail('proj', null, {}, false);

  assert.strictEqual(Sessions._activeTab, 'file-changes');
  assert.strictEqual(Sessions._activeRightTab, 'conversation');
});

test('message polling keeps running while the left panel is collapsed', async () => {
  harness.localStore[Sessions.MAIN_PANEL_HIDDEN_KEY] = '1';

  await Sessions.loadDetail('proj', 's1', {}, false);
  assert.ok(Sessions._refreshTimer, 'conversation refresh should be scheduled');

  harness.apiCalls = [];
  await Sessions.pollNewMessages();
  assert.ok(harness.apiCalls.some(u => u.includes('/sessions/s1?offset=0')), 'poll should fetch new messages');
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load active-sessions-bar.js in a browser-like sandbox so closing a pill can be asserted
// without a browser: the bar, the cached session list, the dashboard and the session view
// must all stop treating the session as active.
const src = fs.readFileSync(path.join(__dirname, '../public/js/active-sessions-bar.js'), 'utf-8');

const SLUG = 'proj-a';
const SESSION_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const harness = {
  apiCalls: [],
  dots: [],
  navigations: [],
  removedDots: 0,
  terminalClosed: false,
  autoRefreshStopped: false,
  dashboardRendered: null,
};

function makeEl() {
  return {
    innerHTML: '',
    style: { display: '', cssText: '' },
    dataset: {},
    querySelectorAll: () => [],
    addEventListener() {},
    remove() {},
  };
}

const context = vm.createContext({
  document: {
    addEventListener: () => {},
    getElementById: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: sel => (sel.includes('.session-active-dot') ? harness.dots : []),
    createElement: () => makeEl(),
    body: { appendChild() {} },
  },
  window: { innerWidth: 1200, innerHeight: 800 },
  setInterval: () => 1,
  clearInterval: () => {},
  api: async url => { harness.apiCalls.push(url); return {}; },
  escapeHtml: s => String(s),
  decodeName: s => s,
  ActiveCount: { refresh: () => {} },
});
vm.runInContext(src + '\nglobalThis._ActiveSessionsBar = ActiveSessionsBar;', context);
const ActiveSessionsBar = context._ActiveSessionsBar;

function dot() {
  return { remove: () => { harness.removedDots++; } };
}

beforeEach(() => {
  harness.apiCalls = [];
  harness.dots = [dot()];
  harness.navigations = [];
  harness.removedDots = 0;
  harness.terminalClosed = false;
  harness.autoRefreshStopped = false;
  harness.dashboardRendered = null;

  ActiveSessionsBar._sessions = [
    { slug: SLUG, sessionId: SESSION_A, kind: 'os', title: 'A' },
    { slug: SLUG, sessionId: SESSION_B, kind: 'browser', title: 'B' },
  ];
  ActiveSessionsBar._lastSidebarKey = null;

  context.Sessions = {
    cache: {
      [SLUG]: [
        { sessionId: SESSION_A, active: true, activeKind: 'os' },
        { sessionId: SESSION_B, active: true, activeKind: 'browser' },
      ],
    },
    detailState: { slug: null, sessionId: null },
    stopAutoRefresh: () => { harness.autoRefreshStopped = true; },
  };
  context.App = {
    currentView: 'project-detail',
    navigate: (view, opts) => { harness.navigations.push({ view, opts }); },
  };
  context.TerminalPanel = {
    state: { slug: SLUG, sessionId: SESSION_A },
    isOpen: () => true,
    close: () => { harness.terminalClosed = true; },
  };
  context.Dashboard = {
    _sessions: [{ slug: SLUG, sessionId: SESSION_A, active: true, activeKind: 'os' }],
    _activeSessions: [{ slug: SLUG, sessionId: SESSION_A }, { slug: SLUG, sessionId: SESSION_B }],
    renderActiveSessions: list => { harness.dashboardRendered = list; },
  };
});

test('closing a pill deactivates on the server and drops it from the bar', async () => {
  await ActiveSessionsBar.close(SLUG, SESSION_A);
  assert.deepStrictEqual(harness.apiCalls, [`/api/projects/${SLUG}/sessions/${SESSION_A}/deactivate`]);
  assert.deepStrictEqual(ActiveSessionsBar._sessions.map(s => s.sessionId), [SESSION_B]);
});

test('closing a pill clears the cached active flags for that session only', async () => {
  await ActiveSessionsBar.close(SLUG, SESSION_A);
  const cached = context.Sessions.cache[SLUG];
  assert.strictEqual(cached[0].active, false);
  assert.strictEqual(cached[0].activeKind, null);
  assert.strictEqual(cached[1].active, true);
  assert.strictEqual(cached[1].activeKind, 'browser');
});

test('closing a pill strips rendered active dots for that session', async () => {
  harness.dots = [dot(), dot()];
  await ActiveSessionsBar.close(SLUG, SESSION_A);
  assert.strictEqual(harness.removedDots, 2);
});

test('closing a pill removes the session from the dashboard active list', async () => {
  await ActiveSessionsBar.close(SLUG, SESSION_A);
  assert.deepStrictEqual(harness.dashboardRendered.map(s => s.sessionId), [SESSION_B]);
  assert.strictEqual(context.Dashboard._sessions[0].active, false);
  assert.strictEqual(context.Dashboard._sessions[0].activeKind, null);
});

test('closing the session being viewed stops polling, closes the terminal and goes back to the list', async () => {
  context.App.currentView = 'session-detail';
  context.Sessions.detailState = { slug: SLUG, sessionId: SESSION_A };
  await ActiveSessionsBar.close(SLUG, SESSION_A);
  assert.strictEqual(harness.autoRefreshStopped, true);
  assert.strictEqual(harness.terminalClosed, true);
  assert.strictEqual(harness.navigations.length, 1);
  assert.strictEqual(harness.navigations[0].view, 'project-detail');
  assert.strictEqual(harness.navigations[0].opts.slug, SLUG);
});

test('closing another session while viewing one leaves the current view alone', async () => {
  context.App.currentView = 'session-detail';
  context.Sessions.detailState = { slug: SLUG, sessionId: SESSION_A };
  await ActiveSessionsBar.close(SLUG, SESSION_B);
  assert.strictEqual(harness.autoRefreshStopped, false);
  assert.strictEqual(harness.terminalClosed, false);
  assert.deepStrictEqual(harness.navigations, []);
});

test('a terminal attached to a different session is left open', async () => {
  context.App.currentView = 'session-detail';
  context.Sessions.detailState = { slug: SLUG, sessionId: SESSION_A };
  context.TerminalPanel.state = { slug: SLUG, sessionId: SESSION_B };
  await ActiveSessionsBar.close(SLUG, SESSION_A);
  assert.strictEqual(harness.terminalClosed, false);
  assert.strictEqual(harness.navigations.length, 1);
  assert.strictEqual(harness.navigations[0].view, 'project-detail');
});

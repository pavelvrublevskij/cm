const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load sessions.js in a sandbox to assert the session view's "Close session" button: shown only
// while the session runs, and closing it ends the session everywhere.
const src = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');

const harness = { els: {}, closed: [], closedReadonly: [], attached: false };

function el(id) {
  if (!harness.els[id]) harness.els[id] = { id, innerHTML: '', style: { display: 'none' }, dataset: {}, classList: { toggle() {}, remove() {} } };
  return harness.els[id];
}

const context = vm.createContext({
  localStorage: { getItem: () => null, setItem: () => {} },
  document: {
    addEventListener: () => {},
    getElementById: id => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  setInterval: () => 0,
  clearInterval: () => {},
  api: async () => ({}),
  escapeHtml: s => String(s),
  escapeAttr: s => String(s),
  debounce: fn => fn,
  toast: () => {},
  ActiveSessionsBar: {
    _sessions: [],
    close: async (slug, sessionId) => { harness.closed.push([slug, sessionId]); },
    closeReadonly: async (slug, sessionId, instanceId) => { harness.closedReadonly.push([slug, sessionId, instanceId]); },
  },
  TerminalPanel: { hasAttachedPty: () => harness.attached, isOpen: () => false, shouldAutoOpen: () => false },
  App: { navigate: () => {}, setHash: () => {} },
});
vm.runInContext(src + '\nglobalThis._Sessions = Sessions;', context);
const Sessions = context._Sessions;

const shown = () => [el('session-detail-close-btn').style.display, el('session-detail-close-menu').style.display];

beforeEach(() => {
  harness.els = {};
  harness.closed = [];
  harness.closedReadonly = [];
  harness.attached = false;
  context.ActiveSessionsBar._sessions = [];
  Sessions.detailState = { slug: 'proj', sessionId: 's1', readOnly: false, readOnlyInstanceId: null };
});

test('close button and menu item are hidden for a session that is not running', () => {
  Sessions.syncCloseButton();
  assert.deepStrictEqual(shown(), ['none', 'none']);
});

test('close button and menu item show while the session is listed as active', () => {
  context.ActiveSessionsBar._sessions = [{ slug: 'proj', sessionId: 's1' }];
  Sessions.syncCloseButton();
  assert.deepStrictEqual(shown(), ['', '']);
});

test('close button shows while a browser terminal is attached', () => {
  harness.attached = true;
  Sessions.syncCloseButton();
  assert.deepStrictEqual(shown(), ['', '']);
});

test('another active session does not show the close button', () => {
  context.ActiveSessionsBar._sessions = [{ slug: 'proj', sessionId: 'other' }];
  Sessions.syncCloseButton();
  assert.deepStrictEqual(shown(), ['none', 'none']);
});

test('closing ends the session through the active-sessions close', async () => {
  await Sessions.closeDetail();
  assert.deepStrictEqual(harness.closed, [['proj', 's1']]);
  assert.strictEqual(harness.closedReadonly.length, 0);
});

test('closing from a read-only view also drops this viewer instance', async () => {
  Sessions.detailState = { slug: 'proj', sessionId: 's1', readOnly: true, readOnlyInstanceId: 'i1' };
  await Sessions.closeDetail();
  assert.deepStrictEqual(harness.closedReadonly, [['proj', 's1', 'i1']]);
  assert.deepStrictEqual(harness.closed, [['proj', 's1']]);
});

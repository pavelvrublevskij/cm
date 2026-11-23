const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The right pane (Conversation / Terminal) is sized from the saved splitter position, and
// collapsing the left panel no longer pauses the conversation, which now lives in the right pane.
const src = fs.readFileSync(path.join(__dirname, '../public/js/terminal.js'), 'utf-8');

const harness = { store: {}, props: {}, classes: new Set(), stopCalls: 0 };

const body = {
  style: { setProperty: (k, v) => { harness.props[k] = v; } },
  classList: {
    toggle: (c, on) => { if (on) harness.classes.add(c); else harness.classes.delete(c); },
    contains: c => harness.classes.has(c),
  },
};

const context = vm.createContext({
  window: {},
  localStorage: {
    getItem: k => (k in harness.store ? harness.store[k] : null),
    setItem: (k, v) => { harness.store[k] = String(v); },
  },
  document: { getElementById: id => (id === 'session-detail-body' ? body : null) },
  createTerminalPanelUI: () => ({}),
  Sessions: {
    MAIN_PANEL_HIDDEN_KEY: 'main-hidden',
    applyMainPanelHiddenState() { body.classList.toggle('main-panel-hidden', harness.store['main-hidden'] === '1'); },
    stopConversationRefresh() { harness.stopCalls++; },
  },
});
vm.runInContext(src + '\nglobalThis._TerminalPanel = TerminalPanel;', context);
const TerminalPanel = context._TerminalPanel;

beforeEach(() => {
  harness.store = {};
  harness.props = {};
  harness.classes = new Set();
  harness.stopCalls = 0;
});

test('applySavedWidth uses the saved splitter width', () => {
  harness.store[TerminalPanel.WIDTH_KEY] = '60';
  TerminalPanel.applySavedWidth();
  assert.strictEqual(harness.props['--terminal-width'], '60%');
});

test('applySavedWidth falls back to the default width', () => {
  TerminalPanel.applySavedWidth();
  assert.strictEqual(harness.props['--terminal-width'], TerminalPanel.DEFAULT_WIDTH_PCT + '%');
});

test('collapsing the left panel hides it without pausing the conversation', () => {
  TerminalPanel._setMainPanelHidden(true);
  assert.strictEqual(harness.store['main-hidden'], '1');
  assert.ok(harness.classes.has('main-panel-hidden'));
  assert.strictEqual(harness.stopCalls, 0);
});

test('expanding the left panel shows it again', () => {
  TerminalPanel._setMainPanelHidden(true);
  TerminalPanel._setMainPanelHidden(false);
  assert.strictEqual(harness.store['main-hidden'], '0');
  assert.ok(!harness.classes.has('main-panel-hidden'));
});

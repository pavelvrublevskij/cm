const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'git-panel.js'), 'utf-8');
const store = {};
const context = vm.createContext({
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  escapeHtml: t => String(t),
  createTerminalPanelUI: () => ({}),
  window: {},
  document: { getElementById: () => null, querySelectorAll: () => [] }
});
vm.runInContext(src + '\nglobalThis._GitPanel = GitPanel;', context);
const GitPanel = context._GitPanel;

test('clampSplit keeps a side column above its minimum', () => {
  assert.strictEqual(GitPanel.clampSplit('left', 100, 1400, 260), GitPanel.SPLIT_MIN.left);
  assert.strictEqual(GitPanel.clampSplit('right', 50, 1400, 400), GitPanel.SPLIT_MIN.right);
});

test('clampSplit always leaves the middle column its minimum width', () => {
  const left = GitPanel.clampSplit('left', 2000, 1400, 260);
  assert.strictEqual(left, 1400 - 260 - GitPanel.SPLIT_MIDDLE_MIN - 24);
  assert.strictEqual(GitPanel.clampSplit('left', 500, 1400, 260), 500);
});

test('saved widths are restored as CSS variables; bad values are ignored', () => {
  delete store[GitPanel.SPLIT_KEY];
  assert.strictEqual(GitPanel._splitStyle(), '');
  store[GitPanel.SPLIT_KEY] = JSON.stringify({ left: 520.4, right: 300 });
  assert.strictEqual(GitPanel._splitStyle(), '--git-left: 520px;--git-right: 300px;');
  store[GitPanel.SPLIT_KEY] = JSON.stringify({ left: 10, right: 'wide' });
  assert.strictEqual(GitPanel._splitStyle(), '');
  store[GitPanel.SPLIT_KEY] = '{not json';
  assert.strictEqual(GitPanel._splitStyle(), '');
});

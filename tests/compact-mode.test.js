const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/compact-mode.js'), 'utf-8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf-8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf-8');

const KEY = 'claude-manager-compact-mode';
const store = new Map();
const appClasses = new Set();
const switchInput = { checked: false };

const context = vm.createContext({
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  document: {
    getElementById: id => (id === 'compact-mode-switch' ? switchInput : null),
    querySelector: sel => (sel === '.app'
      ? { classList: { add: c => appClasses.add(c), remove: c => appClasses.delete(c) } }
      : null),
  },
});
vm.runInContext(src + '\nthis.CompactMode = CompactMode;', context);
const { CompactMode } = context;

beforeEach(() => {
  store.clear();
  appClasses.clear();
  switchInput.checked = false;
  CompactMode.enabled = false;
});

test('init defaults to off when nothing is stored', () => {
  CompactMode.init();
  assert.strictEqual(CompactMode.enabled, false);
  assert.strictEqual(appClasses.has('compact-mode'), false);
  assert.strictEqual(switchInput.checked, false);
});

test('init restores stored on state', () => {
  store.set(KEY, '1');
  CompactMode.init();
  assert.strictEqual(CompactMode.enabled, true);
  assert.strictEqual(appClasses.has('compact-mode'), true);
  assert.strictEqual(switchInput.checked, true);
});

test('toggle on adds class and persists', () => {
  CompactMode.toggle();
  assert.strictEqual(appClasses.has('compact-mode'), true);
  assert.strictEqual(store.get(KEY), '1');
  assert.strictEqual(switchInput.checked, true);
});

test('toggle off removes class and persists', () => {
  store.set(KEY, '1');
  CompactMode.init();
  CompactMode.toggle();
  assert.strictEqual(appClasses.has('compact-mode'), false);
  assert.strictEqual(store.get(KEY), '0');
  assert.strictEqual(switchInput.checked, false);
});

test('only Claude Code and CM sections are hidden in compact mode', () => {
  const optional = [...html.matchAll(/class="nav-section nav-section-optional">\s*<div class="nav-section-title"><span class="nav-label">([^<]+)</g)]
    .map(m => m[1]);
  assert.deepStrictEqual(optional, ['Claude Code', 'CM']);
  assert.match(css, /\.app\.compact-mode \.nav-section-optional\s*\{\s*display:\s*none;/);
});

test('sidebar has the compact mode switch', () => {
  assert.match(html, /<div class="sidebar-footer">[\s\S]*id="compact-mode-switch"[\s\S]*CompactMode\.toggle\(\)/);
  assert.match(html, /<script src="\/js\/compact-mode\.js"><\/script>/);
});

test('compact switch keeps its label when sidebar is collapsed', () => {
  assert.match(css, /\.app\.sidebar-collapsed \.compact-switch\s*\{[^}]*flex-direction:\s*column;/);
  assert.match(css, /\.app\.sidebar-collapsed \.compact-switch \.nav-label\s*\{[^}]*display:\s*inline;/);
});

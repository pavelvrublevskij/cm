const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/sidebar-resize.js'), 'utf-8');

const KEY = 'claude-manager-sidebar-width';
const store = new Map();
const rootStyle = new Map();
const appClasses = new Set();
const listeners = {};

let sidebarWidth = 220;

const context = vm.createContext({
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  document: {
    documentElement: { style: { setProperty: (k, v) => rootStyle.set(k, v) } },
    getElementById: id => (id === 'sidebar-toggle' ? { addEventListener: (ev, fn) => (listeners['handle:' + ev] = fn) } : null),
    querySelector: sel => {
      if (sel === '.app') {
        return {
          classList: {
            add: c => appClasses.add(c),
            remove: c => appClasses.delete(c),
            contains: c => appClasses.has(c),
          },
        };
      }
      if (sel === '.sidebar') return { offsetWidth: sidebarWidth };
      return null;
    },
    addEventListener: (ev, fn) => (listeners['doc:' + ev] = fn),
  },
});
vm.runInContext(src + '\nglobalThis._SidebarResize = SidebarResize;', context);
const SidebarResize = context._SidebarResize;

beforeEach(() => {
  store.clear();
  rootStyle.clear();
  appClasses.clear();
  sidebarWidth = 220;
  SidebarResize.width = 220;
  SidebarResize.dragged = false;
  SidebarResize.drag = null;
});

test('clamps to the collapsed-nav minimum and the maximum', () => {
  assert.strictEqual(SidebarResize.clamp(100), 220);
  assert.strictEqual(SidebarResize.clamp(220), 220);
  assert.strictEqual(SidebarResize.clamp(320), 320);
  assert.strictEqual(SidebarResize.clamp(9999), 480);
});

test('dragging right widens the sidebar and persists the width', () => {
  SidebarResize.init();
  SidebarResize.start({ clientX: 220, preventDefault() {} });
  SidebarResize.move({ clientX: 340 });
  assert.strictEqual(rootStyle.get('--sidebar-width'), '340px');
  assert.ok(appClasses.has('sidebar-resizing'));
  SidebarResize.end();
  assert.strictEqual(store.get(KEY), '340');
  assert.strictEqual(appClasses.has('sidebar-resizing'), false);
});

test('dragging left never goes below the minimum width', () => {
  SidebarResize.start({ clientX: 220, preventDefault() {} });
  SidebarResize.move({ clientX: 20 });
  SidebarResize.end();
  assert.strictEqual(rootStyle.get('--sidebar-width'), '220px');
  assert.strictEqual(store.get(KEY), '220');
});

test('a click without movement is not treated as a drag', () => {
  SidebarResize.start({ clientX: 220, preventDefault() {} });
  SidebarResize.move({ clientX: 222 });
  SidebarResize.end();
  assert.strictEqual(SidebarResize.dragged, false);
  assert.strictEqual(store.has(KEY), false);
  assert.strictEqual(rootStyle.has('--sidebar-width'), false);
});

test('a real drag swallows the toggle click exactly once', () => {
  SidebarResize.start({ clientX: 220, preventDefault() {} });
  SidebarResize.move({ clientX: 300 });
  SidebarResize.end();
  assert.strictEqual(SidebarResize.consumeDrag(), true);
  assert.strictEqual(SidebarResize.consumeDrag(), false);
});

test('no resize while the sidebar is collapsed', () => {
  appClasses.add('sidebar-collapsed');
  SidebarResize.start({ clientX: 220, preventDefault() {} });
  assert.strictEqual(SidebarResize.drag, null);
  SidebarResize.move({ clientX: 400 });
  assert.strictEqual(rootStyle.has('--sidebar-width'), false);
});

test('init restores the saved width', () => {
  store.set(KEY, '400');
  SidebarResize.init();
  assert.strictEqual(rootStyle.get('--sidebar-width'), '400px');
});

test('a new drag starts from the current rendered width', () => {
  sidebarWidth = 400;
  SidebarResize.start({ clientX: 400, preventDefault() {} });
  SidebarResize.move({ clientX: 450 });
  assert.strictEqual(rootStyle.get('--sidebar-width'), '450px');
});

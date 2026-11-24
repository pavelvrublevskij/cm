const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// toggleActionMenu opens the panel with fixed positioning anchored to the button,
// flipping above it when there is no room below, keeping CSS left/right alignment,
// and closing only on scrolls that move the button (or on resize).
const src = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');
const listeners = {};

// Minimal tree node: contains() walks the parent chain.
function node(parent) {
  return { parent, contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; } };
}

// cssRect: the panel's rect under its CSS (absolute) layout, used to detect alignment.
function makePanel(height, cssRect, parent) {
  const classes = new Set();
  const p = node(parent);
  Object.assign(p, {
    style: {},
    offsetHeight: height,
    getBoundingClientRect: () => cssRect,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
    },
  });
  return p;
}

const panels = [];
const doc = {
  addEventListener: () => {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: sel => (sel.startsWith('.action-menu-panel.open') ? panels.filter(p => p.classList.contains('open')) : []),
};
const context = vm.createContext({
  window: { innerWidth: 1000, innerHeight: 800, addEventListener: (t, fn) => { listeners[t] = fn; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: doc,
  setInterval: () => 0,
  clearInterval: () => {},
  debounce: fn => fn,
});
vm.runInContext(src + '\nglobalThis._Sessions = Sessions;', context);
const Sessions = context._Sessions;

// Right-aligned panel under a button at [left,right]
function setup({ top, bottom, left = 850, right = 900, height = 100, leftAligned = false, parent } = {}) {
  const menu = node(parent);
  const w = 140;
  const cssRect = leftAligned ? { left, right: left + w } : { left: right - w, right };
  const panel = makePanel(height, cssRect, menu);
  panels.push(panel);
  const btn = Object.assign(node(menu), { getBoundingClientRect: () => ({ top, bottom, left, right }), nextElementSibling: panel });
  return { panel, btn, menu };
}

test('opens below the button, right-aligned, with fixed positioning', () => {
  const { panel, btn } = setup({ top: 100, bottom: 120 });
  Sessions.toggleActionMenu(btn);
  assert.ok(panel.classList.contains('open'));
  assert.ok(panel.classList.contains('fixed'));
  assert.strictEqual(panel.style.top, '124px');
  assert.strictEqual(panel.style.right, '100px');
  assert.strictEqual(panel.style.left, 'auto');
});

test('keeps left alignment for panels styled left: 0 (e.g. .tb-wf-saved)', () => {
  const { panel, btn } = setup({ top: 100, bottom: 120, left: 40, right: 90, leftAligned: true });
  Sessions.toggleActionMenu(btn);
  assert.strictEqual(panel.style.left, '40px');
  assert.strictEqual(panel.style.right, 'auto');
});

test('flips above the button when there is no room below', () => {
  const { panel, btn } = setup({ top: 700, bottom: 720, height: 200 });
  Sessions.toggleActionMenu(btn);
  assert.strictEqual(panel.style.top, '496px');
});

test('second click closes the panel', () => {
  const { panel, btn } = setup({ top: 10, bottom: 30 });
  Sessions.toggleActionMenu(btn);
  Sessions.toggleActionMenu(btn);
  assert.ok(!panel.classList.contains('open'));
});

test('scroll of an unrelated element (e.g. terminal viewport) keeps the panel open', () => {
  const { panel, btn } = setup({ top: 10, bottom: 30 });
  Sessions.toggleActionMenu(btn);
  listeners.scroll({ target: node(null) });
  assert.ok(panel.classList.contains('open'));
});

test('scroll inside the panel keeps it open', () => {
  const { panel, btn } = setup({ top: 10, bottom: 30 });
  Sessions.toggleActionMenu(btn);
  listeners.scroll({ target: node(panel) });
  assert.ok(panel.classList.contains('open'));
});

test('scroll of an ancestor of the button closes the panel', () => {
  const scroller = node(null);
  const { panel, btn } = setup({ top: 10, bottom: 30, parent: scroller });
  Sessions.toggleActionMenu(btn);
  listeners.scroll({ target: scroller });
  assert.ok(!panel.classList.contains('open'));
});

test('document scroll and resize close the panel', () => {
  const { panel, btn } = setup({ top: 10, bottom: 30 });
  Sessions.toggleActionMenu(btn);
  listeners.scroll({ target: doc });
  assert.ok(!panel.classList.contains('open'));
  Sessions.toggleActionMenu(btn);
  listeners.resize({});
  assert.ok(!panel.classList.contains('open'));
});

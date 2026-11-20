const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// openModal's maximizable option: a title-bar button toggles the modal fullscreen and back.
const src = fs.readFileSync(path.join(__dirname, '../public/js/modal.js'), 'utf-8');

function makeEl(tag) {
  const set = new Set();
  return {
    tag,
    children: [],
    className: '',
    style: {},
    textContent: '',
    title: '',
    classList: {
      contains: c => set.has(c),
      toggle(c) { if (set.has(c)) set.delete(c); else set.add(c); return set.has(c); },
    },
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    remove() { this.removed = true; },
  };
}

function load() {
  const ctx = { document: { createElement: makeEl, body: makeEl('body') } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const find = (el, cls) => el.className.split(' ').includes(cls)
  ? el
  : el.children.map(c => find(c, cls)).find(Boolean);

test('maximizable modal toggles fullscreen from its title-bar button', () => {
  const ctx = load();
  const overlay = ctx.openModal({ title: 'Workflow', body: '', maximizable: true });
  const modal = overlay.children[0];
  const btn = find(modal, 'modal-maximize');
  assert.ok(btn);
  assert.strictEqual(btn.title, 'Maximize');

  btn.onclick();
  assert.ok(modal.classList.contains('modal--fullscreen'));
  assert.strictEqual(btn.title, 'Restore');

  btn.onclick();
  assert.ok(!modal.classList.contains('modal--fullscreen'));
  assert.strictEqual(btn.title, 'Maximize');
});

test('modal without maximizable has no fullscreen button', () => {
  const ctx = load();
  const overlay = ctx.openModal({ title: 'Plain', body: '' });
  assert.strictEqual(find(overlay.children[0], 'modal-maximize'), undefined);
});

test('clicking outside the modal does not close it', () => {
  const ctx = load();
  let closed = false;
  const overlay = ctx.openModal({ title: 'Plain', body: '', onClose: () => { closed = true; } });
  for (const fn of overlay.listeners.click || []) fn({ target: overlay });
  assert.ok(!overlay.removed);
  assert.ok(!closed);
});

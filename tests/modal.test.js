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
  const ctx = { document: { createElement: makeEl, createTextNode: t => ({ text: t }), body: makeEl('body') } };
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

test('every modal has a close icon that dismisses it and calls onClose', () => {
  const ctx = load();
  let closed = false;
  const overlay = ctx.openModal({ title: 'Plain', body: '', onClose: () => { closed = true; } });
  const btn = find(overlay.children[0], 'modal-close');
  assert.ok(btn);
  assert.strictEqual(btn.title, 'Close');

  btn.onclick();
  assert.ok(overlay.removed);
  assert.ok(closed);
});

test('maximizable modal shows the close icon after the maximize button', () => {
  const ctx = load();
  const overlay = ctx.openModal({ title: 'Workflow', body: '', maximizable: true });
  const actions = find(overlay.children[0], 'modal-header-actions');
  assert.deepStrictEqual(actions.children.map(c => c.className), ['btn btn-sm modal-maximize', 'modal-close']);
});

test('headerHtml goes into the title bar before the maximize and close buttons', () => {
  const ctx = load();
  const overlay = ctx.openModal({ title: 'Workflow', body: '', maximizable: true, headerHtml: '<span>?</span>' });
  const actions = find(overlay.children[0], 'modal-header-actions');
  assert.deepStrictEqual(actions.children.map(c => c.className), ['modal-header-extra', 'btn btn-sm modal-maximize', 'modal-close']);
  assert.strictEqual(actions.children[0].innerHTML, '<span>?</span>');
});

test('clicking outside the modal does not close it', () => {
  const ctx = load();
  let closed = false;
  const overlay = ctx.openModal({ title: 'Plain', body: '', onClose: () => { closed = true; } });
  for (const fn of overlay.listeners.click || []) fn({ target: overlay });
  assert.ok(!overlay.removed);
  assert.ok(!closed);
});

// A busyLabel button disables the dialog's buttons and shows a spinner while its onClick runs.
function busyModal(ctx, onClick, extra = {}) {
  const overlay = ctx.openModal({ title: 'Delete', body: '', buttons: [{ label: 'Delete', danger: true, onClick, ...extra }] });
  const group = find(overlay.children[0], 'btn-group');
  return { overlay, group, cancel: group.children[0], btn: group.children[1], close: find(overlay.children[0], 'modal-close') };
}

test('busyLabel button locks the dialog with a spinner until onClick finishes, then closes', async () => {
  const ctx = load();
  let resolve;
  const { overlay, btn, cancel, close } = busyModal(ctx, () => new Promise(r => { resolve = r; }), { busyLabel: 'Deleting…' });
  const done = btn.onclick();
  assert.ok(btn.disabled && cancel.disabled && close.disabled);
  assert.strictEqual(btn.children[0].className, 'btn-spinner');
  assert.strictEqual(btn.children[1].text, 'Deleting…');
  assert.ok(!overlay.removed);
  resolve();
  await done;
  assert.ok(overlay.removed);
});

test('busyLabel button restores the buttons when onClick returns false', async () => {
  const ctx = load();
  const { overlay, btn, cancel, close } = busyModal(ctx, async () => false, { busyLabel: 'Deleting…' });
  await btn.onclick();
  assert.ok(!overlay.removed);
  assert.ok(!btn.disabled && !cancel.disabled && !close.disabled);
  assert.strictEqual(btn.textContent, 'Delete');
});

test('button without busyLabel does not lock the dialog', async () => {
  const ctx = load();
  let resolve;
  const { btn, cancel } = busyModal(ctx, () => new Promise(r => { resolve = r; }));
  const done = btn.onclick();
  assert.ok(!btn.disabled && !cancel.disabled);
  assert.strictEqual(btn.textContent, 'Delete');
  resolve();
  await done;
});

test('busyLabel button restores the buttons when onClick throws', async () => {
  const ctx = load();
  const { overlay, btn, cancel, close } = busyModal(ctx, async () => { throw new Error('boom'); }, { busyLabel: 'Deleting…' });
  await assert.rejects(btn.onclick(), /boom/);
  assert.ok(!overlay.removed);
  assert.ok(!btn.disabled && !cancel.disabled && !close.disabled);
  assert.strictEqual(btn.textContent, 'Delete');
});

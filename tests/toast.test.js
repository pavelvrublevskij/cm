const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/utils.js'), 'utf-8');

function setup() {
  const timers = [];
  const container = { children: [], appendChild(el) { this.children.push(el); } };
  const createElement = () => {
    const el = {
      classes: [], listeners: {}, removed: false,
      classList: { add: c => el.classes.push(c) },
      addEventListener: (ev, fn) => { el.listeners[ev] = fn; },
      remove: () => { el.removed = true; }
    };
    return el;
  };
  const sandbox = {
    document: { createElement, documentElement: { setAttribute: () => {} }, getElementById: () => container },
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => timers.push({ fn, ms })
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { toast: sandbox.toast, container, timers };
}

test('a toast closes after 3s by default and is not clickable', () => {
  const { toast, container, timers } = setup();
  toast('Saved');
  const el = container.children[0];
  assert.strictEqual(el.className, 'toast toast-success');
  assert.strictEqual(el.classes.length, 0);
  assert.strictEqual(el.listeners.click, undefined);
  assert.strictEqual(timers[0].ms, 3000);
  timers[0].fn();
  assert.ok(el.removed);
});

test('a toast with a duration and onClick stays that long and a click runs it and closes the toast', () => {
  const { toast, container, timers } = setup();
  let clicked = 0;
  toast('Needs input', 'warning', { duration: 15000, onClick: () => clicked++ });
  const el = container.children[0];
  assert.deepStrictEqual(el.classes, ['toast--clickable']);
  assert.strictEqual(timers[0].ms, 15000);
  el.listeners.click();
  assert.strictEqual(clicked, 1);
  assert.ok(el.removed);
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The tour must appear once per minor version. Persisting the seen version only on
// Skip/Done meant a reload (e.g. after a server restart) mid-tour left nothing stored,
// so the tour came back on every load.
const src = fs.readFileSync(path.join(__dirname, '../public/js/tour.js'), 'utf-8');

const KEY = 'claude-manager-tour-minor';
const store = new Map();

function makeEl() {
  return {
    id: '',
    className: '',
    innerHTML: '',
    style: {},
    offsetWidth: 0,
    classList: { add() {}, remove() {} },
    remove() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

const context = vm.createContext({
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
  document: {
    getElementById: () => makeEl(),
    querySelector: () => null,
    createElement: () => makeEl(),
    body: { appendChild() {} },
  },
  window: { innerWidth: 1200, innerHeight: 800 },
  requestAnimationFrame: cb => cb(),
});
vm.runInContext(src + '\nglobalThis._Tour = Tour;', context);
const Tour = context._Tour;

beforeEach(() => {
  store.clear();
  Tour.active = false;
  Tour._minor = null;
});

test('shows the tour when nothing is stored', () => {
  assert.equal(Tour.shouldShow(5), true);
});

test('start persists the minor version immediately', () => {
  Tour.start(5);
  assert.equal(store.get(KEY), '5');
  assert.equal(Tour.shouldShow(5), false);
});

test('a reload mid-tour does not re-trigger the tour', () => {
  Tour.start(5);
  Tour.next();          // user is mid-tour
  Tour.active = false;  // page reloads, module state is lost
  assert.equal(Tour.shouldShow(5), false);
});

test('skip still records the version', () => {
  Tour.start(5);
  store.clear();
  Tour.skip();
  assert.equal(store.get(KEY), '5');
});

test('walking to the last step and clicking Done records the version', () => {
  Tour.start(5);
  store.clear();
  for (let i = 0; i < Tour.steps.length; i++) Tour.next();
  assert.equal(store.get(KEY), '5');
  assert.equal(Tour.active, false);
});

test('a new minor version re-triggers the tour', () => {
  Tour.start(5);
  assert.equal(Tour.shouldShow(5), false);
  assert.equal(Tour.shouldShow(6), true);
});

test('an older minor version does not re-trigger the tour', () => {
  Tour.start(6);
  assert.equal(Tour.shouldShow(5), false);
});

test('a corrupt stored value is treated as never seen', () => {
  store.set(KEY, 'not-a-number');
  assert.equal(Tour.shouldShow(5), true);
});

test('an unparseable version never shows the tour and stores nothing', () => {
  assert.equal(Tour.shouldShow(NaN), false);
  Tour.markSeen(NaN);
  assert.equal(store.has(KEY), false);
});

test('reset clears the stored version', () => {
  Tour.start(5);
  Tour.reset();
  assert.equal(store.has(KEY), false);
  assert.equal(Tour.shouldShow(5), true);
});

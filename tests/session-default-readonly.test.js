const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The "open sessions read-only by default" setting: a localStorage-backed toggle (off by default)
// that Sessions.open/openGroupedSession must consult instead of always opening interactively.

const utilsSrc = fs.readFileSync(path.join(__dirname, '../public/js/utils.js'), 'utf-8');
const sessionsSrc = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');

let Sessions;
let navCalls;

function load() {
  const store = {};
  navCalls = [];
  const sandbox = {
    document: {
      createElement: () => ({}),
      documentElement: { setAttribute: () => {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    window: {},
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(utilsSrc, sandbox);
  vm.runInContext(sessionsSrc + '\nglobalThis._Sessions = Sessions;', sandbox);
  sandbox.App = { navigate: (view, opts) => navCalls.push({ view, opts }) };
  return sandbox._Sessions;
}

beforeEach(() => {
  Sessions = load();
  Sessions.cache = {};
  Sessions._searchResults = {};
});

test('defaultReadOnly() is off by default', () => {
  assert.strictEqual(Sessions.defaultReadOnly(), false);
});

test('setDefaultReadOnly(true) turns the default on', () => {
  Sessions.setDefaultReadOnly(true);
  assert.strictEqual(Sessions.defaultReadOnly(), true);
});

test('setDefaultReadOnly(false) turns the default back off', () => {
  Sessions.setDefaultReadOnly(true);
  Sessions.setDefaultReadOnly(false);
  assert.strictEqual(Sessions.defaultReadOnly(), false);
});

test('open() opens interactively while the default is off', () => {
  Sessions.cache['proj'] = [{ slug: 'proj', sessionId: 's1' }];
  Sessions.open('proj', 's1', 0);
  assert.strictEqual(navCalls[0].opts.readOnly, false);
});

test('open() opens read-only once the default is turned on', () => {
  Sessions.setDefaultReadOnly(true);
  Sessions.cache['proj'] = [{ slug: 'proj', sessionId: 's1' }];
  Sessions.open('proj', 's1', 0);
  assert.strictEqual(navCalls[0].opts.readOnly, true);
});

test('openGroupedSession() also respects the default', () => {
  Sessions.setDefaultReadOnly(true);
  Sessions.cache['proj'] = [{ slug: 'proj', sessionId: 's1' }];
  Sessions.openGroupedSession('proj', 's1');
  assert.strictEqual(navCalls[0].opts.readOnly, true);
});

test('openReadOnly() always opens read-only regardless of the default', () => {
  Sessions.cache['proj'] = [{ slug: 'proj', sessionId: 's1' }];
  Sessions.openReadOnly('proj', 's1');
  assert.strictEqual(navCalls[0].opts.readOnly, true);
});

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Conversation refresh interval: 3s by default, user value from localStorage wins.

const utilsSrc = fs.readFileSync(path.join(__dirname, '../public/js/utils.js'), 'utf-8');
const sessionsSrc = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');
const gitWindowSrc = fs.readFileSync(path.join(__dirname, '../public/js/git-window.js'), 'utf-8');

function load(src, name, store = {}) {
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
  vm.runInContext(src + `\nglobalThis._M = ${name};`, sandbox);
  return sandbox._M;
}

test('conversation refresh defaults to 3 seconds', () => {
  assert.strictEqual(load(sessionsSrc, 'Sessions').refreshIntervalMs(), 3000);
});

test('git window refresh defaults to 3 seconds', () => {
  assert.strictEqual(load(gitWindowSrc, 'GitWindow').refreshIntervalMs(), 3000);
});

test('stored refresh interval overrides the default', () => {
  const store = { 'claude-manager-conversation-refresh-ms': '7000' };
  assert.strictEqual(load(sessionsSrc, 'Sessions', store).refreshIntervalMs(), 7000);
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The session header's worktree line (Sessions.renderWorktreeInfo) in a browser-like sandbox.
const read = name => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf-8');

const harness = { el: null, pending: [] };

function makeEl() {
  return { innerHTML: '', style: {}, dataset: {} };
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const context = vm.createContext({
  localStorage: { getItem: () => null, setItem: () => {} },
  document: {
    addEventListener: () => {},
    getElementById: id => (id === 'session-worktree-info' ? harness.el : null),
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  setInterval: () => 1,
  clearInterval: () => {},
  // Every request waits until the test answers it, so their order can be chosen.
  api: url => new Promise(resolve => harness.pending.push({ url, resolve })),
  escapeHtml,
  escapeAttr: escapeHtml,
  debounce: fn => fn,
  toast: () => {},
  decodeName: s => s,
});
vm.runInContext(read('worktree-changes.js') + '\n' + read('sessions.js') + '\nglobalThis._Sessions = Sessions;', context);
const Sessions = context._Sessions;

const SLUG = 'C--p--claude-worktrees-cm-1';
const DIRTY = { worktree: true, name: 'cm-1', branch: 'worktree-cm-1', base: 'main', files: [{ path: 'a.txt', label: 'modified' }], unmerged: [], unmergedCount: 0 };
const CLEAN = { ...DIRTY, files: [] };
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  harness.el = makeEl();
  harness.pending = [];
  Sessions.detailState = { slug: SLUG, sessionId: 's1' };
});

test('a worktree session shows the worktree, its branch and its changes', async () => {
  const done = Sessions.renderWorktreeInfo(SLUG, 's1');
  assert.strictEqual(harness.pending[0].url, `/api/projects/${SLUG}/git/worktree`);
  harness.pending[0].resolve(DIRTY);
  await done;
  assert.strictEqual(harness.el.style.display, 'flex');
  assert.match(harness.el.innerHTML, /Worktree:<\/span> <code>cm-1<\/code> on <code>worktree-cm-1<\/code>/);
  assert.match(harness.el.innerHTML, /1 uncommitted/);
});

test('a session outside a worktree shows no line', async () => {
  const done = Sessions.renderWorktreeInfo(SLUG, 's1');
  harness.pending[0].resolve({ worktree: false });
  await done;
  assert.strictEqual(harness.el.style.display, 'none');
  assert.strictEqual(harness.el.innerHTML, '');
});

test('switching sessions hides the old line at once, and a late answer for the old session is dropped', async () => {
  const first = Sessions.renderWorktreeInfo(SLUG, 's1');
  harness.pending[0].resolve(DIRTY);
  await first;
  Sessions.detailState = { slug: SLUG, sessionId: 's2' };
  const second = Sessions.renderWorktreeInfo(SLUG, 's2');
  assert.strictEqual(harness.el.style.display, 'none', 'hidden while the new session loads');
  Sessions.detailState = { slug: SLUG, sessionId: 's3' };
  harness.pending[1].resolve(DIRTY);
  await second;
  assert.strictEqual(harness.el.style.display, 'none', 'no longer the open session');
});

test('an older answer that arrives last never overwrites a newer one', async () => {
  const older = Sessions.renderWorktreeInfo(SLUG, 's1');
  const newer = Sessions.renderWorktreeInfo(SLUG, 's1');
  harness.pending[1].resolve(CLEAN);
  await newer;
  harness.pending[0].resolve(DIRTY);
  await older;
  await flush();
  assert.match(harness.el.innerHTML, /all merged into main/);
  assert.ok(!harness.el.innerHTML.includes('uncommitted'));
});

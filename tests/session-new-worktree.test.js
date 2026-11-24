const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// A new session started for a worktree under <project>/.claude/worktrees/ (a Task Board ticket's)
// starts in the parent project, whichever "New session" button started it.
const src = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');

const harness = { calls: [], navigations: [] };

const context = vm.createContext({
  localStorage: { getItem: () => null, setItem: () => {} },
  document: {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  setInterval: () => 0,
  clearInterval: () => {},
  api: async (url, opts) => { harness.calls.push([url, opts && opts.method]); return []; },
  escapeHtml: s => String(s),
  escapeAttr: s => String(s),
  debounce: fn => fn,
  toast: () => {},
  TerminalPanel: { setAutoOpen: () => {}, isOpen: () => false, shouldAutoOpen: () => false },
  App: { navigate: (view, params) => { harness.navigations.push([view, params.slug]); }, setHash: () => {} },
});
vm.runInContext(src + '\nglobalThis._Sessions = Sessions;', context);
const Sessions = context._Sessions;
Sessions.checkPricing = async () => {};

beforeEach(() => {
  harness.calls = [];
  harness.navigations = [];
});

test('a worktree under .claude/worktrees maps to its project', () => {
  assert.strictEqual(Sessions._newSessionSlug('C--code-bosh--claude-worktrees-cm-361800a5'), 'C--code-bosh');
  assert.strictEqual(Sessions._newSessionSlug('-home-u-app--claude-worktrees-cm-1'), '-home-u-app');
});

test('a worktree of a subfolder project (not grouped with it) maps to that subfolder', () => {
  assert.strictEqual(Sessions._newSessionSlug('C--code-mono-app--claude-worktrees-cm-1234abcd'), 'C--code-mono-app');
});

test('a worktree inside another worktree maps to the top project', () => {
  assert.strictEqual(Sessions._newSessionSlug('C--code-bosh--claude-worktrees-a--claude-worktrees-b'), 'C--code-bosh');
});

test('a normal project and a nested non-worktree project stay unchanged', () => {
  assert.strictEqual(Sessions._newSessionSlug('C--code-bosh'), 'C--code-bosh');
  assert.strictEqual(Sessions._newSessionSlug('C--code-bosh-linked'), 'C--code-bosh-linked');
});

test('a new browser session for a worktree starts in the parent project', async () => {
  await Sessions.newSessionBrowser('C--code-bosh--claude-worktrees-cm-361800a5');
  assert.deepStrictEqual(harness.navigations, [['session-detail', 'C--code-bosh']]);
  assert.deepStrictEqual(harness.calls.map(c => c[0]), ['/api/projects/C--code-bosh/sessions']);
});

test('a new OS terminal session for a worktree starts in the parent project', async () => {
  await Sessions.newSessionOS('C--code-bosh--claude-worktrees-cm-361800a5');
  assert.deepStrictEqual(harness.calls, [['/api/projects/C--code-bosh/sessions/new', 'POST']]);
});

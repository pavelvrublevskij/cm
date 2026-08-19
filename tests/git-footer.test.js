const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The footer git button is the one control present in both the project and the session view, so it
// is where the git UI is reached from: one click, no dropdown — in the project view it switches to
// the Git tab, anywhere else it opens the same GitPanel in a modal. Commit and push live in the
// panel only, so the footer never offers a second copy of them. The button also carries the upstream
// divergence and a dot for a running shell.
const src = fs.readFileSync(path.join(__dirname, '../public/js/git-api.js'), 'utf-8')
  + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/git.js'), 'utf-8');

const harness = {
  els: {},
  toasts: [],
  apiHandler: null,
  modals: [],
  mounts: [],
  unmounts: 0,
  switched: [],
  currentView: 'project-detail',
};

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

const context = vm.createContext({
  document: {
    getElementById: id => el(id),
    querySelectorAll: () => [],
  },
  window: {},
  setTimeout: fn => fn(),
  escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;'),
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  formGroup: (label, html) => html,
  openModal: opts => { harness.modals.push(opts); return { remove() {} }; },
  api: async (url, opts) => {
    if (harness.apiHandler) return harness.apiHandler(url, opts);
    if (url.includes('terminal/info')) return { available: true, running: harness.shellRunning === true };
    return { available: true, branch: 'feature/x', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, files: [] };
  },
  get App() { return { currentView: harness.currentView, currentProject: 'proj' }; },
  ProjectTabs: { switch: (tab, btn) => { harness.switched.push({ tab, btn: btn && btn.id }); } },
  GitPanel: {
    mount: (hostId, slug) => { harness.mounts.push({ hostId, slug }); },
    unmount: () => { harness.unmounts++; },
    refreshIfMounted: async () => { harness.panelRefreshes++; },
  },
});
vm.runInContext(src + '\nglobalThis._GitActions = GitActions;', context);
const GitActions = context._GitActions;

beforeEach(() => {
  harness.els = {};
  harness.toasts = [];
  harness.apiHandler = null;
  harness.modals = [];
  harness.mounts = [];
  harness.unmounts = 0;
  harness.switched = [];
  harness.panelRefreshes = 0;
  harness.currentView = 'project-detail';
  harness.shellRunning = false;
  GitActions._slug = 'proj';
  GitActions._info = null;
  GitActions._shellRunning = false;
});

// ── footer button ────────────────────────────────────────────────────────────

test('init renders the branch and reveals the Git tab', async () => {
  await GitActions.init('proj');
  assert.match(el('footer-git').innerHTML, /feature\/x/);
  assert.strictEqual(el('git-tab-btn').style.display, '');
  assert.strictEqual(el('footer-git').style.display, 'flex');
});

test('a non-repo project hides the footer button and the Git tab', async () => {
  harness.apiHandler = () => ({ available: false });
  await GitActions.init('proj');
  assert.strictEqual(el('footer-git').innerHTML, '');
  assert.strictEqual(el('footer-git').style.display, 'none');
  assert.strictEqual(el('git-tab-btn').style.display, 'none');
});

test('divergence renders as arrows, in sync renders none', async () => {
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: true, running: false }
    : { available: true, branch: 'b', ahead: 2, behind: 3, upstream: 'origin/b', files: [] });
  await GitActions.init('proj');
  const html = el('footer-git').innerHTML;
  assert.match(html, /↑2/);
  assert.match(html, /↓3/);
  assert.match(html, /2 ahead \/ 3 behind origin\/b/);

  harness.apiHandler = null;
  await GitActions.refresh();
  assert.ok(!el('footer-git').innerHTML.includes('↑'), 'nothing to show when in sync');
});

test('a running shell shows a dot on the footer button', async () => {
  harness.shellRunning = true;
  await GitActions.init('proj');
  assert.match(el('footer-git').innerHTML, /git-shell-dot/);

  harness.shellRunning = false;
  await GitActions.refreshShellState();
  assert.ok(!el('footer-git').innerHTML.includes('git-shell-dot'));
});

test('shell state is not queried for a non-repo project', async () => {
  const urls = [];
  harness.apiHandler = url => { urls.push(url); return { available: false }; };
  await GitActions.init('proj');
  assert.ok(!urls.some(u => u.includes('terminal/info')), 'no pointless shell probe');
});

test('a failing shell probe leaves the footer usable', async () => {
  harness.apiHandler = url => {
    if (url.includes('terminal/info')) throw new Error('boom');
    return { available: true, branch: 'b', files: [] };
  };
  await GitActions.init('proj');
  assert.strictEqual(GitActions._shellRunning, false);
  assert.match(el('footer-git').innerHTML, /b</);
});

// ── entry point routing ──────────────────────────────────────────────────────

test('in the project view the footer switches to the Git tab', async () => {
  harness.currentView = 'project-detail';
  await GitActions.init('proj');
  GitActions.openGitPanel();

  assert.deepStrictEqual(harness.switched, [{ tab: 'git', btn: 'git-tab-btn' }]);
  assert.strictEqual(harness.modals.length, 0, 'no modal when the tab is right there');
});

test('in a session the footer opens the same panel in a modal', async () => {
  harness.currentView = 'session-detail';
  await GitActions.init('proj');
  GitActions.openGitPanel();

  assert.strictEqual(harness.switched.length, 0, 'the session is not left behind');
  assert.strictEqual(harness.modals.length, 1);
  assert.strictEqual(harness.modals[0].title, 'Git');
  assert.deepStrictEqual(harness.mounts, [{ hostId: 'git-panel-modal-host', slug: 'proj' }]);
});

test('closing the modal unmounts the panel without killing the shell', async () => {
  harness.currentView = 'session-detail';
  await GitActions.init('proj');
  GitActions.openGitPanel();
  harness.modals[0].onClose();

  assert.strictEqual(harness.unmounts, 1);
});

test('the git panel is refused when the project is not a repo', async () => {
  harness.apiHandler = () => ({ available: false });
  await GitActions.init('proj');
  GitActions.openGitPanel();

  assert.strictEqual(harness.modals.length, 0);
  assert.strictEqual(harness.switched.length, 0);
  assert.strictEqual(harness.toasts[0].type, 'error');
});

test('reset clears state and hides both entry points', async () => {
  await GitActions.init('proj');
  GitActions.reset();

  assert.strictEqual(GitActions._slug, null);
  assert.strictEqual(GitActions._shellRunning, false);
  assert.strictEqual(el('footer-git').style.display, 'none');
  assert.strictEqual(el('git-tab-btn').style.display, 'none');
});

test('refreshShellState is a no-op before any project is loaded', async () => {
  GitActions._slug = null;
  await GitActions.refreshShellState();
  assert.strictEqual(el('footer-git').innerHTML, '');
});

// ── commit and push actions ──────────────────────────────────────────────────
// GitActions owns the calls and the repaint that follows; the panel owns the file list it passes in.

test('runCommit posts the message and files, then repaints footer and panel', async () => {
  const calls = [];
  harness.apiHandler = (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/git/commit')) return { ok: true, output: '1 file changed' };
    if (url.includes('terminal/info')) return { available: true, running: false };
    return { available: true, branch: 'b', files: [], unpushed: [] };
  };
  await GitActions.init('proj');
  await GitActions.runCommit('Do the thing', ['a.js'], false);

  const commit = calls.find(c => c.url.includes('/git/commit'));
  assert.strictEqual(commit.opts.method, 'POST');
  // the body is built inside the vm sandbox, so compare fields rather than cross-realm objects
  assert.strictEqual(commit.opts.body.message, 'Do the thing');
  assert.deepStrictEqual(Array.from(commit.opts.body.files), ['a.js']);
  assert.ok(calls.some(c => c.url.includes('/git/info') && c !== commit), 'footer state is re-read');
  assert.strictEqual(harness.panelRefreshes, 1, 'the panel repaints too');
});

test('runCommit with andPush pushes after committing', async () => {
  const urls = [];
  harness.apiHandler = (url) => {
    urls.push(url);
    if (url.includes('terminal/info')) return { available: true, running: false };
    return { available: true, branch: 'b', files: [], unpushed: [] };
  };
  await GitActions.init('proj');
  await GitActions.runCommit('msg', ['a.js'], true);

  const commitAt = urls.findIndex(u => u.includes('/git/commit'));
  const pushAt = urls.findIndex(u => u.includes('/git/push'));
  assert.ok(commitAt !== -1 && pushAt !== -1, 'both calls happen');
  assert.ok(pushAt > commitAt, 'push comes after the commit');
});

test('a failed commit surfaces the error and still refreshes state', async () => {
  harness.apiHandler = url => {
    if (url.includes('/git/commit')) throw new Error('nothing added to commit');
    if (url.includes('terminal/info')) return { available: true, running: false };
    return { available: true, branch: 'b', files: [], unpushed: [] };
  };
  await GitActions.init('proj');
  await GitActions.runCommit('msg', ['a.js'], false);

  assert.strictEqual(harness.toasts.pop().type, 'error');
  assert.strictEqual(harness.panelRefreshes, 1, 'the panel is repainted even after a failure');
});

test('push from the footer repaints the panel as well', async () => {
  harness.apiHandler = url => {
    if (url.includes('terminal/info')) return { available: true, running: false };
    return { available: true, branch: 'b', files: [], unpushed: [] };
  };
  await GitActions.init('proj');
  await GitActions.push();
  assert.strictEqual(harness.panelRefreshes, 1);
});

// ── one action, no dropdown ──────────────────────────────────────────────────

test('the footer button opens the panel directly, with no menu', async () => {
  await GitActions.init('proj');
  const html = el('footer-git').innerHTML;

  assert.match(html, /GitActions\.openGitPanel\(\)/, 'clicking the button opens the panel');
  assert.ok(!html.includes('action-menu'), 'no dropdown wrapper');
  assert.ok(!html.includes('action-menu-item'), 'no menu items');
  assert.strictEqual((html.match(/<button/g) || []).length, 1, 'exactly one control');
});

test('commit and push are not duplicated in the footer', async () => {
  await GitActions.init('proj');
  const html = el('footer-git').innerHTML;

  assert.ok(!/>Commit</.test(html), 'no Commit button in the footer');
  assert.ok(!/>Push</.test(html), 'no Push button in the footer');
  assert.strictEqual(GitActions.openCommitModal, undefined, 'the commit modal is gone entirely');
  assert.strictEqual(GitActions.toggleMenu, undefined, 'the dropdown toggle is gone');
});

test('the button still carries branch, dot, divergence and file count together', async () => {
  harness.shellRunning = true;
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: true, running: true }
    : { available: true, branch: 'feature/x', ahead: 2, behind: 0, upstream: 'origin/x', files: [{ path: 'a.js', label: 'modified' }] });
  await GitActions.init('proj');
  const html = el('footer-git').innerHTML;

  assert.match(html, /feature\/x/);
  assert.match(html, /git-shell-dot/);
  assert.match(html, /↑2/);
  assert.match(html, /git-count-badge">1</);
});

test('GitActions keeps the actions and leaves the file list to the panel', () => {
  assert.strictEqual(typeof GitActions.runCommit, 'function');
  assert.strictEqual(typeof GitActions.push, 'function');
  assert.strictEqual(GitActions.fileRowsHtml, undefined, 'rendering the file list is the panel\'s job');
  assert.strictEqual(GitActions.selectedFiles, undefined);
  assert.strictEqual(GitActions.setAllFiles, undefined);
});

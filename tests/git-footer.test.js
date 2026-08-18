const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The footer git button is the one control present in both the project and the session view, so it
// is where the git UI is reached from: in the project view it switches to the Git tab, anywhere else
// it opens the same GitPanel in a modal. It also carries the upstream divergence and a dot for a
// running shell.
const src = fs.readFileSync(path.join(__dirname, '../public/js/git.js'), 'utf-8');

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
  api: async url => {
    if (harness.apiHandler) return harness.apiHandler(url);
    if (url.includes('terminal/info')) return { available: true, running: harness.shellRunning === true };
    return { available: true, branch: 'feature/x', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, files: [] };
  },
  get App() { return { currentView: harness.currentView, currentProject: 'proj' }; },
  ProjectTabs: { switch: (tab, btn) => { harness.switched.push({ tab, btn: btn && btn.id }); } },
  GitPanel: {
    mount: (hostId, slug) => { harness.mounts.push({ hostId, slug }); },
    unmount: () => { harness.unmounts++; },
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

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// GitPanel hosts a project shell and a recipe panel, mounted either in the project-detail Git tab
// or in the modal the footer button opens from a session. Two contracts matter: a clicked recipe is
// TYPED into the shell and never executed, and unmounting a view must not kill the pty behind it.
const src = ['git-api.js', 'term-view.js', 'git-recipes.js', 'git-panel.js']
  .map(f => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf-8'))
  .join('\n');

const HOST = 'git-tab-body';

const harness = {
  store: {},
  els: {},
  sent: [],
  toasts: [],
  wsReadyState: 1,
  apiHandler: null,
  focused: 0,
  wsUrls: [],
  wsClosed: 0,
  termDisposed: 0,
  shellStateRefreshes: 0,
  ws: null,
  fitted: 0,
  checkboxes: [],
  commits: [],
  pushes: 0,
  gitInfo: null,
};

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) {
        const next = on === undefined ? !this._set.has(c) : !!on;
        if (next) this._set.add(c); else this._set.delete(c);
        return next;
      },
    },
  };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

function FakeTerminal() {
  this.cols = 80;
  this.rows = 24;
  this.written = [];
}
FakeTerminal.prototype.loadAddon = function () {};
FakeTerminal.prototype.open = function () {};
FakeTerminal.prototype.write = function (d) { this.written.push(d); };
FakeTerminal.prototype.focus = function () { harness.focused++; };
FakeTerminal.prototype.onData = function () { return { dispose() {} }; };
FakeTerminal.prototype.attachCustomKeyEventHandler = function () {};
FakeTerminal.prototype.hasSelection = function () { return false; };
FakeTerminal.prototype.dispose = function () { harness.termDisposed++; };

function FakeFit() {}
FakeFit.prototype.fit = function () { harness.fitted++; };

function FakeWebSocket(url) {
  this.url = url;
  this.readyState = harness.wsReadyState;
  harness.wsUrls.push(url);
  harness.ws = this;
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.prototype.send = function (payload) { harness.sent.push(JSON.parse(payload)); };
FakeWebSocket.prototype.close = function () { harness.wsClosed++; };

const context = vm.createContext({
  localStorage: {
    getItem: k => (k in harness.store ? harness.store[k] : null),
    setItem: (k, v) => { harness.store[k] = String(v); },
  },
  document: {
    getElementById: id => el(id),
    querySelectorAll: sel => {
      const files = harness.checkboxes.filter(c => c.kind === 'file');
      if (sel === '.git-file-cb') return files;
      if (sel === '.git-file-cb:checked') return files.filter(c => c.checked);
      if (sel === '.git-group-cb') return harness.checkboxes.filter(c => c.kind === 'group');
      return [];
    },
  },
  window: { Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit } },
  location: { protocol: 'http:', host: '127.0.0.1:3000' },
  WebSocket: FakeWebSocket,
  ResizeObserver: undefined,
  GitActions: {
    refreshShellState: () => { harness.shellStateRefreshes++; },
    runCommit: (message, files, andPush) => { harness.commits.push({ message, files, andPush }); },
    push: () => { harness.pushes++; },
  },
  setTimeout: fn => fn(),
  escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;'),
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  api: async url => {
    if (harness.apiHandler) return harness.apiHandler(url);
    if (url.includes('terminal/info')) return { available: true, running: harness.shellRunning === true, mode: 'shell' };
    return harness.gitInfo;
  },
});
vm.runInContext(src + '\nglobalThis._GitPanel = GitPanel; globalThis._GitRecipes = GitRecipes;', context);
const GitPanel = context._GitPanel;
const GitRecipes = context._GitRecipes;

/** Build the checkbox objects the browser would have made from the rendered changes card. */
function syncCheckboxes() {
  const html = el('git-changes').innerHTML;
  harness.checkboxes = [];
  for (const m of html.matchAll(/class="git-file-cb" value="([^"]*)"/g)) {
    harness.checkboxes.push({ kind: 'file', value: m[1], checked: true, indeterminate: false });
  }
  for (const m of html.matchAll(/class="git-group-cb" data-prefix="([^"]*)"/g)) {
    harness.checkboxes.push({
      kind: 'group', prefix: m[1], checked: true, indeterminate: false,
      getAttribute(name) { return name === 'data-prefix' ? this.prefix : null; },
    });
  }
  return harness.checkboxes;
}

function fileCb(path) {
  return harness.checkboxes.find(c => c.kind === 'file' && c.value === path);
}

function groupCb(prefix) {
  return harness.checkboxes.find(c => c.kind === 'group' && c.prefix === prefix);
}

/** Open the shell through the real path, so the fake xterm and socket are exercised. */
function connectFakeShell() {
  GitPanel.openShell();
  harness.ws.readyState = harness.wsReadyState;
}

beforeEach(() => {
  harness.store = {};
  harness.els = {};
  harness.sent = [];
  harness.toasts = [];
  harness.wsReadyState = 1;
  harness.apiHandler = null;
  harness.focused = 0;
  harness.wsUrls = [];
  harness.wsClosed = 0;
  harness.termDisposed = 0;
  harness.shellStateRefreshes = 0;
  harness.shellRunning = false;
  harness.ws = null;
  harness.fitted = 0;
  harness.checkboxes = [];
  harness.commits = [];
  harness.pushes = 0;
  harness.gitInfo = {
    available: true, branch: 'feature/x', detached: false, upstream: 'origin/main',
    ahead: 0, behind: 0, unpushed: [], files: [],
  };
  GitPanel._slug = 'proj';
  GitPanel._hostId = HOST;
  GitPanel._shellInfo = { available: true, running: false };
  GitPanel._info = { available: true, branch: 'feature/x', detached: false, upstream: 'origin/main' };
  GitPanel._view = null;
  GitPanel._openCategories = new Set([GitRecipes.CATEGORIES[0].name]);
});

// ── recipe data ──────────────────────────────────────────────────────────────

test('every recipe carries a git command and an explanation', () => {
  for (const cat of GitRecipes.CATEGORIES) {
    assert.ok(cat.name, 'a category has a name');
    assert.ok(cat.items.length > 0, `${cat.name} has recipes`);
    for (const item of cat.items) {
      assert.match(item.cmd, /^git /, `${item.cmd} is a git command`);
      assert.ok(item.explain && item.explain.length > 10, `${item.cmd} is explained`);
    }
  }
});

test('history-rewriting and work-destroying recipes are flagged as dangerous', () => {
  const all = GitRecipes.CATEGORIES.flatMap(c => c.items);
  const byCmd = cmd => all.find(i => i.cmd.startsWith(cmd));
  for (const cmd of ['git reset --hard', 'git clean -fd', 'git rebase <base>', 'git push --force-with-lease', 'git branch -D']) {
    assert.strictEqual(byCmd(cmd).danger, true, `${cmd} must be marked dangerous`);
  }
  for (const cmd of ['git status', 'git diff', 'git stash list', 'git reflog', 'git revert']) {
    assert.notStrictEqual(byCmd(cmd).danger, true, `${cmd} must not be marked dangerous`);
  }
});

test('no recipe uses bare --force', () => {
  const all = GitRecipes.CATEGORIES.flatMap(c => c.items);
  for (const item of all) {
    assert.ok(!/--force(?!-with-lease)/.test(item.cmd), `${item.cmd} must use --force-with-lease`);
  }
});

test('substitute fills the branch and the upstream base', () => {
  const info = { branch: 'feature/x', detached: false, upstream: 'origin/main' };
  assert.strictEqual(GitRecipes.substitute('git push -u origin <branch>', info), 'git push -u origin feature/x');
  assert.strictEqual(GitRecipes.substitute('git diff <base>...HEAD', info), 'git diff origin/main...HEAD');
});

test('substitute leaves <branch> alone on a detached HEAD', () => {
  const info = { branch: 'abc1234', detached: true, upstream: null };
  assert.strictEqual(GitRecipes.substitute('git switch <branch>', info), 'git switch <branch>');
});

test('substitute leaves placeholders it cannot resolve', () => {
  assert.strictEqual(GitRecipes.substitute('git commit -m "<message>"', {}), 'git commit -m "<message>"');
  assert.strictEqual(GitRecipes.substitute('git show <commit>', null), 'git show <commit>');
});

// ── typing recipes into the shell ────────────────────────────────────────────

test('a clicked recipe is typed without a newline, so nothing runs', () => {
  connectFakeShell();
  GitPanel.useRecipe({ getAttribute: () => 'git status -sb' });

  assert.deepStrictEqual(harness.sent, [{ t: 'i', d: 'git status -sb' }]);
  assert.ok(!harness.sent[0].d.includes('\r'), 'no carriage return');
  assert.ok(!harness.sent[0].d.includes('\n'), 'no newline');
});

test('clicking a recipe focuses the shell so the user can edit it', () => {
  connectFakeShell();
  GitPanel.useRecipe({ getAttribute: () => 'git log' });
  assert.strictEqual(harness.focused, 1);
});

test('a recipe clicked with no shell open warns instead of sending', () => {
  GitPanel.useRecipe({ getAttribute: () => 'git status' });
  assert.deepStrictEqual(harness.sent, []);
  assert.strictEqual(harness.toasts.length, 1);
  assert.strictEqual(harness.toasts[0].type, 'error');
});

test('a recipe clicked while the socket is closed sends nothing', () => {
  connectFakeShell();
  harness.ws.readyState = 3;
  GitPanel.useRecipe({ getAttribute: () => 'git status' });
  assert.deepStrictEqual(harness.sent, []);
  assert.strictEqual(harness.toasts[0].type, 'error');
});

// ── rendering ────────────────────────────────────────────────────────────────

test('a non-repo project renders an empty state and no shell', async () => {
  harness.apiHandler = () => ({ available: false });
  await GitPanel.mount(HOST, 'proj');
  const body = el(HOST).innerHTML;
  assert.match(body, /not a git repository/);
  assert.ok(!body.includes('git-shell-host'), 'no shell is offered');
});

test('a repo renders the shell and the recipe panel with substituted commands', async () => {
  await GitPanel.mount(HOST, 'proj');
  assert.match(el(HOST).innerHTML, /git-shell-host/);
  const recipes = el('git-recipes').innerHTML;
  assert.match(recipes, /git status -sb/);
  assert.match(recipes, /git push -u origin feature\/x/, 'placeholders resolved against live state');
});

test('the shell header shows a detached HEAD rather than a bare sha', async () => {
  harness.apiHandler = () => ({ available: true, branch: 'abc1234', detached: true, upstream: null });
  await GitPanel.mount(HOST, 'proj');
  assert.match(el(HOST).innerHTML, /detached @ abc1234/);
});

test('dangerous recipes render with a distinguishing class', async () => {
  GitPanel._openCategories = new Set(['Undo and recover']);
  await GitPanel.mount(HOST, 'proj');
  assert.match(el('git-recipes').innerHTML, /git-recipe-danger/);
});

test('only opened categories render their items', async () => {
  GitPanel._openCategories = new Set(['Stash']);
  await GitPanel.mount(HOST, 'proj');
  const html = el('git-recipes').innerHTML;
  const stashOpen = html.indexOf('git-recipe-cat open');
  assert.ok(stashOpen !== -1, 'the opened category is marked open');
  assert.strictEqual((html.match(/git-recipe-cat open/g) || []).length, 1);
});

test('toggleCategory opens and closes a category', async () => {
  await GitPanel.mount(HOST, 'proj');
  const first = GitRecipes.CATEGORIES[0].name;
  GitPanel.toggleCategory(first);
  assert.strictEqual(GitPanel._openCategories.has(first), false);
  GitPanel.toggleCategory(first);
  assert.strictEqual(GitPanel._openCategories.has(first), true);
});

test('load falls back to unavailable when git/info fails', async () => {
  harness.apiHandler = () => { throw new Error('boom'); };
  await GitPanel.mount(HOST, 'proj');
  assert.strictEqual(GitPanel._info.available, false);
  assert.match(el(HOST).innerHTML, /not a git repository/);
});

test('switching projects closes the previous shell', async () => {
  await GitPanel.mount(HOST, 'proj');
  connectFakeShell();
  await GitPanel.mount(HOST, 'other-proj');
  assert.strictEqual(harness.wsClosed, 1, 'the old shell socket is closed');
  assert.strictEqual(GitPanel.shellOpen(), false);
});

// ── shell lifecycle ──────────────────────────────────────────────────────────

test('opening the shell connects in shell mode', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();

  assert.strictEqual(harness.wsUrls.length, 1);
  assert.match(harness.wsUrls[0], /\/api\/projects\/proj\/terminal\?mode=shell$/);
  assert.strictEqual(GitPanel.shellOpen(), true, 'a terminal is mounted');
});

test('a connected shell reports its size to the server', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  harness.ws.onopen();

  assert.deepStrictEqual(harness.sent, [{ t: 'r', c: 80, r: 24 }]);
  assert.strictEqual(harness.shellStateRefreshes, 1, 'the footer dot is refreshed on connect');
});

test('mount reattaches to a shell that is already running', async () => {
  harness.shellRunning = true;
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.shellOpen(), true, 'the shell is reattached without asking');
  assert.strictEqual(harness.wsUrls.length, 1);
});

test('mount shows the idle state when no shell is running', async () => {
  harness.shellRunning = false;
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.shellOpen(), false);
  assert.strictEqual(harness.wsUrls.length, 0);
  assert.match(el(HOST).innerHTML, /Open Shell/);
});

test('unmount drops the view but never terminates the pty', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  harness.ws.readyState = 1;
  GitPanel.unmount();

  assert.strictEqual(harness.wsClosed, 1, 'the socket is closed');
  assert.strictEqual(harness.termDisposed, 1, 'the terminal is disposed');
  assert.deepStrictEqual(harness.sent, [], 'no close message — the shell keeps running');
  assert.strictEqual(GitPanel.shellOpen(), false);
  assert.strictEqual(GitPanel._hostId, null);
});

test('killShell terminates the pty explicitly', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  harness.ws.readyState = 1;
  GitPanel.killShell();

  assert.deepStrictEqual(harness.sent, [{ t: 'close' }]);
  assert.strictEqual(harness.termDisposed, 1);
  assert.strictEqual(GitPanel.shellOpen(), false);
  assert.strictEqual(harness.shellStateRefreshes, 1, 'the footer dot is refreshed');
});

test('mounting into a second host moves the panel and drops the old view', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  await GitPanel.mount('git-panel-modal-host', 'proj');

  assert.strictEqual(harness.termDisposed, 1, 'the tab view is disposed');
  assert.deepStrictEqual(harness.sent, [], 'moving between hosts does not kill the shell');
  assert.strictEqual(GitPanel._hostId, 'git-panel-modal-host');
  assert.match(el('git-panel-modal-host').innerHTML, /git-shell-host/);
});

test('the same panel renders identically in either host', async () => {
  await GitPanel.mount(HOST, 'proj');
  const inTab = el(HOST).innerHTML;
  GitPanel.unmount();
  await GitPanel.mount('git-panel-modal-host', 'proj');

  assert.strictEqual(el('git-panel-modal-host').innerHTML, inTab, 'one implementation, one markup');
});

test('reconnect reuses the terminal instead of opening a second one', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  const term = GitPanel._view.term;
  GitPanel.reconnect();

  assert.strictEqual(GitPanel._view.term, term, 'the same terminal is kept');
  assert.strictEqual(harness.wsClosed, 1, 'the old socket is closed');
  assert.strictEqual(harness.wsUrls.length, 2, 'and a new one is opened');
});

test('a missing node-pty offers no shell button', async () => {
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: false, running: false }
    : { available: true, branch: 'feature/x', detached: false });
  await GitPanel.mount(HOST, 'proj');

  assert.match(el(HOST).innerHTML, /node-pty is not installed/);
  assert.ok(!el(HOST).innerHTML.includes('Open Shell'), 'no button that cannot work');
});

// ── what to commit / what to push ────────────────────────────────────────────

test('the changes card lists changed files with a count', async () => {
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'new.js', label: 'untracked' },
  ];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /To commit/);
  assert.match(html, /lib\/git\.js/);
  assert.match(html, /new\.js/);
  assert.match(html, /git-count-badge">2</, 'the count matches the file list');
});

test('a clean tree says so and disables the commit buttons', async () => {
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /Nothing to commit/);
  assert.match(html, /Commit<\/button>/);
  const commitBtn = html.slice(html.indexOf('GitPanel.commit(false)'));
  assert.match(commitBtn.slice(0, 60), /disabled/, 'Commit is disabled with nothing staged');
});

test('the changes card lists the commits a push would send', async () => {
  harness.gitInfo.ahead = 2;
  harness.gitInfo.unpushed = [
    { sha: 'abc1234', subject: 'Add a thing' },
    { sha: 'def5678', subject: 'Fix another thing' },
  ];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /To push/);
  assert.match(html, /abc1234/);
  assert.match(html, /Add a thing/);
  assert.match(html, /Push \(2\)/, 'the push button carries the count');
  assert.match(html, /↑2/);
});

test('nothing to push names the upstream it is level with', async () => {
  await GitPanel.mount(HOST, 'proj');
  assert.match(el('git-changes').innerHTML, /Nothing to push — up to date with origin\/main/);
});

test('a branch with no upstream is told the first push needs -u', async () => {
  harness.gitInfo.upstream = null;
  await GitPanel.mount(HOST, 'proj');
  assert.match(el('git-changes').innerHTML, /first push needs/);
});

test('being behind the upstream warns to pull before pushing', async () => {
  harness.gitInfo.behind = 3;
  await GitPanel.mount(HOST, 'proj');
  assert.match(el('git-changes').innerHTML, /3 commits on origin\/main you do not have/);
});

test('commit passes the ticked files and the typed message straight to GitActions', async () => {
  harness.gitInfo.files = [{ path: 'lib/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();
  el('git-panel-msg').value = '  Tidy the thing  ';
  GitPanel.commit(false);

  // the file list is built inside the vm sandbox, so compare fields not cross-realm objects
  assert.strictEqual(harness.commits.length, 1);
  assert.strictEqual(harness.commits[0].message, 'Tidy the thing', 'the message is trimmed');
  assert.deepStrictEqual(Array.from(harness.commits[0].files), ['lib/git.js']);
  assert.strictEqual(harness.commits[0].andPush, false, 'the shared commit path is reused');
});

test('commit and push flows through the same path with andPush set', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();
  el('git-panel-msg').value = 'Ship it';
  GitPanel.commit(true);

  assert.strictEqual(harness.commits[0].andPush, true);
});

test('commit refuses an empty message and an empty selection', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  el('git-panel-msg').value = '   ';
  GitPanel.commit(false);
  assert.deepStrictEqual(harness.commits, []);
  assert.strictEqual(harness.toasts.pop().type, 'error');

  el('git-panel-msg').value = 'Fine message';
  syncCheckboxes();
  GitPanel.setAllFiles(false);
  GitPanel.commit(false);
  assert.deepStrictEqual(harness.commits, [], 'nothing ticked, nothing committed');
  assert.strictEqual(harness.toasts.pop().type, 'error');
});

test('refreshIfMounted repaints the changes card and keeps a half-typed message', async () => {
  await GitPanel.mount(HOST, 'proj');
  el('git-panel-msg').value = 'half typed';
  harness.gitInfo.files = [{ path: 'later.js', label: 'modified' }];
  await GitPanel.refreshIfMounted();

  assert.match(el('git-changes').innerHTML, /later\.js/, 'new state is shown');
  assert.strictEqual(el('git-panel-msg').value, 'half typed', 'the draft survives the repaint');
});

test('refreshIfMounted does nothing when the panel is not mounted', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.unmount();
  el('git-changes').innerHTML = 'UNTOUCHED';
  await GitPanel.refreshIfMounted();
  assert.strictEqual(el('git-changes').innerHTML, 'UNTOUCHED');
});

test('the select-all controls appear only with more than one file', async () => {
  harness.gitInfo.files = [{ path: 'only.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  assert.ok(!el('git-changes').innerHTML.includes('git-select-btn'));

  harness.gitInfo.files.push({ path: 'second.js', label: 'new' });
  await GitPanel.refreshIfMounted();
  assert.match(el('git-changes').innerHTML, /git-select-btn/);
});

// ── recipe column follows the shell ──────────────────────────────────────────
// A recipe can only be typed into a shell, so the column is not worth its width until one is open.

test('no shell means no recipe column, and the changes list gets the width', async () => {
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.recipesVisible(), false);
  assert.match(el(HOST).innerHTML, /git-panel-layout no-recipes/);
});

test('opening the shell brings the recipe column with it', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();

  assert.strictEqual(GitPanel.recipesVisible(), true);
  const classes = el('git-panel-layout').classList;
  assert.ok(!classes.contains('no-recipes'), 'the column is no longer suppressed');
  assert.ok(!classes.contains('recipes-collapsed'), 'and it opens rather than folds');
  assert.match(el('git-recipes').innerHTML, /git status -sb/);
});

test('ending the shell takes the recipe column away again', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  GitPanel.killShell();

  assert.strictEqual(GitPanel.recipesVisible(), false);
  assert.ok(el('git-panel-layout').classList.contains('no-recipes'));
});

test('reattaching to a running shell shows the recipes straight away', async () => {
  harness.shellRunning = true;
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.recipesVisible(), true);
  assert.ok(!el('git-panel-layout').classList.contains('no-recipes'));
});

test('toggleRecipes folds the column and remembers it', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  GitPanel.toggleRecipes();

  assert.strictEqual(GitPanel.recipesCollapsed(), true);
  assert.strictEqual(GitPanel.recipesVisible(), false);
  assert.strictEqual(harness.store[GitPanel.RECIPES_COLLAPSED_KEY], '1');
  assert.ok(el('git-panel-layout').classList.contains('recipes-collapsed'));
});

test('toggleRecipes unfolds again', async () => {
  harness.store[GitPanel.RECIPES_COLLAPSED_KEY] = '1';
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  GitPanel.toggleRecipes();

  assert.strictEqual(GitPanel.recipesCollapsed(), false);
  assert.ok(!el('git-panel-layout').classList.contains('recipes-collapsed'));
});

test('a deliberate fold is honoured the next time a shell opens', async () => {
  harness.store[GitPanel.RECIPES_COLLAPSED_KEY] = '1';
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();

  assert.strictEqual(GitPanel.recipesVisible(), false, 'the shell does not overrule the user');
  assert.ok(el('git-panel-layout').classList.contains('recipes-collapsed'));
});

test('a fold preference is not mistaken for a hidden column without a shell', async () => {
  harness.store[GitPanel.RECIPES_COLLAPSED_KEY] = '0';
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.recipesCollapsed(), false, 'the preference says open');
  assert.strictEqual(GitPanel.recipesVisible(), false, 'but there is no shell to type into');
});

test('folding the column resizes the shell to the space it gained', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  harness.ws.readyState = 1;
  harness.sent.length = 0;
  GitPanel.toggleRecipes();

  assert.deepStrictEqual(harness.sent, [{ t: 'r', c: 80, r: 24 }], 'the pty is told the new size');
});

test('recipes still work while the column is folded and reopened', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  GitPanel.toggleRecipes();
  GitPanel.useRecipe({ getAttribute: () => 'git log' });

  assert.deepStrictEqual(harness.sent.filter(m => m.t === 'i'), [{ t: 'i', d: 'git log' }]);
});

test('an unreadable localStorage does not break the panel', async () => {
  const original = context.localStorage.getItem;
  context.localStorage.getItem = () => { throw new Error('blocked'); };
  try {
    await GitPanel.mount(HOST, 'proj');
    assert.match(el(HOST).innerHTML, /git-recipes/, 'the panel still renders');
    assert.strictEqual(GitPanel.recipesCollapsed(), false, 'and the fold preference defaults to open');
  } finally {
    context.localStorage.getItem = original;
  }
});

// ── only the checkbox toggles a file ─────────────────────────────────────────
// The row used to be a <label>, so clicking a path to read it silently unticked the file.

test('a file row is not a label, so clicking its name cannot untick it', async () => {
  harness.gitInfo.files = [{ path: 'lib/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.ok(!html.includes('<label'), 'no label wraps the row');
  assert.match(html, /<div class="git-file-row"/);
  assert.match(html, /class="git-file-cb"[^>]*checked/, 'the checkbox is the only control');
});

test('tree folders are not labels either, keeping the rule consistent', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [{ path: 'lib/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');

  assert.ok(!el('git-changes').innerHTML.includes('<label'));
});

// ── flat and tree views ──────────────────────────────────────────────────────

test('flat is the default view and shows whole paths', async () => {
  harness.gitInfo.files = [{ path: 'public/js/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.viewMode(), 'flat');
  assert.match(el('git-changes').innerHTML, />public\/js\/git\.js</);
  assert.ok(!el('git-changes').innerHTML.includes('git-tree-folder'), 'no folders in flat view');
});

test('the view toggle appears with files and marks the active mode', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /git-view-toggle/);
  assert.match(html, /sf-mode-btn active[\s\S]*?setViewMode\('flat'\)/);
});

test('no view toggle when there is nothing to commit', async () => {
  await GitPanel.mount(HOST, 'proj');
  assert.ok(!el('git-changes').innerHTML.includes('git-view-toggle'));
});

test('tree view nests folders and shows only the file name', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'public/js/git.js', label: 'modified' },
    { path: 'public/js/git-panel.js', label: 'modified' },
    { path: 'lib/git.js', label: 'modified' },
    { path: 'README.md', label: 'untracked' },
  ];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /data-prefix="public\/"/);
  assert.match(html, /data-prefix="public\/js\/"/);
  assert.match(html, /data-prefix="lib\/"/);
  assert.match(html, /title="public\/js\/git\.js">git\.js</, 'basename shown, full path in the tooltip');
  assert.match(html, /--git-depth:2/, 'files nest under their folders');
});

test('tree view counts every file under a folder, however deep', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'public/js/a.js', label: 'modified' },
    { path: 'public/css/b.css', label: 'modified' },
    { path: 'public/index.html', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  const publicCount = html.match(/data-prefix="public\/"[\s\S]*?git-tree-count">(\d+)</);
  assert.strictEqual(publicCount[1], '3', 'the folder counts its whole subtree');
});

test('root-level files sit at depth 0 in tree view', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [{ path: 'README.md', label: 'untracked' }];
  await GitPanel.mount(HOST, 'proj');

  assert.match(el('git-changes').innerHTML, /--git-depth:0[\s\S]*README\.md/);
  assert.ok(!el('git-changes').innerHTML.includes('git-group-cb'), 'no folder row for a root file');
});

test('switching the view remembers the choice and keeps a half-typed message', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  el('git-panel-msg').value = 'work in progress';

  GitPanel.setViewMode('tree');
  assert.strictEqual(harness.store[GitPanel.VIEW_MODE_KEY], 'tree');
  assert.strictEqual(GitPanel.viewMode(), 'tree');
  assert.strictEqual(el('git-panel-msg').value, 'work in progress');

  GitPanel.setViewMode('flat');
  assert.strictEqual(GitPanel.viewMode(), 'flat');
});

test('an unknown stored view mode falls back to flat', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'nonsense';
  await GitPanel.mount(HOST, 'proj');
  assert.strictEqual(GitPanel.viewMode(), 'flat');
});

// ── unticking a folder ───────────────────────────────────────────────────────

test('unticking a folder unticks exactly its own files', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'lib/paths.js', label: 'modified' },
    { path: 'routes/git.js', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  const lib = groupCb('lib/');
  lib.checked = false;
  GitPanel.toggleGroup(lib);

  assert.deepStrictEqual(Array.from(GitPanel.selectedFiles()), ['routes/git.js']);
  assert.strictEqual(fileCb('lib/git.js').checked, false);
  assert.strictEqual(groupCb('routes/').checked, true, 'a sibling folder is untouched');
});

test('reticking a folder brings its files back', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'lib/paths.js', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  const lib = groupCb('lib/');
  lib.checked = false;
  GitPanel.toggleGroup(lib);
  lib.checked = true;
  GitPanel.toggleGroup(lib);

  assert.strictEqual(GitPanel.selectedFiles().length, 2);
  assert.strictEqual(lib.indeterminate, false);
});

test('a nested folder only affects its own subtree', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'public/js/a.js', label: 'modified' },
    { path: 'public/css/b.css', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  const js = groupCb('public/js/');
  js.checked = false;
  GitPanel.toggleGroup(js);

  assert.deepStrictEqual(Array.from(GitPanel.selectedFiles()), ['public/css/b.css']);
  assert.strictEqual(groupCb('public/').indeterminate, true, 'the parent shows a partial selection');
  assert.strictEqual(groupCb('public/').checked, false);
});

test('unticking one file leaves its folder indeterminate', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'lib/paths.js', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  fileCb('lib/git.js').checked = false;
  GitPanel.syncGroups();

  const lib = groupCb('lib/');
  assert.strictEqual(lib.checked, false);
  assert.strictEqual(lib.indeterminate, true);
});

test('unticking every file in a folder clears the folder rather than leaving it partial', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [{ path: 'lib/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  fileCb('lib/git.js').checked = false;
  GitPanel.syncGroups();

  assert.strictEqual(groupCb('lib/').checked, false);
  assert.strictEqual(groupCb('lib/').indeterminate, false);
});

test('All and None drive the folders too', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'routes/git.js', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  GitPanel.setAllFiles(false);
  assert.deepStrictEqual(Array.from(GitPanel.selectedFiles()), []);
  assert.strictEqual(groupCb('lib/').checked, false);

  GitPanel.setAllFiles(true);
  assert.strictEqual(GitPanel.selectedFiles().length, 2);
  assert.strictEqual(groupCb('lib/').checked, true);
});

test('a folder whose name prefixes another is not caught by it', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'tree';
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'libs/other.js', label: 'modified' },
  ];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();

  const lib = groupCb('lib/');
  lib.checked = false;
  GitPanel.toggleGroup(lib);

  assert.deepStrictEqual(Array.from(GitPanel.selectedFiles()), ['libs/other.js'],
    'lib/ must not match libs/other.js');
});

// ── stable layout ────────────────────────────────────────────────────────────
// Both lists keep their box whether they have content or not, so the card does not reflow as
// files are committed or commits are pushed.

test('the changed-files box is rendered even with nothing to commit', async () => {
  await GitPanel.mount(HOST, 'proj');
  const html = el('git-changes').innerHTML;
  assert.match(html, /git-changes-files/, 'the box is there');
  assert.match(html, /git-changes-files[^>]*>\s*<div class="git-changes-empty"/, 'the empty text sits inside it');
});

test('the unpushed-commits box is rendered even with nothing to push', async () => {
  await GitPanel.mount(HOST, 'proj');
  const html = el('git-changes').innerHTML;
  assert.match(html, /git-changes-commits/);
  assert.match(html, /git-changes-commits[^>]*>\s*<div class="git-changes-empty"/);
});

test('both boxes appear exactly once whether full or empty', async () => {
  await GitPanel.mount(HOST, 'proj');
  const emptyHtml = el('git-changes').innerHTML;
  assert.strictEqual((emptyHtml.match(/git-changes-files/g) || []).length, 1);
  assert.strictEqual((emptyHtml.match(/git-changes-commits/g) || []).length, 1);

  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  harness.gitInfo.ahead = 1;
  harness.gitInfo.unpushed = [{ sha: 'abc1234', subject: 'Something' }];
  await GitPanel.refreshIfMounted();

  const fullHtml = el('git-changes').innerHTML;
  assert.strictEqual((fullHtml.match(/git-changes-files/g) || []).length, 1);
  assert.strictEqual((fullHtml.match(/git-changes-commits/g) || []).length, 1);
});

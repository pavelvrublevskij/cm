const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// GitPanel hosts a project shell and a recipe panel, mounted either in the project-detail Git tab
// or in the modal the footer button opens from a session. Two contracts matter: a clicked recipe is
// TYPED into the shell and never executed, and unmounting a view must not kill the pty behind it.
const src = fs.readFileSync(path.join(__dirname, '../public/js/git-recipes.js'), 'utf-8')
  + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/git-panel.js'), 'utf-8');

const HOST = 'git-tab-body';

const harness = {
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
  document: {
    getElementById: id => el(id),
    querySelectorAll: () => [],
  },
  window: { Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit } },
  location: { protocol: 'http:', host: '127.0.0.1:3000' },
  WebSocket: FakeWebSocket,
  ResizeObserver: undefined,
  GitActions: { refreshShellState: () => { harness.shellStateRefreshes++; } },
  setTimeout: fn => fn(),
  escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('"').join('&quot;'),
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  api: async url => {
    if (harness.apiHandler) return harness.apiHandler(url);
    if (url.includes('terminal/info')) return { available: true, running: harness.shellRunning === true, mode: 'shell' };
    return { available: true, branch: 'feature/x', detached: false, upstream: 'origin/main' };
  },
});
vm.runInContext(src + '\nglobalThis._GitPanel = GitPanel; globalThis._GitRecipes = GitRecipes;', context);
const GitPanel = context._GitPanel;
const GitRecipes = context._GitRecipes;

/** Pretend the shell is open and connected, capturing everything sent over the socket. */
function connectFakeShell() {
  GitPanel._ws = { readyState: harness.wsReadyState, send: payload => harness.sent.push(JSON.parse(payload)) };
  GitPanel._term = { focus: () => { harness.focused++; }, cols: 80, rows: 24 };
}

beforeEach(() => {
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
  GitPanel._slug = 'proj';
  GitPanel._hostId = HOST;
  GitPanel._shellInfo = { available: true, running: false };
  GitPanel._info = { available: true, branch: 'feature/x', detached: false, upstream: 'origin/main' };
  GitPanel._ws = null;
  GitPanel._term = null;
  GitPanel._fit = null;
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
  GitPanel._ws.readyState = 3;
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
  connectFakeShell();
  let closed = false;
  GitPanel._ws.close = () => { closed = true; };
  GitPanel._term.dispose = () => {};
  await GitPanel.mount(HOST, 'other-proj');
  assert.strictEqual(closed, true, 'the old shell socket is closed');
  assert.strictEqual(GitPanel._term, null);
});

// ── shell lifecycle ──────────────────────────────────────────────────────────

test('opening the shell connects in shell mode', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();

  assert.strictEqual(harness.wsUrls.length, 1);
  assert.match(harness.wsUrls[0], /\/api\/projects\/proj\/terminal\?mode=shell$/);
  assert.ok(GitPanel._term, 'a terminal is mounted');
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

  assert.ok(GitPanel._term, 'the shell is reattached without asking');
  assert.strictEqual(harness.wsUrls.length, 1);
});

test('mount shows the idle state when no shell is running', async () => {
  harness.shellRunning = false;
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel._term, null);
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
  assert.strictEqual(GitPanel._term, null);
  assert.strictEqual(GitPanel._hostId, null);
});

test('killShell terminates the pty explicitly', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.openShell();
  harness.ws.readyState = 1;
  GitPanel.killShell();

  assert.deepStrictEqual(harness.sent, [{ t: 'close' }]);
  assert.strictEqual(harness.termDisposed, 1);
  assert.strictEqual(GitPanel._term, null);
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
  const term = GitPanel._term;
  GitPanel.reconnect();

  assert.strictEqual(GitPanel._term, term, 'the same terminal is kept');
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

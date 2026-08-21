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
  hold: null,
  diffRenders: [],
  diffRequests: [],
  diffResult: null,
  diffError: null,
  diffShas: [],
  logRequests: [],
  logPages: null,
  logError: null,
  detailRequests: [],
  detailError: null,
  commitDetail: null,
  pushes: 0,
  pulls: 0,
  fetches: 0,
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
    runCommit: (message, files, andPush) => {
      harness.commits.push({ message, files, andPush });
      return harness.hold ? harness.hold.promise : undefined;
    },
    push: () => {
      harness.pushes++;
      return harness.hold ? harness.hold.promise : undefined;
    },
    pull: () => {
      harness.pulls++;
      return harness.hold ? harness.hold.promise : undefined;
    },
    fetch: () => {
      harness.fetches++;
      return harness.hold ? harness.hold.promise : undefined;
    },
  },
  setTimeout: fn => fn(),
  escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'),
  escapeAttr: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
    .split('"').join('&quot;').split("'").join('&#39;'),
  showLoading: (container, text) => { container.innerHTML = text; },
  FileHistory: {
    renderDiff: (container, result, filePath) => {
      harness.diffRenders.push({ result, filePath });
      container.innerHTML = `DIFF:${filePath}:+${result.stats.added}-${result.stats.removed}`;
    },
  },
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  api: async url => {
    if (harness.apiHandler) return harness.apiHandler(url);
    if (url.includes('terminal/info')) return { available: true, running: harness.shellRunning === true, mode: 'shell' };
    if (url.includes('/git/diff')) {
      const [, query] = url.split('path=');
      const [rawPath, rawSha] = (query || '').split('&sha=');
      harness.diffRequests.push(decodeURIComponent(rawPath || ''));
      harness.diffShas.push(rawSha ? decodeURIComponent(rawSha) : undefined);
      if (harness.diffError) throw new Error(harness.diffError);
      return harness.diffResult;
    }
    if (url.includes('/git/log')) {
      const limit = Number((url.match(/limit=(\d+)/) || [])[1]);
      const offset = Number((url.match(/offset=(\d+)/) || [])[1]);
      harness.logRequests.push({ limit, offset });
      if (harness.logError) throw new Error(harness.logError);
      return harness.logPages[Math.min(harness.logRequests.length - 1, harness.logPages.length - 1)];
    }
    if (url.includes('/git/commit/')) {
      const sha = url.split('/git/commit/')[1];
      harness.detailRequests.push(sha);
      if (harness.detailError) throw new Error(harness.detailError);
      return harness.commitDetail;
    }
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

/** Make the next commit/push hang until release() is called, so mid-flight state can be asserted. */
function holdAction() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  harness.hold = { promise, release };
  return () => { harness.hold.release(); return harness.hold.promise; };
}

/** Find a rendered action button by its visible label ("Commit", "Push", "Pull", "Fetch"). */
function actionButton(label) {
  // Once an action has repainted the rows, those elements are the live state; before that the only
  // rendering is the card's first paint. In the browser these are the same nodes.
  const rows = el('git-changes-actions').innerHTML + el('git-sync-actions').innerHTML;
  const html = rows.trim() ? rows : el('git-changes').innerHTML;
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) || [];
  const labelRe = new RegExp(`>(?:<span[^>]*></span>)?${label}(?: \\(\\d+\\))?</button>`);
  return buttons.find(b => labelRe.test(b));
}

function isDisabled(label) {
  const btn = actionButton(label);
  return !!btn && btn.includes('disabled');
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
  harness.hold = null;
  harness.diffRenders = [];
  harness.diffRequests = [];
  harness.diffError = null;
  harness.diffResult = {
    path: 'lib/git.js',
    hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: '=', content: 'a' }, { type: '+', content: 'b' }] }],
    stats: { added: 1, removed: 0 },
  };
  harness.diffShas = [];
  harness.logRequests = [];
  harness.logError = null;
  harness.detailRequests = [];
  harness.detailError = null;
  harness.logPages = [{
    commits: [
      { sha: 'abc1234', subject: 'Add a thing', author: 'Pavel', when: '2 hours ago', refs: ['HEAD -> main', 'origin/main'], isMerge: false },
      { sha: 'def5678', subject: 'Merge branch side', author: 'Pavel', when: '3 hours ago', refs: [], isMerge: true },
    ],
    done: true,
  }];
  harness.commitDetail = {
    sha: 'abc1234full', author: 'Pavel', email: 'p@example.com', date: 'Tue Aug 19 2026',
    when: '2 hours ago', subject: 'Add a thing', body: 'the body of the message',
    files: [{ status: 'M', path: 'lib/git.js' }, { status: 'A', path: 'lib/new.js' }],
  };
  GitPanel._busy = null;
  GitPanel._pane = 'shell';
  GitPanel._diffPath = null;
  GitPanel._diffSha = null;
  GitPanel._log = null;
  GitPanel._openSha = null;
  GitPanel._commitDetail = null;
  harness.pushes = 0;
  harness.pulls = 0;
  harness.fetches = 0;
  harness.gitInfo = {
    available: true, branch: 'feature/x', detached: false, upstream: 'origin/main',
    ahead: 0, behind: 0, unpushed: [], files: [], hasRemote: true,
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

test('the Push button stays enabled for a first push, with no upstream to diff against', async () => {
  harness.gitInfo.upstream = null;
  harness.gitInfo.unpushed = [];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  const pushBtn = html.slice(html.indexOf('GitPanel.push()'));
  assert.ok(!/disabled/.test(pushBtn.slice(0, 60)), 'Push must stay usable to set the upstream');
});

test('Push is disabled with an upstream and nothing new to send', async () => {
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  const pushBtn = html.slice(html.indexOf('GitPanel.push()'));
  assert.match(pushBtn.slice(0, 60), /disabled/, 'nothing to push, so the button is off');
});

test('Push is disabled with no remote at all', async () => {
  harness.gitInfo.hasRemote = false;
  harness.gitInfo.upstream = null;
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  const pushBtn = html.slice(html.indexOf('GitPanel.push()'));
  assert.match(pushBtn.slice(0, 60), /disabled/, 'nowhere to push to');
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

test('tree is the default view and nests folders', async () => {
  harness.gitInfo.files = [{ path: 'public/js/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel.viewMode(), 'tree');
  assert.ok(el('git-changes').innerHTML.includes('git-tree-folder'), 'folders shown in tree view');
});

test('the view toggle appears with files and marks the active mode', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /git-view-toggle/);
  assert.match(html, /sf-mode-btn active[\s\S]*?setViewMode\('tree'\)/);
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
  assert.match(html, /data-path="public\/js\/git\.js"/, 'the row knows the full path');
  assert.match(html, />git\.js<\/button>/, 'but shows only the basename');
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

test('an unknown stored view mode falls back to tree', async () => {
  harness.store[GitPanel.VIEW_MODE_KEY] = 'nonsense';
  await GitPanel.mount(HOST, 'proj');
  assert.strictEqual(GitPanel.viewMode(), 'tree');
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

// ── in-flight feedback ───────────────────────────────────────────────────────
// A push can sit for seconds against a slow remote. Without this the only sign anything happened
// was the toast at the end, and nothing stopped a second push being fired in the meantime.

async function mountWithWork() {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  harness.gitInfo.ahead = 1;
  harness.gitInfo.unpushed = [{ sha: 'abc1234', subject: 'Something' }];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();
  el('git-panel-msg').value = 'a message';
}

test('a push in flight says so on its own button', async () => {
  await mountWithWork();
  const release = holdAction();

  const pending = GitPanel.push();
  const html = el('git-changes-actions').innerHTML;
  assert.match(html, /Pushing…/);
  assert.match(html, /btn-spinner/, 'a spinner shows it is working');
  assert.match(html, /aria-busy="true"/);

  release();
  await pending;
  assert.match(el('git-changes-actions').innerHTML, /Push \(1\)/, 'the label comes back');
  assert.ok(!el('git-changes-actions').innerHTML.includes('Pushing…'));
});

test('a commit in flight says Committing', async () => {
  await mountWithWork();
  const release = holdAction();

  const pending = GitPanel.commit(false);
  assert.match(el('git-changes-actions').innerHTML, /Committing…/);

  release();
  await pending;
  assert.match(el('git-changes-actions').innerHTML, />Commit</);
});

test('commit and push names both stages while it runs', async () => {
  await mountWithWork();
  const release = holdAction();

  const pending = GitPanel.commit(true);
  assert.match(el('git-changes-actions').innerHTML, /Committing &amp; pushing…|Committing & pushing…/);

  release();
  await pending;
});

test('every action is disabled while one is in flight', async () => {
  await mountWithWork();
  const release = holdAction();

  const pending = GitPanel.push();
  const html = el('git-changes-actions').innerHTML;
  assert.strictEqual((html.match(/disabled/g) || []).length, 3, 'all three buttons are disabled');

  release();
  await pending;
  const after = el('git-changes-actions').innerHTML;
  assert.ok(!after.includes('disabled'), 'and all three are usable again');
});

test('a second push while one is running is ignored', async () => {
  await mountWithWork();
  const release = holdAction();

  const pending = GitPanel.push();
  await GitPanel.push();
  await GitPanel.commit(false);

  assert.strictEqual(harness.pushes, 1, 'no double push');
  assert.strictEqual(harness.commits.length, 0, 'and no commit slipped in either');

  release();
  await pending;
});

test('the buttons recover after a failing action', async () => {
  await mountWithWork();
  harness.hold = { promise: Promise.reject(new Error('remote rejected')), release() {} };

  await assert.rejects(() => GitPanel.push(), /remote rejected/);
  assert.strictEqual(GitPanel._busy, null, 'the panel is not stuck busy');
  assert.ok(!el('git-changes-actions').innerHTML.includes('Pushing…'));
  assert.ok(!el('git-changes-actions').innerHTML.includes('disabled'));
});

test('an action can be started again once the first finished', async () => {
  await mountWithWork();
  const release = holdAction();
  const pending = GitPanel.push();
  release();
  await pending;

  harness.hold = null;
  await GitPanel.push();
  assert.strictEqual(harness.pushes, 2);
});

test('a rejected commit message never enters the busy state', async () => {
  await mountWithWork();
  el('git-panel-msg').value = '   ';
  GitPanel.commit(false);

  assert.strictEqual(GitPanel._busy, null);
  assert.ok(!el('git-changes-actions').innerHTML.includes('Committing…'));
  assert.strictEqual(harness.commits.length, 0);
});

test('each action is disabled only when it has nothing to do', async () => {
  await GitPanel.mount(HOST, 'proj');
  // the first paint comes from the card, before any action has repainted a row on its own
  const html = el('git-changes').innerHTML;

  assert.ok(html.length > 0, 'the card rendered');
  assert.ok(isDisabled('Commit'), 'nothing staged, so no commit');
  assert.ok(isDisabled('Push'), 'nothing ahead, so no push');
  assert.ok(isDisabled('Pull'), 'nothing behind, so no pull');
  assert.ok(!isDisabled('Fetch'), 'fetch is how being behind stops being stale, so it stays live');
  assert.ok(!html.includes('btn-spinner'), 'and nothing is spinning');
});

// ── pull and fetch ───────────────────────────────────────────────────────────
// The card told you to pull before pushing and then offered no way to do it. Fetch is what makes
// "behind" stop being stale, so it stays available whenever there is a remote at all.

test('fetch is offered whenever there is a remote, even with nothing behind', async () => {
  await GitPanel.mount(HOST, 'proj');
  assert.ok(actionButton('Fetch'), 'the button exists');
  assert.strictEqual(isDisabled('Fetch'), false);
});

test('fetch is disabled for a repo with no remote', async () => {
  harness.gitInfo.hasRemote = false;
  harness.gitInfo.upstream = null;
  await GitPanel.mount(HOST, 'proj');
  assert.strictEqual(isDisabled('Fetch'), true);
});

test('pull is offered only when the branch is behind, and carries the count', async () => {
  await GitPanel.mount(HOST, 'proj');
  assert.strictEqual(isDisabled('Pull'), true, 'nothing to fast-forward over');

  harness.gitInfo.behind = 3;
  await GitPanel.refreshIfMounted();
  assert.strictEqual(isDisabled('Pull'), false);
  assert.match(el('git-changes').innerHTML, /Pull \(3\)/);
});

test('being behind shows both arrows in the To push header', async () => {
  harness.gitInfo.ahead = 2;
  harness.gitInfo.behind = 3;
  await GitPanel.mount(HOST, 'proj');

  const html = el('git-changes').innerHTML;
  assert.match(html, /↑2/);
  assert.match(html, /↓3/);
});

test('pull runs through GitActions and reports progress on its button', async () => {
  harness.gitInfo.behind = 2;
  await GitPanel.mount(HOST, 'proj');
  const release = holdAction();

  const pending = GitPanel.pull();
  assert.match(el('git-sync-actions').innerHTML, /Pulling…/);
  assert.match(el('git-sync-actions').innerHTML, /btn-spinner/);

  release();
  await pending;
  assert.strictEqual(harness.pulls, 1);
  assert.ok(!el('git-sync-actions').innerHTML.includes('Pulling…'));
});

test('fetch runs through GitActions and reports progress on its button', async () => {
  await GitPanel.mount(HOST, 'proj');
  const release = holdAction();

  const pending = GitPanel.fetch();
  assert.match(el('git-sync-actions').innerHTML, /Fetching…/);

  release();
  await pending;
  assert.strictEqual(harness.fetches, 1);
});

test('a pull in flight disables the commit row too', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  harness.gitInfo.behind = 1;
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();
  const release = holdAction();

  const pending = GitPanel.pull();
  assert.strictEqual(isDisabled('Commit'), true, 'no committing mid-pull');
  assert.strictEqual(isDisabled('Fetch'), true, 'and no second remote call');

  release();
  await pending;
  assert.strictEqual(isDisabled('Commit'), false);
});

test('a fetch while a commit runs is ignored', async () => {
  harness.gitInfo.files = [{ path: 'a.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  syncCheckboxes();
  el('git-panel-msg').value = 'a message';
  const release = holdAction();

  const pending = GitPanel.commit(false);
  await GitPanel.fetch();
  assert.strictEqual(harness.fetches, 0);

  release();
  await pending;
});

// ── diff in the middle column ─────────────────────────────────────────────────
// No dialog: the diff shares the middle column with the shell, and switching between them must not
// destroy either. Clicking a file name opens it; the checkbox beside it still only ticks.

async function mountWithFiles() {
  harness.gitInfo.files = [
    { path: 'lib/git.js', label: 'modified' },
    { path: 'new.js', label: 'untracked' },
  ];
  await GitPanel.mount(HOST, 'proj');
}

test('the panel opens on the shell, not the diff', async () => {
  await mountWithFiles();
  assert.strictEqual(GitPanel._pane, 'shell');
  assert.ok(!el('git-workspace').classList.contains('showing-diff'));
  assert.match(el(HOST).innerHTML, /Click a changed file/, 'the diff pane explains itself');
});

test('clicking a file name asks for that file and renders its diff', async () => {
  await mountWithFiles();
  await GitPanel.openDiff('lib/git.js');

  assert.deepStrictEqual(harness.diffRequests, ['lib/git.js']);
  assert.strictEqual(harness.diffRenders.length, 1);
  assert.strictEqual(harness.diffRenders[0].filePath, 'lib/git.js');
  assert.strictEqual(el('git-diff-body').innerHTML, 'DIFF:lib/git.js:+1-0');
});

test('opening a diff switches the pane and names the file in the header', async () => {
  await mountWithFiles();
  await GitPanel.openDiff('lib/git.js');

  assert.strictEqual(GitPanel._pane, 'diff');
  assert.ok(el('git-workspace').classList.contains('showing-diff'));
  assert.strictEqual(el('git-pane-subject').textContent, 'lib/git.js');
  assert.ok(el('git-pane-tab-diff').classList.contains('active'));
  assert.ok(!el('git-pane-tab-shell').classList.contains('active'));
});

test('a diff never disposes the terminal behind it', async () => {
  await mountWithFiles();
  GitPanel.openShell();
  await GitPanel.openDiff('lib/git.js');

  assert.strictEqual(harness.termDisposed, 0, 'the shell survives');
  assert.strictEqual(GitPanel.shellOpen(), true);
});

test('switching back to the shell restores it and refits the pty', async () => {
  await mountWithFiles();
  GitPanel.openShell();
  harness.ws.readyState = 1;
  await GitPanel.openDiff('lib/git.js');
  harness.sent.length = 0;

  GitPanel.showPane('shell');

  assert.strictEqual(GitPanel._pane, 'shell');
  assert.ok(!el('git-workspace').classList.contains('showing-diff'));
  assert.deepStrictEqual(harness.sent, [{ t: 'r', c: 80, r: 24 }], 'the pty learns its size again');
  assert.strictEqual(el('git-pane-subject').textContent, 'feature/x', 'the header goes back to the branch');
});

test('the shell pane needs no resize when there is no shell', async () => {
  await mountWithFiles();
  GitPanel.showPane('shell');
  assert.deepStrictEqual(harness.sent, []);
});

test('a failed diff is reported in the pane, not thrown away', async () => {
  await mountWithFiles();
  harness.diffError = 'fatal: bad object';
  await GitPanel.openDiff('lib/git.js');

  assert.match(el('git-diff-body').innerHTML, /Could not diff lib\/git\.js/);
  assert.match(el('git-diff-body').innerHTML, /bad object/);
  assert.strictEqual(harness.diffRenders.length, 0, 'the renderer is not handed an error');
});

test('a binary file says so instead of rendering bytes', async () => {
  await mountWithFiles();
  harness.diffResult = { path: 'logo.png', binary: true, hunks: [], stats: { added: 0, removed: 0 } };
  await GitPanel.openDiff('logo.png');

  assert.match(el('git-diff-body').innerHTML, /logo\.png is a binary file/);
  assert.strictEqual(harness.diffRenders.length, 0);
});

test('a slow diff that lands after a newer click is discarded', async () => {
  await mountWithFiles();
  const first = GitPanel.openDiff('lib/git.js');
  GitPanel._diffPath = 'new.js';           // as if the user clicked the other file meanwhile
  await first;

  assert.strictEqual(harness.diffRenders.length, 0, 'the stale result is dropped');
});

test('the diff pane survives a panel re-render', async () => {
  await mountWithFiles();
  await GitPanel.openDiff('lib/git.js');
  harness.diffRenders = [];
  harness.diffRequests = [];

  await GitPanel.mount(HOST, 'proj');

  assert.strictEqual(GitPanel._pane, 'diff');
  assert.deepStrictEqual(harness.diffRequests, ['lib/git.js'], 'the open file is re-diffed');
});

test('a file name is a button, and the checkbox is still the only toggle', async () => {
  await mountWithFiles();
  const html = el('git-changes').innerHTML;

  assert.match(html, /<button class="git-file-path git-file-link"/);
  assert.ok(!html.includes('<label'), 'no label anywhere in the list');
  assert.match(html, /class="git-file-cb"[^>]*checked/);
});

test('a path containing quotes stays intact in every attribute', async () => {
  harness.gitInfo.files = [{ path: `od'd "quoted".js`, label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  const html = el('git-changes').innerHTML;

  assert.match(html, /data-path="od&#39;d &quot;quoted&quot;\.js"/, 'quotes are escaped, not left to end the attribute');
  assert.ok(!/data-path="[^"]*"[^>]*"quoted"/.test(html), 'the attribute is not broken open');
});

test('a recipe containing quotes keeps them inside its attribute', async () => {
  await mountWithFiles();
  GitPanel.openShell();
  const html = el('git-recipes').innerHTML;

  assert.match(html, /data-cmd="git commit -m &quot;[^"]*&quot;"/,
    'git commit -m "<message>" must survive as one attribute value');
});

// ── history pane ─────────────────────────────────────────────────────────────
// The third pane of the middle column. Reading history costs a git call, so it is fetched on first
// view rather than on mount, and dropped after a commit rather than kept stale.

test('history is not read until the tab is opened', async () => {
  await GitPanel.mount(HOST, 'proj');
  assert.strictEqual(harness.logRequests.length, 0, 'mounting reads no history');

  GitPanel.showPane('history');
  await Promise.resolve();
  assert.deepStrictEqual(harness.logRequests, [{ limit: GitPanel.LOG_PAGE, offset: 0 }]);
});

test('opening the tab twice does not re-read what is already loaded', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  GitPanel.showPane('shell');
  GitPanel.showPane('history');

  assert.strictEqual(harness.logRequests.length, 1);
});

test('commits render with their sha, subject, author and age', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();

  const html = el('git-history-body').innerHTML;
  assert.match(html, /abc1234/);
  assert.match(html, /Add a thing/);
  assert.match(html, /Pavel/);
  assert.match(html, /2 hours ago/);
});

test('refs and merges are marked', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();

  const html = el('git-history-body').innerHTML;
  assert.match(html, /git-commit-ref">HEAD -&gt; main/, 'branch and tag names are shown');
  assert.match(html, /git-commit-merge/, 'a merge is flagged without ASCII art');
});

test('an empty repository says so', async () => {
  harness.logPages = [{ commits: [], done: true }];
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();

  assert.match(el('git-history-body').innerHTML, /No commits yet/);
});

test('a failed history read is reported in the pane', async () => {
  harness.logError = 'fatal: not a git repository';
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();

  assert.match(el('git-history-body').innerHTML, /Could not read history/);
  assert.match(el('git-history-body').innerHTML, /not a git repository/);
});

test('Load more appends the next page and disappears at the end', async () => {
  harness.logPages = [
    { commits: [{ sha: 'aaa1111', subject: 'first page', author: 'p', when: '1 day ago', refs: [], isMerge: false }], done: false },
    { commits: [{ sha: 'bbb2222', subject: 'second page', author: 'p', when: '2 days ago', refs: [], isMerge: false }], done: true },
  ];
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  assert.match(el('git-history-body').innerHTML, /Load more/);

  await GitPanel.loadLog(true);

  const html = el('git-history-body').innerHTML;
  assert.match(html, /first page/);
  assert.match(html, /second page/);
  assert.ok(!html.includes('Load more'), 'nothing left to load');
  assert.deepStrictEqual(harness.logRequests[1], { limit: GitPanel.LOG_PAGE, offset: 1 }, 'paged from what it has');
});

test('clicking a commit loads its detail and lists the files it touched', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  await GitPanel.openCommit('abc1234');

  assert.deepStrictEqual(harness.detailRequests, ['abc1234']);
  const html = el('git-history-body').innerHTML;
  assert.match(html, /git-commit-detail/);
  assert.match(html, /lib\/git\.js/);
  assert.match(html, />modified</);
  assert.match(html, /the body of the message/);
});

test('clicking the open commit again collapses it', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  await GitPanel.openCommit('abc1234');
  await GitPanel.openCommit('abc1234');

  assert.strictEqual(GitPanel._openSha, null);
  assert.ok(!el('git-history-body').innerHTML.includes('git-commit-detail'));
});

test('a commit whose detail fails to load says so in place', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  harness.detailError = 'bad object';
  await GitPanel.openCommit('abc1234');

  assert.match(el('git-history-body').innerHTML, /Could not read abc1234/);
});

test('a detail that lands after another commit was opened is discarded', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  const pending = GitPanel.openCommit('abc1234');
  GitPanel._openSha = 'def5678';
  await pending;

  assert.strictEqual(GitPanel._commitDetail, null, 'the stale detail is not shown');
});

test('a file in a commit opens that commit’s diff, not the working tree', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  await GitPanel.openCommit('abc1234');
  await GitPanel.openDiff('lib/git.js', 'abc1234full');

  assert.deepStrictEqual(harness.diffRequests, ['lib/git.js']);
  assert.deepStrictEqual(harness.diffShas, ['abc1234full']);
  assert.strictEqual(GitPanel._pane, 'diff');
  assert.strictEqual(el('git-pane-subject').textContent, 'abc1234full · lib/git.js');
});

test('a working-tree diff carries no sha and titles itself with the path alone', async () => {
  harness.gitInfo.files = [{ path: 'lib/git.js', label: 'modified' }];
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.openDiff('lib/git.js');

  assert.deepStrictEqual(harness.diffShas, [undefined]);
  assert.strictEqual(el('git-pane-subject').textContent, 'lib/git.js');
});

test('committing drops the loaded history so it cannot go stale', async () => {
  await GitPanel.mount(HOST, 'proj');
  await GitPanel.loadLog();
  await GitPanel.openCommit('abc1234');

  await GitPanel.refreshIfMounted();

  assert.strictEqual(GitPanel._log, null, 'history is dropped');
  assert.strictEqual(GitPanel._openSha, null, 'and so is the expanded commit');
});

test('history is re-read immediately when it is the visible pane', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.showPane('history');
  await GitPanel.loadLog();
  harness.logRequests = [];

  await GitPanel.refreshIfMounted();
  await Promise.resolve();

  assert.strictEqual(harness.logRequests.length, 1, 'the visible pane is refilled at once');
});

test('only one pane is marked active at a time', async () => {
  await GitPanel.mount(HOST, 'proj');
  for (const pane of ['shell', 'diff', 'history']) {
    GitPanel.showPane(pane);
    const active = ['shell', 'diff', 'history'].filter(p => el(`git-pane-tab-${p}`).classList.contains('active'));
    assert.deepStrictEqual(active, [pane]);
    assert.ok(el('git-workspace').classList.contains(`showing-${pane}`));
  }
});

test('an unknown pane name falls back to the shell', async () => {
  await GitPanel.mount(HOST, 'proj');
  GitPanel.showPane('nonsense');
  assert.strictEqual(GitPanel._pane, 'shell');
});

// ── git unavailable ──────────────────────────────────────────────────────────
// Two different problems: no git on the machine, or a directory that is not a repository. Telling
// the user the wrong one sends them looking in the wrong place.

test('a project that is not a repository says exactly that', async () => {
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: true, running: false }
    : { available: false, reason: 'not-a-repo' });
  await GitPanel.mount(HOST, 'proj');

  assert.match(el(HOST).innerHTML, /not a git repository/);
  assert.ok(!el(HOST).innerHTML.includes('not installed'));
});

test('a machine without git says so instead of blaming the project', async () => {
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: true, running: false }
    : { available: false, reason: 'git-missing' });
  await GitPanel.mount(HOST, 'proj');

  assert.match(el(HOST).innerHTML, /Git is not installed on this machine/);
});

test('an unavailable project offers no shell, recipes or actions at all', async () => {
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: true, running: false }
    : { available: false, reason: 'git-missing' });
  await GitPanel.mount(HOST, 'proj');

  const html = el(HOST).innerHTML;
  for (const absent of ['git-shell-host', 'git-recipes', 'git-changes-actions', 'Open Shell']) {
    assert.ok(!html.includes(absent), `${absent} must not be offered`);
  }
});

test('a missing reason still renders a sensible message', async () => {
  harness.apiHandler = url => (url.includes('terminal/info')
    ? { available: true, running: false }
    : { available: false });
  await GitPanel.mount(HOST, 'proj');

  assert.match(el(HOST).innerHTML, /not a git repository/, 'the older shape of the response still works');
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The git menu bar (Branch, Commit, Remote, Stash) and the branch picker it shares with the branch
// name. Contracts: an item is only runnable when the matching panel action would be; switching
// with uncommitted changes always asks (stash & switch, or bring along); picking the current branch
// does nothing; a remote branch is checked out as remote so the server creates the tracking branch.
const src = ['git-menu.js', 'git-branch-picker.js']
  .map(f => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf-8'))
  .join('\n');

const harness = {};

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    value: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
    },
    focus() {},
  };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

const panel = {
  _slug: 'proj',
  _info: null,
  _busy: null,
  _branchLabel() { return this._info.branch; },
  canPush() { return !!this._info.canPush; },
  commit(andPush) { harness.calls.push(['commit', andPush]); },
  push() { harness.calls.push(['push']); },
  pull() { harness.calls.push(['pull']); },
  fetch() { harness.calls.push(['fetch']); },
  _withBusy(kind, run) { harness.calls.push(['busy', kind]); return run(); },
};

const context = vm.createContext({
  document: {
    getElementById: id => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    activeElement: null,
  },
  window: {},
  escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'),
  escapeAttr: s => String(s).split('&').join('&amp;').split('"').join('&quot;'),
  formGroup: (label, html) => html,
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  openModal: opts => { harness.modals.push(opts); return {}; },
  GitPanel: panel,
  GitApi: {
    stashes: async () => ({ stashes: harness.stashes }),
    branches: async () => harness.branches,
  },
  GitActions: {
    checkout: (branch, remote, stash) => { harness.calls.push(['checkout', branch, remote, stash]); },
    createBranch: name => { harness.calls.push(['createBranch', name]); },
    stash: (message, untracked) => { harness.calls.push(['stash', message, untracked]); },
    stashOp: (op, ref) => { harness.calls.push(['stashOp', op, ref]); },
  },
});
vm.runInContext(src + '\nglobalThis._GitMenu = GitMenu; globalThis._Picker = GitBranchPicker;', context);
const GitMenu = context._GitMenu;
const Picker = context._Picker;

beforeEach(() => {
  harness.els = {};
  harness.calls = [];
  harness.toasts = [];
  harness.modals = [];
  harness.stashes = [];
  harness.branches = {
    local: [
      { name: 'main', upstream: 'origin/main', current: true },
      { name: 'feature/login', upstream: null, current: false },
    ],
    remote: [{ name: 'origin/fix/77', localName: 'fix/77' }],
  };
  panel._info = { branch: 'main', files: [], hasRemote: true, behind: 0, canPush: false };
  panel._busy = null;
  GitMenu._open = null;
  GitMenu._items = [];
  GitMenu._stashes = null;
  Picker._isOpen = false;
  Picker._branches = null;
  Picker._filter = '';
  Picker._hl = 0;
});

const itemIndex = label => GitMenu._items.findIndex(i => i.label === label);
const item = label => GitMenu._items[itemIndex(label)];
const flush = () => new Promise(resolve => setImmediate(resolve));

// ── menu bar ─────────────────────────────────────────────────────────────────

test('the bar renders every menu and the current branch', () => {
  GitMenu.render();
  const html = el('git-menubar-host').innerHTML;
  for (const name of ['Branch', 'Commit', 'Remote', 'Stash']) assert.match(html, new RegExp(`>${name}<`));
  assert.match(html, /git-branch-btn[\s\S]*main/);
});

test('only the open menu renders its items', () => {
  GitMenu.open('Branch');
  assert.match(el('git-menu-panel-Branch').innerHTML || el('git-menubar-host').innerHTML, /Switch branch…/);
  assert.ok(!el('git-menubar-host').innerHTML.includes('Commit &amp; Push'));
  GitMenu.toggle('Branch');
  assert.strictEqual(GitMenu._open, null);
});

test('Commit items are disabled with nothing to commit and do nothing when run', () => {
  GitMenu.open('Commit');
  assert.strictEqual(item('Commit').enabled, false);
  GitMenu.run(itemIndex('Commit'));
  assert.deepStrictEqual(harness.calls, []);
  assert.strictEqual(GitMenu._open, 'Commit', 'a disabled item leaves the menu open');
});

test('an enabled item closes the menu and runs the panel action', () => {
  panel._info.files = [{ path: 'a.js' }];
  GitMenu.open('Commit');
  GitMenu.run(itemIndex('Commit & Push'));
  assert.deepStrictEqual(harness.calls, [['commit', true]]);
  assert.strictEqual(GitMenu._open, null);
});

test('Remote items follow the remote state', () => {
  panel._info.behind = 3;
  GitMenu.open('Remote');
  assert.strictEqual(item('Fetch').enabled, true);
  assert.strictEqual(item('Pull (3)').enabled, true);
  assert.strictEqual(item('Push').enabled, false);
});

test('every action item is disabled while another git action runs', () => {
  panel._info.files = [{ path: 'a.js' }];
  panel._busy = 'push';
  for (const name of ['Commit', 'Remote', 'Stash']) {
    GitMenu.open(name);
    for (const it of GitMenu._items.filter(i => i.action)) assert.strictEqual(it.enabled, false, `${name} › ${it.label}`);
  }
});

test('hovering another title switches menus only while one is open', () => {
  GitMenu.hover('Remote');
  assert.strictEqual(GitMenu._open, null);
  GitMenu.open('Branch');
  GitMenu.hover('Remote');
  assert.strictEqual(GitMenu._open, 'Remote');
});

// ── stash menu ───────────────────────────────────────────────────────────────

test('Stash lists entries, each with Apply / Pop / Drop', async () => {
  harness.stashes = [{ ref: 'stash@{0}', message: 'On main: wip', when: '2 hours ago' }];
  panel._info.files = [{ path: 'a.js' }];
  GitMenu.open('Stash');
  await flush();

  const entry = GitMenu._items.find(i => i.submenu);
  assert.strictEqual(entry.label, 'stash@{0}  On main: wip');
  assert.match(el('git-menubar-host').innerHTML, /Apply[\s\S]*Pop[\s\S]*Drop…/);

  GitMenu.run(itemIndex('Pop'));
  assert.deepStrictEqual(harness.calls, [['busy', 'stash'], ['stashOp', 'pop', 'stash@{0}']]);
});

test('Stash says so when there is nothing stashed, and stashing needs changes', async () => {
  GitMenu.open('Stash');
  await flush();
  assert.ok(GitMenu._items.some(i => i.label === 'No stashes' && i.enabled === false));
  assert.strictEqual(item('Stash changes…').enabled, false);
});

test('Drop asks for confirmation before dropping', async () => {
  harness.stashes = [{ ref: 'stash@{1}', message: 'old', when: 'x' }];
  GitMenu.open('Stash');
  await flush();
  GitMenu.run(itemIndex('Drop…'));

  assert.deepStrictEqual(harness.calls, [], 'nothing dropped yet');
  const modal = harness.modals.pop();
  assert.match(modal.body, /stash@\{1\}/);
  modal.buttons[0].onClick();
  assert.deepStrictEqual(harness.calls, [['busy', 'stash'], ['stashOp', 'drop', 'stash@{1}']]);
});

test('the stash dialog passes its message and the untracked choice', () => {
  GitMenu.stashDialog(true);
  el('git-stash-message').value = '  my label ';
  harness.modals.pop().buttons[0].onClick();
  assert.deepStrictEqual(harness.calls.pop(), ['stash', 'my label', true]);
});

test('New branch requires a name', () => {
  GitMenu.newBranch();
  const modal = harness.modals.pop();
  el('git-new-branch-name').value = '  ';
  assert.strictEqual(modal.buttons[0].onClick(), false, 'the dialog stays open');
  assert.strictEqual(harness.toasts.pop().type, 'error');

  el('git-new-branch-name').value = 'feature/new';
  modal.buttons[0].onClick();
  assert.deepStrictEqual(harness.calls.pop(), ['createBranch', 'feature/new']);
});

// ── branch picker ────────────────────────────────────────────────────────────

test('the picker lists local then remote branches, current marked', async () => {
  await Picker.open();
  const html = el('git-branch-list').innerHTML;
  assert.ok(html.indexOf('Local') < html.indexOf('feature/login'));
  assert.ok(html.indexOf('Remote') < html.indexOf('origin/fix/77'));
  assert.match(html, /creates fix\/77/);
  assert.match(html, /current/);
});

test('filtering is case-insensitive and spans local and remote', async () => {
  await Picker.open();
  Picker.setFilter('FIX');
  assert.deepStrictEqual(Picker._matches().map(m => m.name), ['origin/fix/77']);
  assert.ok(!el('git-branch-list').innerHTML.includes('Local'));
  Picker.setFilter('nothing-like-this');
  assert.match(el('git-branch-list').innerHTML, /No matching branches/);
});

test('arrow keys move the highlight and Enter switches to it on a clean tree', async () => {
  await Picker.open();
  const key = k => Picker.onKey({ key: k, preventDefault() {} });
  key('ArrowDown');
  assert.strictEqual(Picker._hl, 1);
  key('ArrowUp');
  key('ArrowUp');
  assert.strictEqual(Picker._hl, 2, 'wraps around');
  key('Enter');
  assert.deepStrictEqual(harness.calls, [['busy', 'checkout'], ['checkout', 'origin/fix/77', true, false]]);
  assert.strictEqual(Picker._isOpen, false);
});

test('picking the current branch does nothing', async () => {
  await Picker.open();
  Picker.pick(0);
  assert.deepStrictEqual(harness.calls, []);
  assert.deepStrictEqual(harness.modals, []);
});

test('with uncommitted changes a switch asks: bring them along or stash & switch', async () => {
  panel._info.files = [{ path: 'a.js' }, { path: 'b.js' }];
  await Picker.open();
  Picker.pick(1);

  assert.deepStrictEqual(harness.calls, [], 'nothing runs before the user chooses');
  const modal = harness.modals.pop();
  assert.match(modal.body, /2 changed files/);
  const byLabel = Object.fromEntries(modal.buttons.map(b => [b.label, b]));

  byLabel['Bring changes along'].onClick();
  assert.deepStrictEqual(harness.calls.pop(), ['checkout', 'feature/login', false, false]);
  byLabel['Stash & switch'].onClick();
  assert.deepStrictEqual(harness.calls.pop(), ['checkout', 'feature/login', false, true]);
});

test('opening the picker closes an open menu, and opening a menu closes the picker', async () => {
  GitMenu.open('Branch');
  await Picker.open();
  assert.strictEqual(GitMenu._open, null);
  GitMenu.open('Stash');
  assert.strictEqual(Picker._isOpen, false);
});

test('a failed branch read is reported and closes the picker', async () => {
  context.GitApi.branches = async () => { throw new Error('boom'); };
  try {
    await Picker.open();
  } finally {
    context.GitApi.branches = async () => harness.branches;
  }
  assert.strictEqual(Picker._isOpen, false);
  assert.match(harness.toasts.pop().msg, /boom/);
});

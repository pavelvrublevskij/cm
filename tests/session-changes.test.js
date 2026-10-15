const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load sessions.js + session-context.js + session-changes.js in a sandbox to assert the Files tab's
// "By prompt" grouping, the "From prompt" filter, search-term highlighting and the "Changes only" view.
const src = ['sessions.js', 'session-context.js', 'session-changes.js']
  .map(f => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf-8')).join('\n');

const harness = { els: {}, rows: [], diffCalls: [], rendered: [], opened: null, paneRenders: 0 };

function makeEl(id) {
  return { id, innerHTML: '', style: {}, dataset: {}, classList: { toggle() {} }, querySelectorAll: () => [], scrollIntoView() { harness.scrolled = id; } };
}
function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

const context = vm.createContext({
  localStorage: { getItem: () => null, setItem: () => {} },
  document: {
    addEventListener: () => {},
    getElementById: id => el(id),
    querySelector: () => null,
    querySelectorAll: sel => (sel === '#ctx-file-list .ctx-file-item' ? harness.rows : []),
  },
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: fn => fn(),
  api: async () => ({}),
  escapeHtml: s => String(s),
  escapeAttr: s => String(s),
  debounce: fn => fn,
  toast: () => {},
  timeAgo: () => '1m ago',
  showLoading: () => {},
  FileHistory: {
    fetchDiffCurrent: async (...args) => { harness.diffCalls.push(args); return { hunks: [], stats: { added: 2, removed: 1 } }; },
    renderDiff: (body, result, filePath, opts) => { harness.rendered.push({ filePath, compact: opts.compact }); },
  },
  SessionFiles: {
    open: null,
    treeLoaded: false,
    setChangedPaths: () => {},
    openFile: (p, opts) => { harness.opened = { p, opts }; context.SessionChanges.leave(); },
    gotoSource: () => {},
    renderPane: () => { harness.paneRenders++; },
    _canDiff: ctx => !!ctx && (ctx.isNew === '1' || !!ctx.hash || ctx.readBase === '1'),
    scriptsHtml: scripts => 'SCRIPTS:' + scripts.map(sc => sc.command).join('|'),
  },
  App: { navigate: () => {}, setHash: () => {} },
  TerminalPanel: { isOpen: () => false, shouldAutoOpen: () => false },
});
vm.runInContext(src + '\nglobalThis._Sessions = Sessions; globalThis.SessionChanges = SessionChanges;', context);
const Sessions = context._Sessions;
const SessionChanges = context.SessionChanges;

function file(p, prompts, extra = {}) {
  return { path: p, hash: 'h', versions: [1], isNew: false, isDeleted: false, readBase: false, mtime: 1, prompts, ...extra };
}

const PROMPTS = [
  { index: 1, text: 'first', timestamp: null },
  { index: 2, text: 'second', timestamp: null },
  { index: 3, text: 'third', timestamp: null },
];

function setCtx(files, extra = {}) {
  Sessions._ctx = { sessionId: 's1', projSlug: 'proj', files, plans: [], prompts: PROMPTS, fromPrompt: 0, sort: 'default', ...extra };
  harness.rows = Sessions._ctxListedFiles().map(f => ({ dataset: { path: f.path } }));
}

beforeEach(() => {
  harness.els = {};
  harness.rows = [];
  harness.diffCalls = [];
  harness.rendered = [];
  harness.opened = null;
  harness.paneRenders = 0;
  Sessions._ctxCollapsed = new Set();
  SessionChanges.active = false;
});

test('By prompt: one group per prompt in order, file repeated under each prompt that touched it', () => {
  setCtx([file('src/a.js', [1, 3]), file('src/b.js', [3]), file('c.js', [])], { sort: 'prompt' });
  const html = Sessions._renderCtxFileList();
  const groups = [...html.matchAll(/ctx-prompt-index">#(\d+)/g)].map(m => m[1]);
  assert.deepStrictEqual(groups, ['1', '3']);
  assert.strictEqual((html.match(/data-path="src\/a.js"/g) || []).length, 2);
  assert.ok(html.includes('Not linked to a prompt'), 'files with no prompt get their own group');
  assert.ok(html.indexOf('Not linked') > html.indexOf('#3'), 'unlinked group comes last');
});

test('From prompt: lists only files touched at or after the chosen prompt', () => {
  setCtx([file('a.js', [1]), file('b.js', [2]), file('c.js', [1, 3]), file('d.js', [])]);
  Sessions.setCtxFromPrompt('2');
  assert.deepStrictEqual(Sessions._ctxListedFiles().map(f => f.path), ['b.js', 'c.js']);
  Sessions.setCtxFromPrompt('0');
  assert.strictEqual(Sessions._ctxListedFiles().length, 4);
});

test('From prompt picker offers only prompts that changed files', () => {
  setCtx([file('a.js', [3])]);
  const html = Sessions._ctxPromptFilterHtml();
  assert.ok(html.includes('value="3"'));
  assert.ok(!html.includes('value="1"'));
  setCtx([file('a.js', [])]);
  assert.strictEqual(Sessions._ctxPromptFilterHtml(), '');
});

test('renderContext keeps the From prompt pick across a poll re-render of the same session', () => {
  setCtx([file('a.js', [1]), file('b.js', [2])], { fromPrompt: 2 });
  Sessions.renderContext(el('sf-changed'), 's1', { files: Sessions._ctx.files, plans: [], prompts: PROMPTS, projSlug: 'proj' });
  assert.strictEqual(Sessions._ctx.fromPrompt, 2);
  Sessions.renderContext(el('sf-changed'), 's2', { files: Sessions._ctx.files, plans: [], prompts: PROMPTS, projSlug: 'proj' });
  assert.strictEqual(Sessions._ctx.fromPrompt, 0, 'a different session starts unfiltered');
});

test('parseSearchTerms + _snippetTerm: filter snippets highlight their own value, others the free text', () => {
  Sessions._lastQuery = 'widget f:parser t:Bash';
  assert.strictEqual(Sessions._snippetTerm({ role: 'meta', label: 'file', text: 'src/parser.js' }), 'parser');
  assert.strictEqual(Sessions._snippetTerm({ role: 'meta', label: 'tool', text: 'Bash ×2' }), 'Bash');
  assert.strictEqual(Sessions._snippetTerm({ role: 'user', label: '', text: 'a widget here' }), 'widget');
  Sessions._lastQuery = '';
});

test('Changes only: renders one compact diff per listed file, each file once, in list order', async () => {
  setCtx([file('b.js', [1]), file('a.js', [1], { isNew: true, hash: null }), file('gone.js', [1], { hash: null })]);
  harness.rows.push({ dataset: { path: 'b.js' } });
  SessionChanges.active = true;
  await SessionChanges.render();
  assert.deepStrictEqual(harness.rendered.map(r => r.filePath), ['b.js', 'a.js']);
  assert.ok(harness.rendered.every(r => r.compact));
  assert.strictEqual(harness.diffCalls[1][5].isNew, true);
  assert.ok(el('sc-body-2').innerHTML.includes('No recorded snapshot'), 'a file without a diff says so');
  assert.ok(el('sc-totals').innerHTML.includes('+4'), 'totals sum the diffable files');
  assert.strictEqual((el('sf-pane').innerHTML.match(/class="sc-file"/g) || []).length, 3);
});

test('Changes only: a file edited only by shell commands shows those commands instead of a diff', async () => {
  setCtx([file('App.java', [1], { hash: null, scripts: [{ tool: 'Bash', command: 'python fix.py', prompt: 1 }] })]);
  SessionChanges.active = true;
  await SessionChanges.render();
  assert.strictEqual(harness.diffCalls.length, 0);
  assert.strictEqual(el('sc-body-0').innerHTML, 'SCRIPTS:python fix.py');
  assert.ok(el('sf-pane').innerHTML.includes('edited by script'));
});

test('changed-file list labels a snapshot-less shell edit as edited by script', () => {
  setCtx([
    file('App.java', [1], { hash: null, scripts: [{ tool: 'Bash', command: 'sed -i s/a/b/ App.java' }] }),
    file('a.js', [1], { scripts: [{ tool: 'Bash', command: 'sed -i s/a/b/ a.js' }] })
  ]);
  const html = Sessions._renderCtxFileList();
  assert.strictEqual((html.match(/ctx-file-badge-script/g) || []).length, 1, 'a file with a diff keeps its normal badge');
  assert.ok(html.includes('edited by script'));
});

test('Changes only: toggle off hands the pane back to the single-file view', () => {
  setCtx([file('a.js', [1])]);
  SessionChanges.active = true;
  SessionChanges.toggle();
  assert.strictEqual(SessionChanges.active, false);
  assert.strictEqual(harness.paneRenders, 1);
});

test('Changes only: a changed-file row click scrolls to its diff instead of opening it', () => {
  setCtx([file('a.js', [1])]);
  SessionChanges.active = true;
  const block = { dataset: { path: 'a.js' }, scrollIntoView() { harness.scrolledTo = 'a.js'; } };
  context.document.querySelectorAll = sel => (sel === '#sf-pane .sc-file' ? [block] : sel === '#ctx-file-list .ctx-file-item' ? harness.rows : []);
  Sessions._openCtxRow({ dataset: { path: 'a.js' } });
  assert.strictEqual(harness.scrolledTo, 'a.js');
  assert.strictEqual(harness.opened, null);
});

test('Changes only: opening a file from the combined view leaves it', () => {
  setCtx([file('a.js', [1])]);
  SessionChanges.active = true;
  SessionChanges.openSource('a.js');
  assert.strictEqual(harness.opened.p, 'a.js');
  assert.strictEqual(harness.opened.opts.mode, 'source');
  assert.strictEqual(SessionChanges.active, false);
});

test('search hints: an empty box shows the filter hints even with no history', () => {
  el('session-search-input').value = '';
  Sessions._renderHistoryDropdown('proj');
  const dropdown = el('search-history-dropdown');
  assert.strictEqual(dropdown.style.display, 'block');
  for (const p of ['n:', 'f:', 't:', 'b:']) assert.ok(dropdown.innerHTML.includes(`data-prefix="${p}"`));
  assert.ok(!dropdown.innerHTML.includes('Clear history'), 'no clear button without history');
});

test('search hints: hidden once the box holds a query', () => {
  el('session-search-input').value = 'widget';
  Sessions._renderHistoryDropdown('proj');
  assert.strictEqual(el('search-history-dropdown').style.display, 'none');
});

test('search hints: a click types the prefix, appending after existing text', () => {
  const input = el('session-search-input');
  input.focus = () => {};
  input.value = '';
  Sessions._applySearchHint({ preventDefault() {} }, 'proj', 'f:');
  assert.strictEqual(input.value, 'f:');
  input.value = 'widget ';
  Sessions._applySearchHint({ preventDefault() {} }, 'proj', 't:');
  assert.strictEqual(input.value, 'widget t:');
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load code-view.js + session-scratchpad.js in a browser-like sandbox so the Scratchpad tab's
// split layout and read-only pane can be asserted without a browser.
const src = fs.readFileSync(path.join(__dirname, '../public/js/code-view.js'), 'utf-8')
  + '\nconst Sessions = { detailState: { slug: :SLUG:, sessionId: :SID: }, toggleActionMenu() {} };\n'.replace(':SLUG:', "'proj'").replace(':SID:', "'s1'")
  + fs.readFileSync(path.join(__dirname, '../public/js/session-scratchpad.js'), 'utf-8');

const harness = {
  store: {},
  els: {},
  apiCalls: [],
  apiHandler: null,
  cm: null,
  cmOpts: null,
  toasts: [],
};

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    style: { setProperty() {}, getPropertyValue: () => '' },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) {
        const next = on === undefined ? !this._set.has(c) : !!on;
        if (next) this._set.add(c); else this._set.delete(c);
        return next;
      }
    },
    dataset: {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

const context = vm.createContext({
  localStorage: {
    getItem: k => (k in harness.store ? harness.store[k] : null),
    setItem: (k, v) => { harness.store[k] = String(v); },
  },
  document: {
    getElementById: id => el(id),
    querySelectorAll: sel => (sel === '.sf-layout' ? [el('session-scratchpad')] : []),
    body: { style: {} },
  },
  window: { addEventListener() {}, removeEventListener() {} },
  api: async (url, opts) => {
    harness.apiCalls.push({ url, opts });
    return harness.apiHandler ? harness.apiHandler(url, opts) : {};
  },
  escapeHtml: s => String(s).split('<').join('&lt;'),
  formatBytes: n => `${n} B`,
  timeAgo: () => '3m ago',
  codeModeFor: p => (p.endsWith('.js') ? 'javascript' : null),
  renderMarkdown: s => 'MD:' + s,
  showLoading: (container, text) => { container.innerHTML = text; },
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  CodeMirror: (host, opts) => {
    harness.cmOpts = opts;
    const inst = { value: opts.value, getValue: () => inst.value, on() {}, refresh() {} };
    harness.cm = inst;
    return inst;
  },
});
vm.runInContext(src + '\nglobalThis._Sessions = Sessions; globalThis._CodeView = CodeView;', context);
const Sessions = context._Sessions;

const FILES = [
  { path: 'notes.md', size: 20, mtime: 3 },
  { path: 'nested/probe.js', size: 40, mtime: 2 },
  { path: 'blob.bin', size: 60, mtime: 1 },
];

beforeEach(() => {
  harness.store = {};
  harness.els = {};
  harness.apiCalls = [];
  harness.apiHandler = null;
  harness.cm = null;
  harness.cmOpts = null;
  harness.toasts = [];
  Sessions._scratchpadData = null;
  Sessions._spOpen = null;
  Sessions._spEditor = null;
  Sessions._scratchpadLoaded = false;
});

async function loadWith(files, exists = true) {
  harness.apiHandler = () => ({ exists, files });
  await Sessions.loadScratchpad();
}

// ── layout ────────────────────────────────────────────────────────────────────

test('the tab renders the shared split layout, not a flat list', async () => {
  await loadWith(FILES);
  const html = el('session-scratchpad').innerHTML;
  assert.ok(html.includes('sf-structure'), 'structure column');
  assert.ok(html.includes('sf-splitter'), 'draggable divider');
  assert.ok(html.includes('sf-pane'), 'source pane');
  assert.ok(html.includes('Scratchpad (3)'));
});

test('files render as tree rows with their size', async () => {
  await loadWith(FILES);
  const html = el('session-scratchpad').innerHTML;
  assert.ok(html.includes('sf-row-file'));
  assert.ok(html.includes('notes.md'));
  assert.ok(html.includes('nested/'), 'the containing folder is shown as a prefix');
  assert.ok(html.includes('20 B'));
});

test('an empty scratchpad explains itself and renders no pane', async () => {
  await loadWith([], false);
  const html = el('session-scratchpad').innerHTML;
  assert.ok(html.includes('No scratchpad files'));
  assert.strictEqual(html.includes('sf-splitter'), false);
});

test('the pane starts empty until a file is picked', async () => {
  await loadWith(FILES);
  assert.ok(el('sp-pane').innerHTML.includes('Select a file'));
});

// ── opening files ─────────────────────────────────────────────────────────────

test('clicking a file loads it into the pane', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'const a = 1;', size: 40 });
  await Sessions.openScratchpadInPane(1);

  assert.strictEqual(Sessions._spOpen.path, 'nested/probe.js');
  assert.strictEqual(Sessions._spOpen.mode, 'source');
  assert.strictEqual(harness.cm.getValue(), 'const a = 1;');
  assert.ok(el('sp-pane').innerHTML.includes('read-only'), 'the status bar says read-only');
  assert.strictEqual(el('sp-pane').innerHTML.includes('Save'), false, 'no save affordance');
});

test('the viewer is mounted read-only with highlighting', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'x', size: 40 });
  await Sessions.openScratchpadInPane(1);

  assert.strictEqual(harness.cmOpts.readOnly, true);
  assert.strictEqual(harness.cmOpts.mode, 'javascript');
  assert.strictEqual(harness.cmOpts.extraKeys, undefined, 'no Ctrl+S binding on a read-only view');
});

test('markdown opens on its rendered preview', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: '# Notes', size: 20 });
  await Sessions.openScratchpadInPane(0);

  assert.strictEqual(Sessions._spOpen.mode, 'preview');
  assert.ok(el('sp-pane-body').innerHTML.includes('MD:# Notes'));

  Sessions.setScratchpadMode('source');
  assert.strictEqual(harness.cm.getValue(), '# Notes');
});

test('a non-previewable file gets no preview button', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'x', size: 40 });
  await Sessions.openScratchpadInPane(1);

  assert.strictEqual(Sessions._spOpen.canPreview, false);
  assert.strictEqual(el('sp-pane').innerHTML.includes('sf-mode-toggle'), false);
  Sessions.setScratchpadMode('preview');
  assert.strictEqual(Sessions._spOpen.mode, 'source');
});

test('binary and oversized files are reported, not mounted', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: true, size: 60 });
  await Sessions.openScratchpadInPane(2);
  assert.ok(el('sp-pane-body').innerHTML.includes('Binary file'));
  assert.strictEqual(harness.cm, null);

  harness.apiHandler = () => ({ binary: false, tooLarge: true, size: 300000 });
  await Sessions.openScratchpadInPane(1);
  assert.ok(el('sp-pane-body').innerHTML.includes('too large'));
  assert.strictEqual(harness.cm, null);
});

test('a read failure is shown in the pane', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => { throw new Error('File not found'); };
  await Sessions.openScratchpadInPane(0);
  assert.ok(el('sp-pane-body').innerHTML.includes('File not found'));
});

test('the open row is marked active in the list', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'x', size: 40 });
  await Sessions.openScratchpadInPane(1);
  assert.ok(el('sp-list').innerHTML.includes('sf-row-active'));
});

test('loading a session clears the previously open file', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'x', size: 40 });
  await Sessions.openScratchpadInPane(1);
  assert.ok(Sessions._spOpen);

  await loadWith(FILES);
  assert.strictEqual(Sessions._spOpen, null);
  assert.strictEqual(Sessions._spEditor, null);
});

// ── live refresh ──────────────────────────────────────────────────────────────

test('polling shows files added after the tab was opened', async () => {
  await loadWith(FILES);
  const added = [{ path: 'fresh.txt', size: 5, mtime: 9 }, ...FILES];
  harness.apiHandler = () => ({ exists: true, files: added });
  await Sessions.pollScratchpad();

  assert.ok(el('sp-list').innerHTML.includes('fresh.txt'));
  assert.strictEqual(el('sp-count').textContent, 'Scratchpad (4)');
});

test('polling an unchanged scratchpad leaves the list alone', async () => {
  await loadWith(FILES);
  el('sp-list').innerHTML = 'UNTOUCHED';
  harness.apiHandler = () => ({ exists: true, files: FILES });
  await Sessions.pollScratchpad();
  assert.strictEqual(el('sp-list').innerHTML, 'UNTOUCHED');
});

test('a new file does not disturb the open file, only its index', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'const a = 1;', size: 40 });
  await Sessions.openScratchpadInPane(1);
  harness.cm = null;

  harness.apiHandler = () => ({ exists: true, files: [{ path: 'fresh.txt', size: 5, mtime: 9 }, ...FILES] });
  await Sessions.pollScratchpad();

  assert.strictEqual(Sessions._spOpen.path, 'nested/probe.js');
  assert.strictEqual(Sessions._spOpen.index, 2, 'index follows the file down the list');
  assert.strictEqual(harness.cm, null, 'the viewer is not remounted');
  assert.ok(el('sp-list').innerHTML.includes('sf-row-active'));
});

test('polling closes the pane when the open file is gone', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ binary: false, content: 'x', size: 40 });
  await Sessions.openScratchpadInPane(1);

  harness.apiHandler = () => ({ exists: true, files: FILES.filter(f => f.path !== 'nested/probe.js') });
  await Sessions.pollScratchpad();

  assert.strictEqual(Sessions._spOpen, null);
  assert.ok(el('sp-pane').innerHTML.includes('Select a file'));
});

test('polling replaces the empty state once the first file appears', async () => {
  await loadWith([], false);
  harness.apiHandler = () => ({ exists: true, files: FILES });
  await Sessions.pollScratchpad();

  const html = el('session-scratchpad').innerHTML;
  assert.ok(html.includes('sf-splitter'), 'the split layout is built');
  assert.ok(html.includes('Scratchpad (3)'));
});

test('polling falls back to the empty state when every file is gone', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => ({ exists: true, files: [] });
  await Sessions.pollScratchpad();
  assert.ok(el('session-scratchpad').innerHTML.includes('No scratchpad files'));
});

test('polling is skipped until the tab has been opened', async () => {
  Sessions._scratchpadLoaded = false;
  harness.apiHandler = () => ({ exists: true, files: FILES });
  await Sessions.pollScratchpad();
  assert.strictEqual(harness.apiCalls.length, 0);
});

// ── OS actions still reachable ────────────────────────────────────────────────

test('open folder, open file and reveal still post to their endpoints', async () => {
  await loadWith(FILES);
  harness.apiCalls = [];
  harness.apiHandler = () => ({ ok: true });

  await Sessions.openScratchpadFolder();
  await Sessions.openScratchpadFile(0);
  await Sessions.revealScratchpadFile(0);

  const urls = harness.apiCalls.map(c => c.url);
  assert.ok(urls[0].endsWith('/scratchpad/open-folder'));
  assert.ok(urls[1].endsWith('/scratchpad/open-file'));
  assert.ok(urls[2].endsWith('/scratchpad/reveal-file'));
  assert.strictEqual(harness.apiCalls[1].opts.body.path, 'notes.md');
});

test('a failed OS action surfaces a toast', async () => {
  await loadWith(FILES);
  harness.apiHandler = () => { throw new Error('nope'); };
  await Sessions.openScratchpadFolder();
  assert.strictEqual(harness.toasts[0].type, 'error');
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load code-view.js + session-files.js in a browser-like sandbox with stub DOM/CodeMirror/timers
// so the Files tab tree, dirty tracking and autosave can be asserted without a browser.
const src = fs.readFileSync(path.join(__dirname, '../public/js/code-view.js'), 'utf-8')
  + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/file-view-cache.js'), 'utf-8')
  + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/session-files.js'), 'utf-8');

const harness = {
  store: {},
  els: {},
  timers: new Map(),
  nextTimerId: 1,
  apiCalls: [],
  apiHandler: null,
  cm: null,
  toasts: [],
  copyTargets: [],
};

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: { setProperty() {}, getPropertyValue: () => '', removeProperty() {} },
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
    getBoundingClientRect: () => ({ left: 0, width: 1000 }),
  };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

/** A fake CodeMirror constructor with just enough surface for session-files.js + code-view.js:
 *  editing (type/getValue), search marks, view state, and — for the chunked-loading tests —
 *  appendText plus a scroll handler the tests can fire via harness.cm.handlers.scroll(). */
function makeCodeMirrorMock() {
  function CodeMirror(host, opts) {
    harness.cmOpts = opts;
    const inst = {
      value: opts.value,
      lines: opts.value.split('\n'),
      handlers: {},
      cursor: { line: 0, ch: 0 },
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 300,
      marks: [],
      selection: null,
      scrolledTo: null,
      getValue: () => inst.value,
      on: (evt, fn) => { inst.handlers[evt] = fn; },
      refresh() {},
      getCursor: () => inst.cursor,
      getScrollInfo: () => ({ top: inst.scrollTop, height: inst.scrollHeight, clientHeight: inst.clientHeight }),
      setCursor: c => { inst.cursor = c; },
      scrollTo: (x, top) => { inst.scrollTop = top; },
      type(text) { inst.value = text; inst.lines = text.split('\n'); if (inst.handlers.change) inst.handlers.change(); },
      lastLine: () => inst.lines.length - 1,
      getLine: n => inst.lines[n],
      replaceRange(text) {
        inst.value += text;
        inst.lines = inst.value.split('\n');
      },
      // Fake search cursor over the plain string value — good enough to exercise highlightMatches.
      getSearchCursor(query) {
        const lower = inst.value.toLowerCase();
        const q = String(query).toLowerCase();
        let searchIdx = 0;
        let current = null;
        return {
          findNext() {
            if (!q) return false;
            const idx = lower.indexOf(q, searchIdx);
            if (idx === -1) { current = null; return false; }
            current = { from: idx, to: idx + q.length };
            searchIdx = idx + q.length;
            return true;
          },
          from: () => current.from,
          to: () => current.to,
        };
      },
      markText(from, to, opts2) {
        const mark = { from, to, opts: opts2, clear: () => { inst.marks = inst.marks.filter(m => m !== mark); } };
        inst.marks.push(mark);
        return mark;
      },
      setSelection: (from, to) => { inst.selection = { from, to }; },
      scrollIntoView: pos => { inst.scrolledTo = pos; },
    };
    harness.cm = inst;
    return inst;
  }
  CodeMirror.Pos = (line, ch) => ({ line, ch });
  return CodeMirror;
}

const context = vm.createContext({
  localStorage: {
    getItem: k => (k in harness.store ? harness.store[k] : null),
    setItem: (k, v) => { harness.store[k] = String(v); },
  },
  document: {
    getElementById: id => el(id),
    querySelectorAll: sel => (sel === '.sf-layout' ? [el('session-context')] : []),
    body: { style: {} },
  },
  window: { addEventListener() {}, removeEventListener() {} },
  setTimeout: (fn, ms) => {
    const id = harness.nextTimerId++;
    harness.timers.set(id, { fn, ms });
    return id;
  },
  clearTimeout: id => { harness.timers.delete(id); },
  api: async (url, opts) => {
    harness.apiCalls.push({ url, opts });
    return harness.apiHandler ? harness.apiHandler(url, opts) : {};
  },
  escapeHtml: s => String(s).split('<').join('&lt;'),
  formatBytes: n => `${n} B`,
  codeModeFor: p => (p.endsWith('.java') ? 'text/x-java' : p.endsWith('.js') ? 'javascript' : null),
  renderMarkdown: s => 'MD:' + s,
  addCodeCopyButtons: container => { harness.copyTargets.push(container); },
  showLoading: (container, text) => { container.innerHTML = text; },
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  CodeMirror: makeCodeMirrorMock(),
  Sessions: { _ctx: { projSlug: 'proj' }, toggleActionMenu() {}, openCtxFile() {}, revealCtxFile() {} },
  FileHistory: {
    fetchDiffCurrent: async () => ({ hunks: [{ oldStart: 1, newStart: 1, lines: [] }], stats: { added: 1, removed: 0 } }),
    renderDiff: (container) => { container.innerHTML = 'DIFF'; },
    showDiffCurrent: () => { harness.modalOpened = true; },
  },
});
vm.runInContext(src + '\nglobalThis._SessionFiles = SessionFiles; globalThis._CodeView = CodeView; globalThis._FileViewCache = FileViewCache;', context);
const SessionFiles = context._SessionFiles;
const CodeView = context._CodeView;
const FileViewCache = context._FileViewCache;

function dirEntry(name) { return { name, type: 'dir' }; }
function fileEntry(name) { return { name, type: 'file', size: 10, mtime: 1 }; }

// cursor objects round-tripped through FileViewCache are built inside the vm sandbox, so
// assert.deepStrictEqual's cross-realm prototype check would reject them; compare fields instead.
function assertCursor(cursor, line, ch) {
  assert.strictEqual(cursor.line, line);
  assert.strictEqual(cursor.ch, ch);
}

function treeHandler(map) {
  return url => {
    const match = url.match(/files\/tree(\?path=(.*))?$/);
    const dir = match && match[2] ? decodeURIComponent(match[2]) : '';
    if (!(dir in map)) throw new Error('Directory not found');
    return { path: dir, entries: map[dir] };
  };
}

beforeEach(() => {
  harness.store = {};
  harness.els = {};
  harness.timers.clear();
  harness.apiCalls = [];
  harness.apiHandler = null;
  harness.cm = null;
  harness.cmOpts = null;
  harness.toasts = [];
  harness.copyTargets = [];
  harness.modalOpened = false;
  context.Sessions._ctx.projSlug = 'proj';
  FileViewCache._store = {};
  SessionFiles.reset('proj-slug');
});

// ── tree ──────────────────────────────────────────────────────────────────────

test('loadTree renders the project root', async () => {
  harness.apiHandler = treeHandler({ '': [dirEntry('lib'), fileEntry('server.js')] });
  await SessionFiles.loadTree();

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('lib'));
  assert.ok(html.includes('server.js'));
  assert.strictEqual(SessionFiles.treeLoaded, true);
});

test('loadTree surfaces a failure instead of leaving a spinner', async () => {
  harness.apiHandler = () => { throw new Error('boom'); };
  await SessionFiles.loadTree();
  assert.ok(el('sf-tree').innerHTML.includes('boom'));
});

test('the tree omits files that are pinned in the changed list', async () => {
  harness.apiHandler = treeHandler({ '': [fileEntry('server.js'), fileEntry('touched.js')] });
  await SessionFiles.loadTree();
  SessionFiles.setChangedPaths(['touched.js']);

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('server.js'));
  assert.strictEqual(html.includes('touched.js'), false);
});

test('a changed file inside a folder leaves the folder in place', async () => {
  harness.apiHandler = treeHandler({
    '': [dirEntry('routes')],
    'routes': [fileEntry('git.js')],
  });
  await SessionFiles.loadTree();
  await SessionFiles.toggleDir('routes');
  SessionFiles.setChangedPaths(['routes/git.js']);

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('routes'));
  assert.strictEqual(html.includes('git.js'), false);
});

test('setChangedPaths with the same set does not re-render', async () => {
  harness.apiHandler = treeHandler({ '': [fileEntry('a.js')] });
  await SessionFiles.loadTree();
  SessionFiles.setChangedPaths(['x.js']);

  el('sf-tree').innerHTML = 'UNTOUCHED';
  SessionFiles.setChangedPaths(['x.js']);
  assert.strictEqual(el('sf-tree').innerHTML, 'UNTOUCHED');
});

test('expanding a folder fetches it once and caches the entries', async () => {
  harness.apiHandler = treeHandler({
    '': [dirEntry('lib')],
    'lib': [fileEntry('paths.js')],
  });
  await SessionFiles.loadTree();

  await SessionFiles.toggleDir('lib');
  assert.ok(el('sf-tree').innerHTML.includes('paths.js'));
  const callsAfterExpand = harness.apiCalls.length;

  await SessionFiles.toggleDir('lib');                      // collapse
  assert.strictEqual(el('sf-tree').innerHTML.includes('paths.js'), false);
  await SessionFiles.toggleDir('lib');                      // expand again
  assert.ok(el('sf-tree').innerHTML.includes('paths.js'));
  assert.strictEqual(harness.apiCalls.length, callsAfterExpand, 'cached folder must not refetch');
});

test('a folder that fails to load is not left expanded', async () => {
  harness.apiHandler = treeHandler({ '': [dirEntry('gone')] });
  await SessionFiles.loadTree();

  await SessionFiles.toggleDir('gone');
  assert.strictEqual(SessionFiles.expanded.has('gone'), false);
  assert.strictEqual(harness.toasts.length, 1);
});

test('nested rows are indented by depth', async () => {
  harness.apiHandler = treeHandler({
    '': [dirEntry('lib')],
    'lib': [fileEntry('paths.js')],
  });
  await SessionFiles.loadTree();
  await SessionFiles.toggleDir('lib');

  assert.ok(el('sf-tree').innerHTML.includes('--sf-depth:0'));
  assert.ok(el('sf-tree').innerHTML.includes('--sf-depth:1'));
});

test('reloadTree refetches the root and every expanded folder', async () => {
  harness.apiHandler = treeHandler({
    '': [dirEntry('lib')],
    'lib': [fileEntry('paths.js')],
  });
  await SessionFiles.loadTree();
  await SessionFiles.toggleDir('lib');

  harness.apiCalls = [];
  harness.apiHandler = treeHandler({
    '': [dirEntry('lib')],
    'lib': [fileEntry('paths.js'), fileEntry('added.js')],
  });
  await SessionFiles.reloadTree();

  assert.strictEqual(harness.apiCalls.length, 2);
  assert.ok(el('sf-tree').innerHTML.includes('added.js'));
});

// ── search ────────────────────────────────────────────────────────────────────

/** Serves a file's content one chunk at a time by matching the requested ?offset against each
 *  chunk's real position in the concatenated text — mirrors readFileChunk's contract. */
function chunkedHandler(chunks) {
  const size = chunks.join('').length;
  const offsets = [];
  let acc = 0;
  for (const c of chunks) { offsets.push(acc); acc += c.length; }
  return url => {
    const m = url.match(/offset=(\d+)/);
    const offset = m ? parseInt(m[1], 10) : 0;
    const idx = offsets.indexOf(offset);
    if (idx === -1) return { content: '', size, mtime: 1, offset: size, nextOffset: size, done: true };
    const content = chunks[idx];
    const nextOffset = offset + content.length;
    return { content, size, mtime: 1, offset, nextOffset, done: nextOffset >= size };
  };
}

function searchAndTreeHandler(treeMap, searchMap) {
  return url => {
    if (url.includes('/files/search')) {
      const m = url.match(/[?&]q=([^&]*)/);
      const q = m ? decodeURIComponent(m[1]) : '';
      const matches = searchMap[q] || [];
      return { matches, truncated: false };
    }
    return treeHandler(treeMap)(url);
  };
}

test('typing into the search box schedules a debounced search', async () => {
  harness.apiHandler = treeHandler({ '': [fileEntry('readme.md')] });
  await SessionFiles.loadTree();

  SessionFiles.onSearchInput('re');
  assert.strictEqual(harness.timers.size, 1);
  const timer = [...harness.timers.values()][0];
  assert.strictEqual(timer.ms, SessionFiles.SEARCH_DEBOUNCE_MS);
});

test('typing again restarts the search debounce instead of stacking timers', async () => {
  harness.apiHandler = treeHandler({ '': [] });
  await SessionFiles.loadTree();
  SessionFiles.onSearchInput('r');
  SessionFiles.onSearchInput('re');
  assert.strictEqual(harness.timers.size, 1);
});

test('a search filters the tree to matches and auto-expands ancestor folders', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [dirEntry('src'), fileEntry('readme.md')], 'src': [fileEntry('app.js')] },
    { app: [{ path: 'src/app.js', type: 'file' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('app');

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('app.js'));
  assert.ok(html.includes('src'));
  assert.strictEqual(html.includes('readme.md'), false);
  assert.ok(html.includes('&#9660;'), 'the ancestor folder is force-expanded');
});

test('clearing the search restores the unfiltered tree at its prior expand state', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [dirEntry('src'), fileEntry('readme.md')], 'src': [fileEntry('app.js')] },
    { app: [{ path: 'src/app.js', type: 'file' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('app');
  await SessionFiles._runSearch('');

  assert.strictEqual(SessionFiles.searchActive, false);
  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('readme.md'));
  assert.ok(html.includes('&#9654;'), 'src collapses back since it was never manually expanded');
});

test('a directory match is shown even without a matching descendant', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [dirEntry('lib'), fileEntry('readme.md')] },
    { lib: [{ path: 'lib', type: 'dir' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('lib');

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('lib'));
  assert.strictEqual(html.includes('readme.md'), false);
});

test('a contiguous substring match highlights as a single run', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('app.js')] },
    { ap: [{ path: 'app.js', type: 'file' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('ap');

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('<mark class="sf-search-hit">ap</mark>p.js'));
});

test('a non-contiguous acronym match highlights each matched capital separately', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('PowerRanger.js')] },
    { pr: [{ path: 'PowerRanger.js', type: 'file' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('pr');

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('<mark class="sf-search-hit">P</mark>ower<mark class="sf-search-hit">R</mark>anger.js'));
});

test('a content-only match shows the filtered file with its plain, unhighlighted name', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('unrelated.txt'), fileEntry('other.txt')] },
    { needle: [{ path: 'unrelated.txt', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');

  const html = el('sf-tree').innerHTML;
  assert.ok(html.includes('unrelated.txt'));
  assert.strictEqual(html.includes('other.txt'), false);
  assert.strictEqual(html.includes('<mark'), false, 'nothing in the name itself matched the query');
});

test('no matches renders a distinct empty state', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('app.js')] },
    { zzz: [] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('zzz');

  assert.ok(el('sf-tree').innerHTML.includes('No matching files'));
});

test('a search failure is shown in the tree', async () => {
  harness.apiHandler = url => {
    if (url.includes('/files/search')) throw new Error('boom');
    return treeHandler({ '': [] })(url);
  };
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('x');

  assert.ok(el('sf-tree').innerHTML.includes('Search failed: boom'));
});

test('a stale search response is discarded once a newer search has started', async () => {
  const responses = { first: null, second: null };
  harness.apiHandler = url => {
    if (url.includes('q=first')) return new Promise(r => { responses.first = r; });
    if (url.includes('q=second')) return new Promise(r => { responses.second = r; });
    return treeHandler({ '': [fileEntry('a.js'), fileEntry('b.js')] })(url);
  };
  await SessionFiles.loadTree();

  const p1 = SessionFiles._runSearch('first');
  const p2 = SessionFiles._runSearch('second');
  responses.second({ matches: [{ path: 'b.js', type: 'file' }], truncated: false });
  await p2;
  responses.first({ matches: [{ path: 'a.js', type: 'file' }], truncated: false });
  await p1;

  assert.ok(el('sf-tree').innerHTML.includes('b.js'));
  assert.strictEqual(el('sf-tree').innerHTML.includes('a.js'), false);
});

// ── opening files ─────────────────────────────────────────────────────────────

test('openFile loads content into the pane', async () => {
  harness.apiHandler = () => ({ path: 'server.js', content: 'const a = 1;', mtime: 5, size: 12, binary: false });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(SessionFiles.open.path, 'server.js');
  assert.strictEqual(SessionFiles.open.saved, 'const a = 1;');
  assert.strictEqual(SessionFiles.open.mode, 'source');
  assert.strictEqual(harness.cm.getValue(), 'const a = 1;');
});

test('openFile reports a read failure in the pane', async () => {
  harness.apiHandler = () => { throw new Error('File not found'); };
  await SessionFiles.openFile('gone.js');

  assert.strictEqual(SessionFiles.open.error, 'File not found');
  assert.ok(el('sf-pane-body').innerHTML.includes('File not found'));
});

test('binary and oversized files are not opened for editing', async () => {
  harness.apiHandler = () => ({ binary: true, size: 4096 });
  await SessionFiles.openFile('logo.png');
  assert.ok(el('sf-pane-body').innerHTML.includes('Binary file'));
  assert.strictEqual(harness.cm, null);

  harness.apiHandler = () => ({ binary: false, tooLarge: true, size: 5 * 1024 * 1024 });
  await SessionFiles.openFile('huge.txt');
  assert.ok(el('sf-pane-body').innerHTML.includes('too large'));
  assert.strictEqual(harness.cm, null);
});

test('a changed file opens on the diff, an untouched one on the source', async () => {
  harness.apiHandler = () => ({ content: 'x', mtime: 1 });
  await SessionFiles.openFile('routes/git.js', {
    mode: 'diff',
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'routes/git.js', isNew: '', isDeleted: '' }
  });
  assert.strictEqual(SessionFiles.open.mode, 'diff');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(el('sf-pane-body').innerHTML, 'DIFF');

  await SessionFiles.openFile('lib/paths.js');
  assert.strictEqual(SessionFiles.open.mode, 'source');
});

test('a changed markdown file opens on preview, not the diff', async () => {
  harness.apiHandler = () => ({ content: '# Title', mtime: 1 });
  await SessionFiles.openFile('README.md', {
    mode: 'diff',
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'README.md', isNew: '', isDeleted: '' }
  });

  assert.strictEqual(SessionFiles.open.canDiff, true, 'a diff is still available as a toggle');
  assert.strictEqual(SessionFiles.open.mode, 'preview', 'preview wins over the diff default for markdown');
});

test('a file the session edited without a snapshot offers source only', async () => {
  harness.apiHandler = () => ({ content: 'edited text', mtime: 1 });
  await SessionFiles.openFile('lib/paths.js', {
    ctx: { session: 's1', hash: '', from: '', path: 'lib/paths.js', isNew: '', isDeleted: '' }
  });

  assert.strictEqual(SessionFiles.open.canDiff, false, 'no hash and not new — nothing to diff against');
  assert.strictEqual(SessionFiles.open.mode, 'source');
  assert.strictEqual(harness.cm.getValue(), 'edited text');

  SessionFiles.setMode('diff');
  assert.strictEqual(SessionFiles.open.mode, 'source', 'the diff mode stays unreachable');
});

test('a file with a recorded snapshot can switch to the diff', async () => {
  harness.apiHandler = () => ({ content: 'x', mtime: 1 });
  await SessionFiles.openFile('routes/git.js', {
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'routes/git.js', isNew: '', isDeleted: '' }
  });
  assert.strictEqual(SessionFiles.open.canDiff, true);

  SessionFiles.setMode('diff');
  assert.strictEqual(SessionFiles.open.mode, 'diff');
});

test('a deleted file with no snapshot explains itself instead of erroring', async () => {
  harness.apiHandler = () => { throw new Error('should not be called'); };
  await SessionFiles.openFile('gone.js', {
    ctx: { session: 's1', hash: '', from: '', path: 'gone.js', isNew: '', isDeleted: '1' }
  });

  assert.strictEqual(SessionFiles.open.mode, 'source');
  assert.strictEqual(harness.apiCalls.length, 0);
  assert.ok(el('sf-pane-body').innerHTML.includes('deleted during the session'));
});

test('a deleted file opens on the diff without fetching content', async () => {
  harness.apiHandler = () => { throw new Error('should not be called'); };
  await SessionFiles.openFile('gone.js', {
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'gone.js', isNew: '', isDeleted: '1' }
  });

  assert.strictEqual(SessionFiles.open.mode, 'diff');
  assert.strictEqual(harness.apiCalls.length, 0);
});

test('switching mode to source mounts the editor without refetching', async () => {
  harness.apiHandler = () => ({ content: 'const a = 1;', mtime: 1 });
  await SessionFiles.openFile('routes/git.js', {
    mode: 'diff',
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'routes/git.js', isNew: '', isDeleted: '' }
  });
  const callsBefore = harness.apiCalls.length;

  SessionFiles.setMode('source');
  assert.strictEqual(harness.apiCalls.length, callsBefore);
  assert.strictEqual(harness.cm.getValue(), 'const a = 1;');
});

test('the editor is created with the mode for the open file', async () => {
  harness.apiHandler = () => ({ content: 'class A {}', mtime: 1 });
  await SessionFiles.openFile('Main.java');
  assert.strictEqual(harness.cmOpts.mode, 'text/x-java');
  assert.strictEqual(harness.cmOpts.lineNumbers, true);
  assert.strictEqual(harness.cmOpts.styleActiveLine, true, 'the cursor line is highlighted');
});

// ── in-file search highlight ──────────────────────────────────────────────────

test('opening a file while a project search is active highlights every match and shows the count', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('server.js')] },
    { needle: [{ path: 'server.js', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');

  harness.apiHandler = () => ({ content: 'a needle\nb needle\nc', mtime: 1 });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(harness.cm.marks.length, 2);
  assert.strictEqual(el('sf-pane-search-count').textContent, '2 matches');
  assert.strictEqual(el('sf-pane-search-count').style.display, '');
});

test('a file with no in-file matches shows a zero count instead of hiding it', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('server.js')] },
    { pr: [{ path: 'server.js', type: 'file', matchedBy: 'name' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('pr');

  harness.apiHandler = () => ({ content: 'nothing relevant here', mtime: 1 });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(harness.cm.marks.length, 0);
  assert.strictEqual(el('sf-pane-search-count').textContent, '0 matches');
});

test('the singular is used for exactly one match', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('server.js')] },
    { needle: [{ path: 'server.js', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');

  harness.apiHandler = () => ({ content: 'only one needle here', mtime: 1 });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(el('sf-pane-search-count').textContent, '1 match');
});

test('no active search leaves the count hidden and does not mark the editor', async () => {
  harness.apiHandler = () => ({ content: 'a needle\nb needle', mtime: 1 });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(harness.cm.marks.length, 0);
  assert.strictEqual(el('sf-pane-search-count').style.display, 'none');
});

test('clearing the search box clears the highlight and hides the count in the open file', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('server.js')] },
    { needle: [{ path: 'server.js', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');
  harness.apiHandler = () => ({ content: 'a needle\nb needle', mtime: 1 });
  await SessionFiles.openFile('server.js');
  assert.strictEqual(harness.cm.marks.length, 2);

  await SessionFiles._runSearch('');

  assert.strictEqual(harness.cm.marks.length, 0);
  assert.strictEqual(el('sf-pane-search-count').style.display, 'none');
});

test('editing the search query while the file stays open refreshes its highlight and count', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('server.js')] },
    {
      needle: [{ path: 'server.js', type: 'file', matchedBy: 'content' }],
      other: [{ path: 'server.js', type: 'file', matchedBy: 'content' }]
    }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');
  harness.apiHandler = () => ({ content: 'needle needle other', mtime: 1 });
  await SessionFiles.openFile('server.js');
  assert.strictEqual(harness.cm.marks.length, 2);

  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('server.js')] },
    { other: [{ path: 'server.js', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles._runSearch('other');

  assert.strictEqual(harness.cm.marks.length, 1);
  assert.strictEqual(el('sf-pane-search-count').textContent, '1 match');
});

test('a diff-mode file shows no in-file search count', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('git.js')] },
    { needle: [{ path: 'git.js', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');

  harness.apiHandler = () => ({ content: 'const a = 1;', mtime: 1 });
  await SessionFiles.openFile('git.js', {
    mode: 'diff',
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'git.js', isNew: '', isDeleted: '' }
  });

  assert.strictEqual(el('sf-pane-search-count').style.display, 'none');
});

// ── preview mode ──────────────────────────────────────────────────────────────

test('markdown opens on its rendered preview', async () => {
  harness.apiHandler = () => ({ content: '# Title', mtime: 1 });
  await SessionFiles.openFile('README.md');

  assert.strictEqual(SessionFiles.open.canPreview, true);
  assert.strictEqual(SessionFiles.open.mode, 'preview', 'preview is the landing mode');
  assert.ok(el('sf-pane-body').innerHTML.includes('markdown-body'));
  assert.ok(el('sf-pane-body').innerHTML.includes('MD:# Title'), 'rendered, not raw');
  assert.deepStrictEqual(harness.copyTargets, [el('sf-pane-body')], 'code blocks in the preview get copy buttons');

  SessionFiles.setMode('source');
  assert.strictEqual(SessionFiles.open.mode, 'source');
  assert.strictEqual(harness.cm.getValue(), '# Title');
});

test('html opens in a sandboxed preview frame', async () => {
  harness.apiHandler = () => ({ content: '<p>hi</p><script>alert(1)<\/script>', mtime: 1 });
  await SessionFiles.openFile('public/index.html');

  assert.strictEqual(SessionFiles.open.mode, 'preview');
  const html = el('sf-pane-body').innerHTML;
  assert.ok(html.includes('<iframe'), 'html renders in a frame, not inline');
  assert.ok(html.includes('sandbox'), 'the frame is sandboxed so page scripts cannot run');
  assert.strictEqual(html.includes('<script>alert(1)'), false, 'markup is escaped into srcdoc');
});

test('files with no preview form get no preview mode', async () => {
  harness.apiHandler = () => ({ content: 'x', mtime: 1 });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(SessionFiles.open.canPreview, false);
  SessionFiles.setMode('preview');
  assert.strictEqual(SessionFiles.open.mode, 'source');
});

test('preview shows unsaved edits, not the copy on disk', async () => {
  harness.apiHandler = () => ({ content: '# Saved', mtime: 1 });
  await SessionFiles.openFile('notes.md');
  SessionFiles.setMode('source');
  harness.cm.type('# Edited');

  SessionFiles.setMode('preview');
  assert.ok(el('sf-pane-body').innerHTML.includes('MD:# Edited'));
  assert.strictEqual(SessionFiles.isDirty(), true, 'switching to preview keeps the edit pending');
});

test('leaving source drops the stale editor reference', async () => {
  harness.apiHandler = () => ({ content: '# Saved', mtime: 1 });
  await SessionFiles.openFile('notes.md');
  SessionFiles.setMode('source');
  assert.ok(SessionFiles.editor);

  SessionFiles.setMode('preview');
  assert.strictEqual(SessionFiles.editor, null, 'the editor DOM is gone, so the reference must be too');

  SessionFiles.setMode('source');
  assert.ok(SessionFiles.editor, 'coming back re-mounts it');
});

// ── chunked loading of large files ─────────────────────────────────────────────

test('a file that arrives in chunks loads more as the editor scrolls toward the bottom', async () => {
  harness.apiHandler = chunkedHandler(['AAAA', 'BBBB', 'CCCC']);
  await SessionFiles.openFile('big.txt');

  assert.strictEqual(SessionFiles.open.doneLoading, false);
  assert.strictEqual(harness.cm.getValue(), 'AAAA');
  assert.strictEqual(el('sf-status-chunk').style.display, '');
  assert.ok(el('sf-status-chunk').textContent.includes('scroll for more'));

  harness.cm.scrollTop = 350; // within NEAR_BOTTOM_PX of the mock's 1000/300 scroll/client height
  harness.cm.handlers.scroll();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(harness.cm.getValue(), 'AAAABBBB');
  assert.strictEqual(SessionFiles.open.doneLoading, false);

  harness.cm.handlers.scroll();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(harness.cm.getValue(), 'AAAABBBBCCCC');
  assert.strictEqual(SessionFiles.open.doneLoading, true);
  assert.strictEqual(el('sf-status-chunk').style.display, 'none');
});

test('scrolling again while a chunk is already in flight does not double-fetch', async () => {
  harness.apiHandler = chunkedHandler(['AAAA', 'BBBB', 'CCCC']);
  await SessionFiles.openFile('big.txt');
  harness.apiCalls = [];

  const first = SessionFiles._loadMoreChunk();
  const second = SessionFiles._loadMoreChunk();
  await Promise.all([first, second]);

  assert.strictEqual(harness.apiCalls.length, 1);
  assert.strictEqual(harness.cm.getValue(), 'AAAABBBB');
});

test('a small file is reported fully loaded immediately, with no chunk status shown', async () => {
  harness.apiHandler = () => ({ content: 'const a = 1;', mtime: 1, size: 13, done: true, nextOffset: 13 });
  await SessionFiles.openFile('server.js');

  assert.strictEqual(SessionFiles.open.doneLoading, true);
  assert.strictEqual(el('sf-status-chunk').style.display, 'none');
});

test('saving a partially-loaded file finishes loading it first, so the write is not truncated', async () => {
  harness.apiHandler = chunkedHandler(['AAAA', 'BBBB', 'CCCC']);
  await SessionFiles.openFile('big.txt');
  harness.cm.type('AAAA-edited');
  assert.strictEqual(SessionFiles.isDirty(), true);

  const chunker = chunkedHandler(['AAAA', 'BBBB', 'CCCC']);
  let putBody = null;
  harness.apiHandler = (url, opts) => {
    if (opts && opts.method === 'PUT') { putBody = opts.body; return { ok: true, mtime: 3, size: 99 }; }
    return chunker(url);
  };

  await SessionFiles.save();

  assert.strictEqual(SessionFiles.open.doneLoading, true);
  assert.ok(putBody, 'the write happened only after loading finished');
  assert.strictEqual(putBody.content, 'AAAA-editedBBBBCCCC');
  assert.strictEqual(SessionFiles.isDirty(), false);
});

test('a failed forced load cancels the save instead of writing a truncated file', async () => {
  harness.apiHandler = chunkedHandler(['AAAA', 'BBBB', 'CCCC']);
  await SessionFiles.openFile('big.txt');
  harness.cm.type('AAAA-edited');

  let putCalled = false;
  harness.apiHandler = (url, opts) => {
    if (opts && opts.method === 'PUT') { putCalled = true; return { ok: true }; }
    throw new Error('network down');
  };

  await SessionFiles.save();

  assert.strictEqual(putCalled, false, 'never writes a partial file');
  assert.strictEqual(SessionFiles.open.doneLoading, false);
  assert.strictEqual(SessionFiles.isDirty(), true, 'the edit is preserved for a retry');
  assert.ok(harness.toasts.some(t => t.type === 'error'));
});

test('a partially-loaded markdown file finishes loading before it is previewed', async () => {
  harness.apiHandler = chunkedHandler(['# Title\n', 'more content here']);
  await SessionFiles.openFile('big.md');

  assert.strictEqual(SessionFiles.open.mode, 'preview');
  assert.strictEqual(SessionFiles.open.doneLoading, false);
  assert.ok(el('sf-pane-body').innerHTML.includes('Loading full file for preview'));

  await SessionFiles.open._previewLoadPromise;

  assert.strictEqual(SessionFiles.open.doneLoading, true);
  assert.ok(el('sf-pane-body').innerHTML.includes('MD:# Title\nmore content here'));
});

test('searching within a partially-loaded file forces it to finish loading, then highlights every match', async () => {
  harness.apiHandler = searchAndTreeHandler(
    { '': [fileEntry('big.txt')] },
    { needle: [{ path: 'big.txt', type: 'file', matchedBy: 'content' }] }
  );
  await SessionFiles.loadTree();
  await SessionFiles._runSearch('needle');

  harness.apiHandler = chunkedHandler(['first needle\n', 'second needle\n', 'no more']);
  await SessionFiles.openFile('big.txt');

  assert.strictEqual(SessionFiles.open.doneLoading, false);
  assert.strictEqual(el('sf-pane-search-count').textContent, 'Loading full file to search…');

  await SessionFiles.open._searchLoadPromise;

  assert.strictEqual(SessionFiles.open.doneLoading, true);
  assert.strictEqual(harness.cm.getValue(), 'first needle\nsecond needle\nno more');
  assert.strictEqual(harness.cm.marks.length, 2);
  assert.strictEqual(el('sf-pane-search-count').textContent, '2 matches');
});

// ── tree search spinner ─────────────────────────────────────────────────────────

test('the search spinner shows while a project search is in flight and hides once it resolves', async () => {
  harness.apiHandler = treeHandler({ '': [fileEntry('readme.md')] });
  await SessionFiles.loadTree();

  let resolveSearch;
  harness.apiHandler = () => new Promise(r => { resolveSearch = r; });
  const search = SessionFiles._runSearch('read');
  await new Promise(r => setImmediate(r));

  assert.strictEqual(el('sf-search-spinner').style.display, '');

  resolveSearch({ matches: [], truncated: false });
  await search;

  assert.strictEqual(el('sf-search-spinner').style.display, 'none');
});

// ── file view cache ───────────────────────────────────────────────────────────

test('FileViewCache stores and retrieves state scoped by project and path', () => {
  FileViewCache.set('proj-a', 'a.js', { cursor: { line: 2, ch: 3 }, scrollTop: 50 });
  assert.deepStrictEqual(FileViewCache.get('proj-a', 'a.js'), { cursor: { line: 2, ch: 3 }, scrollTop: 50 });
});

test('FileViewCache returns null for an unknown project/path pair', () => {
  assert.strictEqual(FileViewCache.get('unknown-proj', 'unknown.js'), null);
});

test('FileViewCache keeps the same path separate across projects', () => {
  FileViewCache.set('proj-a', 'shared.js', { cursor: { line: 1, ch: 0 }, scrollTop: 0 });
  FileViewCache.set('proj-b', 'shared.js', { cursor: { line: 9, ch: 0 }, scrollTop: 900 });

  assert.strictEqual(FileViewCache.get('proj-a', 'shared.js').cursor.line, 1);
  assert.strictEqual(FileViewCache.get('proj-b', 'shared.js').cursor.line, 9);
});

test('a freshly opened file starts with no cursor/scroll restore', async () => {
  harness.apiHandler = () => ({ content: 'a\nb\nc', mtime: 1 });
  await SessionFiles.openFile('a.js');
  assertCursor(harness.cm.cursor, 0, 0);
  assert.strictEqual(harness.cm.scrollTop, 0);
});

test('switching files stashes the cursor and scroll position, then restores it on reopen', async () => {
  harness.apiHandler = () => ({ content: 'a\nb\nc', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.cursor = { line: 2, ch: 1 };
  harness.cm.scrollTop = 120;

  harness.apiHandler = () => ({ content: 'x', mtime: 1 });
  await SessionFiles.openFile('b.js');
  assertCursor(harness.cm.cursor, 0, 0);

  harness.apiHandler = () => ({ content: 'a\nb\nc', mtime: 1 });
  await SessionFiles.openFile('a.js');
  assertCursor(harness.cm.cursor, 2, 1);
  assert.strictEqual(harness.cm.scrollTop, 120);
});

test('switching to diff and back to source restores the cursor and scroll position', async () => {
  harness.apiHandler = () => ({ content: 'a\nb', mtime: 1 });
  await SessionFiles.openFile('routes/git.js', {
    ctx: { session: 's1', hash: 'abc', from: '1', path: 'routes/git.js', isNew: '', isDeleted: '' }
  });
  harness.cm.cursor = { line: 1, ch: 0 };
  harness.cm.scrollTop = 40;

  SessionFiles.setMode('diff');
  SessionFiles.setMode('source');

  assertCursor(harness.cm.cursor, 1, 0);
  assert.strictEqual(harness.cm.scrollTop, 40);
});

test('saving stashes the cursor and scroll position too', async () => {
  harness.apiHandler = () => ({ content: 'a\nb', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');
  harness.cm.cursor = { line: 1, ch: 3 };
  harness.cm.scrollTop = 60;

  harness.apiHandler = () => ({ ok: true, mtime: 2 });
  await SessionFiles.save();

  harness.apiHandler = () => ({ content: 'x', mtime: 1 });
  await SessionFiles.openFile('b.js');
  harness.apiHandler = () => ({ content: 'edited', mtime: 2 });
  await SessionFiles.openFile('a.js');

  assertCursor(harness.cm.cursor, 1, 3);
  assert.strictEqual(harness.cm.scrollTop, 60);
});

test('cursor/scroll state is scoped per project, not shared across projects on the same path', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.cursor = { line: 5, ch: 2 };
  harness.cm.scrollTop = 200;

  context.Sessions._ctx.projSlug = 'other-proj';
  SessionFiles.reset('other-slug');
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');

  assertCursor(harness.cm.cursor, 0, 0);
  assert.strictEqual(harness.cm.scrollTop, 0);
});

// ── dirty state ───────────────────────────────────────────────────────────────

test('editing marks the file dirty; reverting clears it', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');

  harness.cm.type('a-edited');
  assert.strictEqual(SessionFiles.isDirty(), true);
  assert.strictEqual(el('sf-status-state').textContent, '● Unsaved changes');

  harness.cm.type('a');
  assert.strictEqual(SessionFiles.isDirty(), false);
  assert.strictEqual(el('sf-status-state').textContent, 'No changes');
});

test('the tree marks a dirty file even while another file is open', async () => {
  harness.apiHandler = treeHandler({ '': [fileEntry('a.js'), fileEntry('b.js')] });
  await SessionFiles.loadTree();

  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('a-edited');
  await SessionFiles.openFile('b.js');

  assert.ok(el('sf-tree').innerHTML.includes('title="Unsaved changes"'));
  assert.strictEqual(SessionFiles.isDirty('a.js'), true);
  assert.strictEqual(SessionFiles.isDirty('b.js'), false);
});

test('unsaved text survives switching files and comes back on reopen', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('work in progress');

  harness.apiHandler = () => ({ content: 'b', mtime: 1 });
  await SessionFiles.openFile('b.js');
  assert.strictEqual(harness.cm.getValue(), 'b');

  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  assert.strictEqual(harness.cm.getValue(), 'work in progress');
});

test('reloadFile drops the unsaved buffer and reloads from disk', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');

  harness.apiHandler = () => ({ content: 'a-from-disk', mtime: 2 });
  await SessionFiles.reloadFile();

  assert.strictEqual(SessionFiles.isDirty(), false);
  assert.strictEqual(harness.cm.getValue(), 'a-from-disk');
});

// ── saving ────────────────────────────────────────────────────────────────────

test('save PUTs the buffer and clears the dirty state', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('saved text');

  harness.apiHandler = () => ({ ok: true, mtime: 42, size: 10 });
  harness.apiCalls = [];
  await SessionFiles.save();

  const call = harness.apiCalls[0];
  assert.strictEqual(call.opts.method, 'PUT');
  assert.strictEqual(call.opts.body.path, 'a.js');
  assert.strictEqual(call.opts.body.content, 'saved text');
  assert.strictEqual(SessionFiles.isDirty(), false);
  assert.strictEqual(SessionFiles.open.saved, 'saved text');
  assert.strictEqual(SessionFiles.open.mtime, 42);
});

test('a CRLF file keeps its line endings when saved', async () => {
  harness.apiHandler = () => ({ content: 'a\r\nb\r\n', mtime: 1 });
  await SessionFiles.openFile('crlf.txt');
  assert.strictEqual(SessionFiles.isDirty(), false, 'loading a CRLF file must not look like an edit');

  harness.cm.type('a\nb\nc\n');                    // editors hand back LF
  harness.apiHandler = () => ({ ok: true, mtime: 2 });
  harness.apiCalls = [];
  await SessionFiles.save();

  assert.strictEqual(harness.apiCalls[0].opts.body.content, 'a\r\nb\r\nc\r\n');
});

test('an LF file is not converted to CRLF', async () => {
  harness.apiHandler = () => ({ content: 'a\nb\n', mtime: 1 });
  await SessionFiles.openFile('lf.txt');

  harness.cm.type('a\nb\nc\n');
  harness.apiHandler = () => ({ ok: true, mtime: 2 });
  harness.apiCalls = [];
  await SessionFiles.save();

  assert.strictEqual(harness.apiCalls[0].opts.body.content, 'a\nb\nc\n');
});

test('reopening a file with unsaved text shows it as unsaved again', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');

  harness.apiHandler = () => ({ content: 'b', mtime: 1 });
  await SessionFiles.openFile('b.js');
  assert.strictEqual(el('sf-status-state').textContent, 'No changes');
  assert.strictEqual(el('sf-pane-dirty').style.display, 'none');

  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  assert.strictEqual(el('sf-status-state').textContent, '● Unsaved changes');
  assert.strictEqual(el('sf-pane-dirty').style.display, '');
});

test('the saved-at note belongs to the file that was saved', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');
  harness.apiHandler = () => ({ ok: true, mtime: 2 });
  await SessionFiles.save();
  assert.ok(el('sf-status-state').textContent.startsWith('Saved '));

  harness.apiHandler = () => ({ content: 'b', mtime: 1 });
  await SessionFiles.openFile('b.js');
  assert.strictEqual(el('sf-status-state').textContent, 'No changes');
});

test('save is a no-op when nothing changed', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');

  harness.apiCalls = [];
  await SessionFiles.save();
  assert.strictEqual(harness.apiCalls.length, 0);
});

test('a failed save keeps the buffer and reports the error', async () => {
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');

  harness.apiHandler = () => { throw new Error('EACCES'); };
  await SessionFiles.save();

  assert.strictEqual(SessionFiles.isDirty(), true);
  assert.strictEqual(harness.toasts[0].type, 'error');
  assert.ok(harness.toasts[0].msg.includes('EACCES'));
});

// ── autosave ──────────────────────────────────────────────────────────────────

test('autosave is off by default and schedules no timer', async () => {
  assert.strictEqual(SessionFiles.autosaveEnabled(), false);
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');

  harness.cm.type('edited');
  assert.strictEqual(harness.timers.size, 0);
  assert.strictEqual(el('sf-status-autosave').textContent, 'autosave off');
});

test('autosave on: an edit schedules a save at the configured delay', async () => {
  SessionFiles.setAutosaveEnabled(true);
  SessionFiles.setAutosaveDelayMs(3000);
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');

  harness.cm.type('edited');
  assert.strictEqual(harness.timers.size, 1);
  const timer = [...harness.timers.values()][0];
  assert.strictEqual(timer.ms, 3000);
  assert.strictEqual(el('sf-status-autosave').textContent, 'autosave 3s');

  harness.apiHandler = () => ({ ok: true, mtime: 7 });
  harness.apiCalls = [];
  timer.fn();
  await new Promise(r => setImmediate(r));

  assert.strictEqual(harness.apiCalls[0].opts.method, 'PUT');
  assert.strictEqual(SessionFiles.isDirty(), false);
});

test('typing again restarts the autosave countdown instead of stacking timers', async () => {
  SessionFiles.setAutosaveEnabled(true);
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');

  harness.cm.type('e1');
  harness.cm.type('e2');
  assert.strictEqual(harness.timers.size, 1);
});

test('turning autosave off cancels a pending save', async () => {
  SessionFiles.setAutosaveEnabled(true);
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');
  assert.strictEqual(harness.timers.size, 1);

  SessionFiles.setAutosaveEnabled(false);
  assert.strictEqual(harness.timers.size, 0);
  assert.strictEqual(SessionFiles.isDirty(), true);
});

test('autosave delay below the minimum is rejected', () => {
  assert.strictEqual(SessionFiles.setAutosaveDelayMs(100), false);
  assert.strictEqual(SessionFiles.autosaveDelayMs(), SessionFiles.AUTOSAVE_DEFAULT_DELAY_MS);
  assert.strictEqual(SessionFiles.setAutosaveDelayMs(1500), true);
  assert.strictEqual(SessionFiles.autosaveDelayMs(), 1500);
});

test('autosave settings persist across a session switch', async () => {
  SessionFiles.setAutosaveEnabled(true);
  SessionFiles.setAutosaveDelayMs(4000);
  SessionFiles.reset('another-slug');

  assert.strictEqual(SessionFiles.autosaveEnabled(), true);
  assert.strictEqual(SessionFiles.autosaveDelayMs(), 4000);
});

// ── session lifecycle ─────────────────────────────────────────────────────────

test('reset clears tree, buffers, pane and pending autosave', async () => {
  SessionFiles.setAutosaveEnabled(true);
  harness.apiHandler = treeHandler({ '': [fileEntry('a.js')] });
  await SessionFiles.loadTree();
  harness.apiHandler = () => ({ content: 'a', mtime: 1 });
  await SessionFiles.openFile('a.js');
  harness.cm.type('edited');
  assert.strictEqual(harness.timers.size, 1);

  SessionFiles.reset('other-slug');

  assert.strictEqual(SessionFiles.slug, 'other-slug');
  assert.strictEqual(SessionFiles.treeLoaded, false);
  assert.strictEqual(Object.keys(SessionFiles.buffers).length, 0);
  assert.strictEqual(SessionFiles.open, null);
  assert.strictEqual(SessionFiles.changed.size, 0);
  assert.strictEqual(harness.timers.size, 0);
  assert.strictEqual(el('sf-tree').innerHTML, '');
});

test('openFile is ignored without a project slug', async () => {
  SessionFiles.reset(null);
  await SessionFiles.openFile('a.js');
  assert.strictEqual(harness.apiCalls.length, 0);
  assert.strictEqual(SessionFiles.open, null);
});

// ── structure show/hide ───────────────────────────────────────────────────────

test('toggleStructure flips and persists the collapsed state', () => {
  CodeView.toggleStructure(el('session-context'));
  assert.strictEqual(harness.store[CodeView.STRUCTURE_COLLAPSED_KEY], '1');
  assert.strictEqual(el('session-context').classList.contains('sf-structure-collapsed'), true);

  CodeView.toggleStructure(el('session-context'));
  assert.strictEqual(harness.store[CodeView.STRUCTURE_COLLAPSED_KEY], '0');
  assert.strictEqual(el('session-context').classList.contains('sf-structure-collapsed'), false);
});

test('a persisted collapsed state is reapplied on session load', () => {
  harness.store[CodeView.STRUCTURE_COLLAPSED_KEY] = '1';
  SessionFiles.reset('proj-slug');
  assert.strictEqual(el('session-context').classList.contains('sf-structure-collapsed'), true);
});

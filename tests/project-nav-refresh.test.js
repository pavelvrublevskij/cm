const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The sidebar Projects group polls /api/projects so new and changed projects show up without a
// page reload; it only re-renders when the list actually changed.

const src = fs.readFileSync(path.join(__dirname, '../public/js/projects.js'), 'utf-8');

let els;
let context;
let response;
let intervals;
let navRows;

function project(slug, extra = {}) {
  return {
    slug, path: '/x/' + slug, favorite: false,
    memoryCount: 0, sessionCount: 0, skillsCount: 0, outputStylesCount: 0,
    hasClaudeMd: false, hasAiMemory: false,
    groupId: null, groupLabel: null, groupPrimary: false, groupParentSlug: null, groupRelPath: null,
    ...extra
  };
}

beforeEach(() => {
  els = {
    'projects-grid': { innerHTML: '' }, 'project-nav-list': { innerHTML: '' }, 'project-nav-count': { textContent: '' },
    'sessions-tab-btn': { textContent: '', style: {} }
  };
  navRows = [];
  response = [];
  intervals = [];
  context = vm.createContext({
    document: { getElementById: id => els[id] || null, querySelectorAll: () => navRows },
    App: { currentProject: null, currentView: 'usage' },
    escapeHtml: s => String(s),
    escapeAttr: s => String(s),
    decodeName: s => s,
    treeIndent: d => d * 14,
    TREE_INDENT_STEP: 14,
    TREE_INDENT_ROOT: 20,
    api: async (url, opts) => {
      if (opts && opts.method === 'PUT') return { ok: true };
      if (response instanceof Error) throw response;
      return JSON.parse(JSON.stringify(response));
    },
    toast: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }
  });
  vm.runInContext(src + '\nthis.Projects = Projects;', context);
});

test('refresh shows a newly added project in the sidebar', async () => {
  context.Projects.data = [project('alpha')];
  context.Projects.renderNav();
  response = [project('alpha'), project('beta')];
  await context.Projects.refresh();
  assert.ok(els['project-nav-list'].innerHTML.includes('data-slug="beta"'));
  assert.strictEqual(els['project-nav-count'].textContent, 2);
});

test('refresh does not re-render when nothing changed', async () => {
  context.Projects.data = [project('alpha')];
  els['project-nav-list'].innerHTML = 'untouched';
  response = [project('alpha')];
  await context.Projects.refresh();
  assert.strictEqual(els['project-nav-list'].innerHTML, 'untouched');
});

test('refresh keeps the current list when the fetch fails', async () => {
  context.Projects.data = [project('alpha')];
  els['project-nav-list'].innerHTML = 'untouched';
  response = new Error('offline');
  await context.Projects.refresh();
  assert.strictEqual(context.Projects.data[0].slug, 'alpha');
  assert.strictEqual(els['project-nav-list'].innerHTML, 'untouched');
});

test('startPolling schedules refresh once', () => {
  context.Projects.startPolling();
  context.Projects.startPolling();
  assert.strictEqual(intervals.length, 1);
  assert.strictEqual(intervals[0].ms, context.Projects.POLL_MS);
  assert.strictEqual(intervals[0].fn, context.Projects.refresh);
});

function navRow(slug) {
  const classes = new Set();
  return { dataset: { slug }, classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c), has: c => classes.has(c) } };
}

test('refresh keeps the open project highlighted and updates its tab counts', async () => {
  context.App.currentView = 'project-detail';
  context.App.currentProject = 'alpha';
  navRows = [navRow('alpha'), navRow('beta')];
  context.Projects.data = [project('alpha'), project('beta')];
  response = [project('alpha', { sessionCount: 3 }), project('beta')];
  await context.Projects.refresh();
  assert.ok(navRows[0].classList.has('active'));
  assert.ok(!navRows[1].classList.has('active'));
  assert.strictEqual(els['sessions-tab-btn'].textContent, 'Sessions (3)');
});

test('a poll that started before a star click does not undo the star', async () => {
  context.Projects.data = [project('alpha')];
  response = [project('alpha', { sessionCount: 1 })];
  const pending = context.Projects.refresh();
  await context.Projects.toggleFavorite('alpha');
  await pending;
  assert.strictEqual(context.Projects.data[0].favorite, true);
});

test('a poll is skipped while a star update is still in flight', async () => {
  context.Projects.data = [project('alpha')];
  context.Projects._favoritePending = 1;
  response = [project('alpha', { sessionCount: 1 })];
  await context.Projects.refresh();
  assert.strictEqual(context.Projects.data[0].sessionCount, 0);
});

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Starred projects are listed first in the sidebar and on All Projects; every other project folds
// under "Other projects", closed by default. With nothing starred both lists render as before.

const src = fs.readFileSync(path.join(__dirname, '../public/js/projects.js'), 'utf-8');

let els;
let context;

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
  els = { 'projects-grid': { innerHTML: '' }, 'project-nav-list': { innerHTML: '' }, 'project-nav-count': { textContent: '' } };
  context = vm.createContext({
    document: { getElementById: id => els[id] || null },
    App: { currentProject: null },
    escapeHtml: s => String(s),
    escapeAttr: s => String(s),
    decodeName: s => s,
    treeIndent: d => d * 14,
    TREE_INDENT_STEP: 14,
    api: async () => ({ ok: true }),
    toast: () => {}
  });
  vm.runInContext(src + '\nthis.Projects = Projects;', context);
});

function render(data) {
  context.Projects.data = data;
  context.Projects.renderGrid();
  context.Projects.renderNav();
}

test('without favorites nothing is folded and no sections are shown', () => {
  render([project('alpha'), project('beta')]);
  assert.ok(!els['project-nav-list'].innerHTML.includes('Other projects'));
  assert.ok(els['project-nav-list'].innerHTML.includes('data-slug="alpha"'));
  assert.ok(!els['projects-grid'].innerHTML.includes('Favorites'));
  assert.ok(els['projects-grid'].innerHTML.includes('alpha'));
});

test('favorites come first and the rest are folded by default', () => {
  render([project('alpha'), project('beta', { favorite: true })]);
  const nav = els['project-nav-list'].innerHTML;
  assert.ok(nav.includes('data-slug="beta"'));
  assert.ok(nav.includes('Other projects'));
  assert.ok(!nav.includes('data-slug="alpha"'), 'non-favorite stays folded');
  const grid = els['projects-grid'].innerHTML;
  assert.ok(grid.indexOf('Favorites') < grid.indexOf('Other projects'));
});

test('opening "Other projects" lists the rest below the favorites', () => {
  render([project('alpha'), project('beta', { favorite: true })]);
  context.Projects.toggleOthers();
  const nav = els['project-nav-list'].innerHTML;
  assert.ok(nav.indexOf('data-slug="beta"') < nav.indexOf('data-slug="alpha"'));
});

test('"Other projects" folds again even after a non-favorite project was opened', () => {
  context.App.currentProject = 'alpha';
  render([project('alpha'), project('beta', { favorite: true })]);
  context.Projects.toggleOthers();
  assert.ok(els['project-nav-list'].innerHTML.includes('data-slug="alpha"'));
  context.Projects.toggleOthers();
  assert.ok(!els['project-nav-list'].innerHTML.includes('data-slug="alpha"'));
});

test('a failed save restores the previous star state', async () => {
  context.api = async () => { throw new Error('down'); };
  render([project('alpha')]);
  await context.Projects.toggleFavorite('alpha');
  assert.strictEqual(context.Projects.data[0].favorite, false);
});

test('every project row shows a star; starred ones are filled', () => {
  render([project('alpha'), project('beta', { favorite: true })]);
  context.Projects.toggleOthers();
  const nav = els['project-nav-list'].innerHTML;
  assert.strictEqual((nav.match(/class="fav-star/g) || []).length, 2);
  assert.strictEqual((nav.match(/fav-star--on/g) || []).length, 1);
});

test('toggleFavorite stars a project and saves it', async () => {
  let call;
  context.api = async (url, opts) => { call = { url, opts }; return { ok: true }; };
  render([project('alpha'), project('beta')]);
  await context.Projects.toggleFavorite('alpha');
  assert.strictEqual(context.Projects.data[0].favorite, true);
  assert.strictEqual(call.url, '/api/projects/alpha/favorite');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(call.opts)), { method: 'PUT', body: { favorite: true } });
  assert.ok(els['project-nav-list'].innerHTML.includes('Other projects'));
});

test('a starred group member is listed with its group label', () => {
  render([
    project('main', { groupId: 'g', groupLabel: 'repo', groupPrimary: true, favorite: true }),
    project('wt', { groupId: 'g', groupLabel: 'repo', groupRelPath: 'wt' })
  ]);
  assert.ok(els['project-nav-list'].innerHTML.includes('repo / main'));
});

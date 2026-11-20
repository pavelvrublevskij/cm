const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The Token Usage project filter lists projects in sidebar order (Projects.listRows): favorites
// first, then the rest; projects with usage but not registered go last. Only projects with usage
// are offered.

function project(slug, extra = {}) {
  return { slug, path: '/x/' + slug, favorite: false, groupId: null, groupParentSlug: null, groupRelPath: null, ...extra };
}

function load(projectsData) {
  const projectsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'projects.js'), 'utf-8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'usage.js'), 'utf-8');
  const listEl = { innerHTML: '' };
  const context = vm.createContext({
    escapeHtml: s => String(s),
    escapeAttr: s => String(s),
    decodeName: s => s,
    TREE_INDENT_STEP: 14,
    document: { getElementById: id => (id === 'filter-projects-list' ? listEl : null) }
  });
  vm.runInContext(projectsSrc + '\nProjects.data = ' + JSON.stringify(projectsData) + ';', context);
  vm.runInContext(src + '\nglobalThis._mod = Usage;', context);
  return { Usage: context._mod, listEl };
}

const order = html => [...html.matchAll(/title="([^"]+)"/g)].map(m => m[1]);
const headers = html => [...html.matchAll(/multi-select-group">([^<]+)</g)].map(m => m[1]);

test('favorites (with nested projects) come first, then the rest under Other projects', () => {
  const { Usage, listEl } = load([
    project('a'),
    project('z', { favorite: true }),
    project('child', { groupParentSlug: 'z' })
  ]);
  Usage.allProjects = [{ slug: 'a', name: '/x/a' }, { slug: 'child', name: '/x/child' }, { slug: 'z', name: '/x/z' }];
  Usage.renderDropdownList('projects');
  assert.deepStrictEqual(order(listEl.innerHTML), ['/x/z', '/x/child', '/x/a']);
  assert.deepStrictEqual(headers(listEl.innerHTML), ['★ Favorites', 'Other projects']);
  assert.strictEqual(listEl.innerHTML.split('fav-star--on').length - 1, 2);
});

test('without favorites there are no headers and no stars; unregistered projects go last', () => {
  const { Usage, listEl } = load([project('b'), project('a')]);
  Usage.allProjects = [{ slug: 'gone', name: '/old/gone' }, { slug: 'a', name: '/x/a' }, { slug: 'b', name: '/x/b' }];
  Usage.renderDropdownList('projects');
  assert.deepStrictEqual(order(listEl.innerHTML), ['/x/b', '/x/a', '/old/gone']);
  assert.deepStrictEqual(headers(listEl.innerHTML), []);
  assert.ok(!listEl.innerHTML.includes('fav-star--on'));
});

test('search matches the folder name, not the sidebar label', () => {
  const { Usage, listEl } = load([project('C--code-foo', { favorite: true }), project('C--code-bar')]);
  Usage.allProjects = [{ slug: 'C--code-foo', name: 'C:/code/foo' }, { slug: 'C--code-bar', name: 'C:/code/bar' }];
  Usage.filterOptions('projects', 'code');
  assert.deepStrictEqual(order(listEl.innerHTML), []);
  Usage.filterOptions('projects', 'ba');
  assert.deepStrictEqual(order(listEl.innerHTML), ['C:/code/bar']);
});

test('only projects with usage are offered, and a search drops headers left empty', () => {
  const { Usage, listEl } = load([project('fav', { favorite: true }), project('other'), project('idle')]);
  Usage.allProjects = [{ slug: 'fav', name: '/x/fav' }, { slug: 'other', name: '/x/other' }];
  Usage.renderDropdownList('projects');
  assert.deepStrictEqual(order(listEl.innerHTML), ['/x/fav', '/x/other']);
  Usage.filterOptions('projects', 'oth');
  assert.deepStrictEqual(order(listEl.innerHTML), ['/x/other']);
  assert.deepStrictEqual(headers(listEl.innerHTML), ['Other projects']);
});

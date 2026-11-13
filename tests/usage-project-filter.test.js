const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The Token Usage project filter lists starred projects (and those nested under one) first.

function load(projectsData) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'usage.js'), 'utf-8');
  const listEl = { innerHTML: '' };
  const context = vm.createContext({
    escapeHtml: s => String(s),
    document: { getElementById: id => (id === 'filter-projects-list' ? listEl : null) },
    Projects: {
      data: projectsData,
      _inFavorites: p => p.favorite || projectsData.some(a => a.slug === p.groupParentSlug && a.favorite)
    }
  });
  vm.runInContext(src + '\nglobalThis._mod = Usage;', context);
  return { Usage: context._mod, listEl };
}

const order = html => [...html.matchAll(/title="([^"]+)"/g)].map(m => m[1]);

test('starred and nested-under-starred projects come first, then alphabetical', () => {
  const { Usage, listEl } = load([
    { slug: 'a', favorite: false },
    { slug: 'z', favorite: true },
    { slug: 'child', favorite: false, groupParentSlug: 'z' }
  ]);
  Usage.allProjects = [{ slug: 'a', name: '/x/a' }, { slug: 'child', name: '/x/child' }, { slug: 'z', name: '/x/z' }];
  Usage.renderDropdownList('projects');
  assert.deepStrictEqual(order(listEl.innerHTML), ['/x/child', '/x/z', '/x/a']);
  assert.strictEqual(listEl.innerHTML.split('fav-star--on').length - 1, 2);
});

test('without favorites the list stays alphabetical with no stars', () => {
  const { Usage, listEl } = load([]);
  Usage.allProjects = [{ slug: 'b', name: '/x/b' }, { slug: 'a', name: '/x/a' }];
  Usage.renderDropdownList('projects');
  assert.deepStrictEqual(order(listEl.innerHTML), ['/x/a', '/x/b']);
  assert.ok(!listEl.innerHTML.includes('fav-star--on'));
});

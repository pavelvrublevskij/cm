const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Projects.listRows is the one sidebar ordering every project dropdown renders from, and
// Projects.selectHtml turns it into a <select> with option groups.

const src = fs.readFileSync(path.join(__dirname, '../public/js/projects.js'), 'utf-8');

let Projects;

function project(slug, extra = {}) {
  return {
    slug, path: '/x/' + slug, favorite: false,
    groupId: null, groupLabel: null, groupPrimary: false, groupParentSlug: null, groupRelPath: null,
    ...extra
  };
}

beforeEach(() => {
  const context = vm.createContext({
    escapeHtml: s => String(s),
    escapeAttr: s => String(s),
    decodeName: s => 'n-' + s
  });
  vm.runInContext(src + '\nthis.Projects = Projects;', context);
  Projects = context.Projects;
});

const shape = rows => [...rows].map(r => r.kind === 'project' ? `${r.section || '-'}:${r.depth}:${r.label}` : `[${r.kind}:${r.label}]`);

test('without favorites: groups (tree, primary first) then ungrouped, no sections', () => {
  Projects.data = [
    project('solo'),
    project('g-b', { groupId: 'g', groupLabel: 'Grp', groupRelPath: 'b' }),
    project('g-a', { groupId: 'g', groupLabel: 'Grp', groupRelPath: 'a', groupPrimary: true }),
    project('g-a-c', { groupId: 'g', groupLabel: 'Grp', groupRelPath: 'c', groupParentSlug: 'g-a' })
  ];
  assert.deepStrictEqual(shape(Projects.listRows()), ['[group:Grp]', '-:0:a', '-:1:c', '-:0:b', '-:0:n-solo']);
});

test('with favorites: favorite entries with nested children, then Other projects', () => {
  Projects.data = [
    project('top', { favorite: true }),
    project('kid', { groupParentSlug: 'top', groupRelPath: 'kid' }),
    project('rest')
  ];
  assert.deepStrictEqual(shape(Projects.listRows()),
    ['[section:Favorites]', 'favorites:0:n-top', 'favorites:1:kid', '[section:Other projects]', 'others:0:n-rest']);
});

test('extras not registered go last; registered ones are not duplicated', () => {
  Projects.data = [project('a')];
  const rows = Projects.listRows([{ slug: 'a', label: 'A', title: '/a' }, { slug: 'old', label: 'old', title: '/old' }]);
  assert.deepStrictEqual(shape(rows), ['-:0:n-a', '-:0:old']);
  assert.strictEqual(rows[1].project, null);
});

test('pruneRows drops headers with nothing under them', () => {
  Projects.data = [
    project('fav', { favorite: true }),
    project('m', { groupId: 'g', groupLabel: 'Grp' }),
    project('rest')
  ];
  const rows = Projects.listRows().filter(r => r.kind !== 'project' || r.slug === 'rest');
  assert.deepStrictEqual(shape(Projects.pruneRows(rows)), ['[section:Other projects]', 'others:0:n-rest']);
});

test('selectHtml: leading options, optgroups per section and group, indent, selection, filter', () => {
  Projects.data = [
    project('top', { favorite: true }),
    project('kid', { groupParentSlug: 'top', groupRelPath: 'kid' }),
    project('m', { groupId: 'g', groupLabel: 'Grp', groupRelPath: 'm' }),
    project('rest'),
    project('hidden')
  ];
  const html = Projects.selectHtml('sel', 'rest', { leading: [['', 'Global']], filter: s => s !== 'hidden' });
  assert.strictEqual(html,
    '<select id="sel"><option value="">Global</option>'
    + '<optgroup label="★ Favorites"><option value="top" title="/x/top">n-top</option>'
    + '<option value="kid" title="/x/kid">  kid</option></optgroup>'
    + '<optgroup label="Grp"><option value="m" title="/x/m">m</option></optgroup>'
    + '<optgroup label="Other projects"><option value="rest" title="/x/rest" selected>n-rest</option></optgroup>'
    + '</select>');
});

test('selectHtml without favorites leaves ungrouped projects outside option groups', () => {
  Projects.data = [project('a'), project('b')];
  assert.strictEqual(Projects.selectHtml('s', null),
    '<select id="s"><option value="a" title="/x/a">n-a</option><option value="b" title="/x/b">n-b</option></select>');
});

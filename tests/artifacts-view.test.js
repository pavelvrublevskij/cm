const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load artifacts.js in a sandbox to assert the global Artifacts view groups cards by project.
const els = {};
const ctx = vm.createContext({
  Sessions: {},
  document: { getElementById: id => (els[id] || (els[id] = { innerHTML: '', style: {} })) },
  api: async () => ctx._artifacts,
  showLoading: () => {},
  escapeHtml: s => String(s),
  escapeAttr: s => String(s),
  decodeName: s => 'name:' + s,
  timeAgo: () => 'now',
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/artifacts.js'), 'utf-8') + '\nglobalThis._Artifacts = Artifacts;', ctx);
const Artifacts = ctx._Artifacts;

const art = (slug, id, updatedAt) => ({ slug, sessionId: 's', artifactId: id, url: 'https://x/' + id, title: id, updatedAt });

test('_groupByProject keeps newest-first order across and within projects', () => {
  const groups = Artifacts._groupByProject([
    art('b', 'b1', '2026-03-01'), art('a', 'a1', '2026-02-01'), art('b', 'b2', '2026-01-01'),
  ]);
  assert.strictEqual(groups.map(g => g.slug).join(','), 'b,a');
  assert.strictEqual(groups[0].artifacts.map(a => a.artifactId).join(','), 'b1,b2');
});

test('the global view renders one group per project with its count', async () => {
  ctx._artifacts = [art('b', 'b1', '2026-03-01'), art('a', 'a1', '2026-02-01'), art('b', 'b2', '2026-01-01')];
  await Artifacts.load();
  const html = els['artifacts-list'].innerHTML;
  assert.strictEqual(html.split('artifact-group-title').length - 1, 2);
  assert.ok(html.includes('name:b (2)'));
  assert.ok(html.includes('name:a (1)'));
  assert.ok(html.indexOf('name:b') < html.indexOf('name:a'));
});

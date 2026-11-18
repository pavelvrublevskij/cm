const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// The Export / Import / Copy to… controls makeFrontmatterCrud adds when transferKind is set:
// lists without it keep the plain delete button; a project list may copy to Global, the global
// list only to projects; every request goes to /api/<kind>/<action>/<scope>.
const src = fs.readFileSync(path.join(__dirname, '../public/js/crud-frontmatter.js'), 'utf-8');

const harness = {};

function makeContext() {
  const context = vm.createContext({
    document: {
      getElementById: id => {
        if (!harness.els[id]) harness.els[id] = { id, innerHTML: '', value: harness.values[id] || '' };
        return harness.els[id];
      },
      querySelectorAll: () => [],
      createElement: () => ({ click() {} }),
      body: { appendChild() {}, removeChild() {} }
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'),
    escapeAttr: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
      .split('"').join('&quot;').split("'").join('&#39;'),
    showLoading() {},
    toast: (msg, kind) => harness.toasts.push([msg, kind]),
    formGroup: (label, html) => `<label>${label}</label>${html}`,
    decodeName: slug => slug,
    openModal: m => harness.modals.push(m),
    api: async () => harness.list,
    fetch: async (url, init) => {
      harness.fetches.push([url, init]);
      return harness.response;
    },
    Projects: { data: [{ slug: 'p1', path: '/p1' }, { slug: 'p2', path: '/p2' }] }
  });
  vm.runInContext(src + '\nthis.makeFrontmatterCrud = makeFrontmatterCrud;', context);
  return context;
}

function crud(context, extra) {
  return context.makeFrontmatterCrud({
    globalName: 'X', containerId: 'c', apiBase: '/api/skills/global', itemKey: 'name',
    idPrefix: 'x', itemLabel: 'Skill', cardTitle: i => i.name, ...extra
  });
}

beforeEach(() => {
  harness.els = {};
  harness.values = {};
  harness.toasts = [];
  harness.modals = [];
  harness.fetches = [];
  harness.list = [{ name: 'alpha', description: 'd' }];
  harness.response = { ok: true, status: 200, json: async () => ({ ok: true, imported: 1 }), headers: { get: () => '1' }, blob: async () => ({}) };
});

test('without transferKind the card keeps the plain delete button and no transfer bar', async () => {
  const m = crud(makeContext());
  await m.load();
  const html = harness.els.c.innerHTML;
  assert.ok(html.includes('prop-action-btn danger'));
  assert.ok(!html.includes('Export all'));
  assert.ok(!html.includes('action-menu'));
});

test('with transferKind the list shows Export all, Import and a card menu', async () => {
  const m = crud(makeContext(), { transferKind: 'skills' });
  await m.load();
  const html = harness.els.c.innerHTML;
  assert.ok(html.includes('X.exportItems()'));
  assert.ok(html.includes('X.triggerImport()'));
  assert.ok(html.includes('X.exportItems(&quot;alpha&quot;)'));
  assert.ok(html.includes('X.showCopy(&quot;alpha&quot;)'));
  assert.ok(html.includes('X.remove(&quot;alpha&quot;)'));
  assert.ok(!html.includes('prop-action-btn danger'));
});

test('a quote in an imported name stays inside the JS string of the onclick handler', async () => {
  harness.list = [{ name: "x');alert(1);('", description: '' }];
  const m = crud(makeContext(), { transferKind: 'skills' });
  await m.load();
  const html = harness.els.c.innerHTML;
  // What the browser runs after decoding the attribute: one call with the whole name as its argument.
  const attr = html.match(/onclick="(X\.edit\([^"]*\))"/)[1];
  const js = attr.split('&quot;').join('"').split('&#39;').join("'").split('&amp;').join('&');
  const calls = [];
  new Function('X', js)({ edit: (...args) => calls.push(args) });
  assert.deepStrictEqual(calls, [["x');alert(1);('"]]);
});

test('an empty list still offers Import but not Export all', async () => {
  harness.list = [];
  const m = crud(makeContext(), { transferKind: 'skills' });
  await m.load();
  const html = harness.els.c.innerHTML;
  assert.ok(html.includes('X.triggerImport()'));
  assert.ok(!html.includes('Export all'));
});

test('export uses the global scope, or the project scope when a slug is loaded', async () => {
  const g = crud(makeContext(), { transferKind: 'agents' });
  await g.exportItems('a.md');
  assert.strictEqual(harness.fetches[0][0], '/api/agents/export/global?names=a.md');

  const p = crud(makeContext(), { transferKind: 'agents' });
  await p.load('p1');
  await p.exportItems();
  assert.strictEqual(harness.fetches[1][0], '/api/agents/export/project/p1');
});

test('copy targets: global list offers only projects; project list offers Global and other projects', async () => {
  const g = crud(makeContext(), { transferKind: 'skills' });
  g.showCopy('alpha');
  const gBody = harness.modals[0].body;
  assert.ok(!gBody.includes('value="global"'));
  assert.ok(gBody.includes('value="p1"') && gBody.includes('value="p2"'));

  const p = crud(makeContext(), { transferKind: 'skills' });
  await p.load('p1');
  p.showCopy('alpha');
  const pBody = harness.modals[1].body;
  assert.ok(pBody.includes('value="global"'));
  assert.ok(!pBody.includes('value="p1"'));
  assert.ok(pBody.includes('value="p2"'));
});

test('copy posts the target and asks before overwriting on a 409', async () => {
  const m = crud(makeContext(), { transferKind: 'skills' });
  harness.response = { ok: false, status: 409, json: async () => ({ error: 'conflict', conflicts: ['alpha'] }) };
  await m.copyTo('alpha', 'p2', false);
  assert.strictEqual(harness.fetches[0][0], '/api/skills/copy/global/alpha?overwrite=0');
  assert.strictEqual(harness.fetches[0][1].body, JSON.stringify({ target: 'p2' }));
  assert.strictEqual(harness.modals.length, 1);
  assert.ok(harness.modals[0].body.includes('alpha'));

  harness.response = { ok: true, status: 200, json: async () => ({ ok: true }) };
  await harness.modals[0].buttons[0].onClick();
  assert.strictEqual(harness.fetches[1][0], '/api/skills/copy/global/alpha?overwrite=1');
  assert.deepStrictEqual(harness.toasts.at(-1), ['Skill copied', undefined]);
});

test('import posts the zip to the scope and retries with overwrite after confirming', async () => {
  const m = crud(makeContext(), { transferKind: 'agents' });
  await m.load('p1');
  harness.response = { ok: false, status: 409, json: async () => ({ error: 'conflict', conflicts: ['a.md'] }) };
  await m.doImport(Buffer.from('zip'), false);
  assert.strictEqual(harness.fetches[0][0], '/api/agents/import/project/p1?overwrite=0');
  harness.response = { ok: true, status: 200, json: async () => ({ ok: true, imported: 1 }) };
  await harness.modals[0].buttons[0].onClick();
  assert.strictEqual(harness.fetches[1][0], '/api/agents/import/project/p1?overwrite=1');
});

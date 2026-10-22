const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const fields = {};
const toasts = [];
const sandbox = {
  document: {
    createElement: () => ({ set textContent(t) { this.innerHTML = String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }),
    documentElement: { setAttribute: () => {} },
    getElementById: id => fields[id] || null
  },
  window: {},
  localStorage: { getItem: () => null, setItem: () => {} }
};
vm.createContext(sandbox);
for (const f of ['utils.js', 'modal.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf-8'), sandbox);
}
vm.runInContext('toast = (m, t) => globalThis._toasts.push([m, t]); globalThis._api = { validateAgent, agentFileName, agentOptionalFields, readAgentOptionalFields, agentCreateFields, agentCreateBody };', Object.assign(sandbox, { _toasts: toasts }));
const A = sandbox._api;

test('validateAgent requires name and description and enforces the name rules', () => {
  assert.strictEqual(A.validateAgent({ name: 'reviewer', description: 'Reviews code' }), null);
  assert.match(A.validateAgent({ description: 'd' }), /Name is required/);
  assert.match(A.validateAgent({ name: 'a:b', description: 'd' }), /cannot contain ":"/);
  assert.match(A.validateAgent({ name: '-x', description: 'd' }), /cannot start with "-"/);
  assert.match(A.validateAgent({ name: 'x'.repeat(257), description: 'd' }), /at most 256/);
  assert.match(A.validateAgent({ name: 'x', description: '  ' }), /Description is required/);
});

test('agentFileName turns a name into a safe .md file name', () => {
  assert.strictEqual(A.agentFileName('Code Reviewer!'), 'code-reviewer.md');
  assert.strictEqual(A.agentFileName('../etc/passwd'), 'etc-passwd.md');
  assert.strictEqual(A.agentFileName('!!!'), null);
});

test('every agent field with fixed values is a dropdown', () => {
  const html = A.agentOptionalFields({ model: 'opus', permissionMode: 'plan', memory: 'project', color: 'cyan', effort: 'low' }, 'a');
  for (const id of ['a-model', 'a-effort', 'a-permissionMode', 'a-memory', 'a-color']) {
    assert.match(html, new RegExp('<select id="' + id + '">'), id);
  }
  assert.match(html, /value="opus" selected/);
  assert.match(html, /value="plan" selected/);
  assert.match(html, /value="cyan" selected/);
  assert.match(html, /<input type="text" id="a-tools"/);
  assert.match(html, /<input type="text" id="a-disallowedTools"/);
});

test('the create dialog marks Name and Description as required', () => {
  const html = A.agentCreateFields('g', '~/.claude/agents/');
  assert.match(html, /<label>Name \*<\/label>/);
  assert.match(html, /<label>Description \*<\/label>/);
  assert.match(html, /Saved as <code>~\/\.claude\/agents\//);
});

function fillCreate(values) {
  for (const k of Object.keys(fields)) delete fields[k];
  fields['g-new-name'] = { value: values.name || '' };
  fields['g-new-desc'] = { value: values.description || '' };
  for (const key of ['tools', 'disallowedTools', 'model', 'effort', 'permissionMode', 'memory', 'color']) {
    fields['g-new-' + key] = { value: values[key] || '' };
  }
}

test('agentCreateBody builds frontmatter from the dialog, leaving defaults out', () => {
  fillCreate({ name: 'Code Reviewer', description: 'Reviews code', model: 'haiku', tools: 'Read, Grep' });
  const body = A.agentCreateBody('g', []);
  assert.strictEqual(body.key, 'code-reviewer.md');
  assert.strictEqual(JSON.stringify(body.frontmatter), JSON.stringify({ name: 'Code Reviewer', description: 'Reviews code', tools: 'Read, Grep', model: 'haiku' }));
});

test('agentCreateBody refuses missing required fields and an existing file', () => {
  toasts.length = 0;
  fillCreate({ name: '', description: 'x' });
  assert.strictEqual(A.agentCreateBody('g', []), null);
  fillCreate({ name: 'reviewer', description: '' });
  assert.strictEqual(A.agentCreateBody('g', []), null);
  fillCreate({ name: 'reviewer', description: 'd' });
  assert.strictEqual(A.agentCreateBody('g', [{ filename: 'reviewer.md' }]), null);
  assert.deepStrictEqual(toasts.map(t => t[1]), ['error', 'error', 'error']);
  assert.match(toasts[2][0], /already exists/);
});

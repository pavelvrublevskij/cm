const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// utils.js (the selects) plus modal.js (formGroup/formRow), loaded as the browser loads them.
const fields = {};
const sandbox = {
  document: {
    // escapeHtml goes through textContent -> innerHTML; this does the same escaping without a DOM.
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
vm.runInContext('globalThis._api = { frontmatterSelectHtml, skillModelEffortFields, readSkillModelEffort, SKILL_MODELS, SKILL_EFFORTS };', sandbox);
const { frontmatterSelectHtml, skillModelEffortFields, readSkillModelEffort, SKILL_EFFORTS } = sandbox._api;

test('model options are the values Claude Code accepts, with Default leaving the key out', () => {
  const html = frontmatterSelectHtml('m', sandbox._api.SKILL_MODELS, undefined);
  for (const v of ['inherit', 'sonnet', 'opus', 'haiku', 'fable']) assert.ok(html.includes(`value="${v}"`), v);
  assert.match(html, /<option value="" selected>Default<\/option>/);
});

test('effort options are low to max', () => {
  assert.deepStrictEqual(SKILL_EFFORTS.map(([v]) => v).join(','), ',low,medium,high,xhigh,max');
});

test('the current value is selected', () => {
  assert.match(frontmatterSelectHtml('e', SKILL_EFFORTS, 'high'), /<option value="high" selected>High<\/option>/);
});

test('an unknown value already in the file is kept as a custom option', () => {
  const html = frontmatterSelectHtml('m', sandbox._api.SKILL_MODELS, 'claude-opus-4-6');
  assert.match(html, /<option value="claude-opus-4-6" selected>claude-opus-4-6 \(custom\)<\/option>/);
});

test('the skill editor shows Model and Effort selects', () => {
  const html = skillModelEffortFields({ frontmatter: { model: 'haiku', effort: 'low' } }, 'skill');
  assert.match(html, /<label>Model<\/label><select id="skill-edit-model">/);
  assert.match(html, /<label>Effort<\/label><select id="skill-edit-effort">/);
  assert.match(html, /value="haiku" selected/);
  assert.match(html, /value="low" selected/);
});

test('a custom value with a quote cannot break out of its attribute', () => {
  const html = frontmatterSelectHtml('m', sandbox._api.SKILL_MODELS, 'x" onmouseover="y');
  assert.ok(html.includes('value="x&quot; onmouseover=&quot;y"'), 'the quote is escaped inside the attribute');
});

test('reading the selects sets chosen values and removes Default ones', () => {
  fields['skill-edit-model'] = { value: 'sonnet' };
  fields['skill-edit-effort'] = { value: '' };
  const fm = { name: 'x', model: 'opus', effort: 'max' };
  readSkillModelEffort(fm, 'skill');
  assert.strictEqual(fm.model, 'sonnet');
  assert.ok(!('effort' in fm), 'Default removes the key');
});

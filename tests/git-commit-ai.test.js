const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'git-panel.js'), 'utf-8');
const store = {};
const context = vm.createContext({
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  escapeHtml: t => String(t),
  createTerminalPanelUI: () => ({}),
  window: {},
  document: { getElementById: () => null, querySelectorAll: () => [] }
});
vm.runInContext(src + '\nglobalThis._GitPanel = GitPanel;', context);
const GitPanel = context._GitPanel;

test('AI commit settings default to Haiku with low effort', () => {
  delete store[GitPanel.AI_SETTINGS_KEY];
  const s = GitPanel.aiSettings();
  assert.strictEqual(s.model, 'haiku');
  assert.strictEqual(s.effort, 'low');
});

test('AI commit settings are remembered, and unknown saved values fall back', () => {
  GitPanel.setAiSetting('model', 'sonnet');
  GitPanel.setAiSetting('effort', 'high');
  assert.strictEqual(GitPanel.aiSettings().model, 'sonnet');
  assert.strictEqual(GitPanel.aiSettings().effort, 'high');
  store[GitPanel.AI_SETTINGS_KEY] = JSON.stringify({ model: 'gpt-4', effort: 'huge' });
  assert.strictEqual(GitPanel.aiSettings().model, 'haiku');
  assert.strictEqual(GitPanel.aiSettings().effort, 'low');
});

test('the Commit split button offers AI generation with model, effort and an AI notice', () => {
  delete store[GitPanel.AI_SETTINGS_KEY];
  GitPanel._busy = null;
  const html = GitPanel._commitSplitHtml(3);
  assert.match(html, /git-split-main" onclick="GitPanel\.commit\(false\)">Commit<\/button>/);
  assert.match(html, /GitPanel\.generateMessage\(false\)">&#10024; Generate message with AI/);
  assert.match(html, /GitPanel\.generateMessage\(true\)">&#10024; Generate with AI &amp; commit/);
  assert.match(html, /<option value="haiku" selected>Haiku<\/option>/);
  assert.match(html, /<option value="low" selected>Low<\/option>/);
  assert.match(html, /Uses AI: the selected files' changes are sent to Claude/);
});

test('the split button is disabled with nothing to commit and shows progress while generating', () => {
  GitPanel._busy = null;
  assert.match(GitPanel._commitSplitHtml(0), /git-split-main"[^>]* disabled/);
  GitPanel._busy = 'generate';
  const busy = GitPanel._commitSplitHtml(3);
  assert.match(busy, /btn-spinner"><\/span>Writing message…/);
  assert.match(busy, /git-split-toggle"[^>]* disabled/);
  GitPanel._busy = null;
});

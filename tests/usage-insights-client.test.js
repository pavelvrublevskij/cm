const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function load(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf-8');
  const context = vm.createContext({ escapeHtml, Usage: { basename: p => String(p).split(/[\\/]/).pop(), fmtModel: m => m.replace(/^claude-/, '') } });
  vm.runInContext(src + `\nglobalThis._mod = ${name};`, context);
  return context._mod;
}

const UsageInsights = load('usage-insights.js', 'UsageInsights');
const UsageHints = load('usage-hints.js', 'UsageHints');

const LINKS = [
  { sessionId: '1b2c3d4e-0000-4000-8000-000000000001', slug: 'C--proj-a' },
  { sessionId: '1b2c3d4e-0000-4000-8000-000000000002', slug: 'C--proj-b' }
];

test('splitSessionText turns known session ids into link parts', () => {
  const parts = UsageInsights.splitSessionText('See 1b2c3d4e-0000-4000-8000-000000000001 and 1b2c3d4e-0000-4000-8000-000000000002.', LINKS);
  assert.strictEqual(JSON.stringify(parts), JSON.stringify([
    { text: 'See ' },
    { sessionId: LINKS[0].sessionId, slug: 'C--proj-a' },
    { text: ' and ' },
    { sessionId: LINKS[1].sessionId, slug: 'C--proj-b' },
    { text: '.' }
  ]));
});

test('splitSessionText leaves text without known ids untouched', () => {
  const parts = UsageInsights.splitSessionText('No 1b2c3d4e-ffff-4000-8000-000000000009 here', LINKS);
  assert.strictEqual(JSON.stringify(parts), JSON.stringify([{ text: 'No 1b2c3d4e-ffff-4000-8000-000000000009 here' }]));
  assert.strictEqual(UsageInsights.splitSessionText('x', []).length, 1);
});

test('storedScopeText describes a saved report scope', () => {
  assert.strictEqual(
    UsageInsights.storedScopeText({ projects: ['C:\\code\\cm'], models: 'all', from: '2026-10-01', to: 'now' }),
    'cm \u00b7 All models \u00b7 2026-10-01 \u2192 now');
  assert.strictEqual(
    UsageInsights.storedScopeText({ projects: 'all', models: ['claude-opus-4-6'], from: 'beginning', to: '2026-10-22' }),
    'All projects \u00b7 opus-4-6 \u00b7 beginning \u2192 2026-10-22');
});

test('hints html shows a chip per hint and the open one with its detail', () => {
  const hints = [
    { id: 'cache-hit', level: 'warn', title: 'Cache hit 72%', detail: 'Low <cache>' },
    { id: 'opus-share', level: 'info', title: '90% of cost on Opus', detail: 'Try Sonnet' }
  ];
  const closed = UsageHints.html(hints, null);
  assert.match(closed, /usage-hint usage-hint-warn"[^>]*>\u26a0 Cache hit 72%/);
  assert.match(closed, /usage-hint usage-hint-info"[^>]*>\u2139 90% of cost on Opus/);
  assert.ok(!closed.includes('usage-hint-detail'));

  const open = UsageHints.html(hints, 'cache-hit');
  assert.match(open, /usage-hint-warn usage-hint-open/);
  assert.match(open, /<div class="usage-hint-detail">Low &lt;cache&gt;<\/div>/);
});

test('hints html says all clear when there are no warnings', () => {
  assert.match(UsageHints.html([], null), /No efficiency warnings for this selection/);
});

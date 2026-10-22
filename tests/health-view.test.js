const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'health.js'), 'utf-8');
const context = vm.createContext({ escapeHtml });
vm.runInContext(src + '\nglobalThis._Health = Health;', context);
const Health = context._Health;

const DATA = {
  checkedAt: '2026-10-22T10:00:00.000Z',
  projectCount: 3,
  counts: { error: 1, warn: 1, info: 0 },
  findings: [
    { severity: 'error', area: 'mcp', title: 'MCP server "x" will not start', detail: 'Command <y> missing', scope: 'Global', location: 'C:\\h\\.claude.json' },
    { severity: 'warn', area: 'claude-md', title: 'CLAUDE.md is large', detail: 'big', scope: 'proj', slug: 'C--proj', location: 'C:\\proj\\CLAUDE.md' }
  ]
};

test('the summary counts errors, warnings and info', () => {
  const html = Health.html(DATA);
  assert.match(html, /1 error</);
  assert.match(html, /1 warning</);
  assert.match(html, /0 info/);
  assert.match(html, /3 projects checked/);
});

test('every area gets a section; clean areas say so', () => {
  const html = Health.html(DATA);
  for (const area of Health.AREAS) assert.ok(html.includes('<h3>' + escapeHtml(area.title) + '</h3>'), area.title);
  assert.strictEqual((html.match(/No issues/g) || []).length, 3);
});

test('findings are escaped and link to where they can be fixed', () => {
  const html = Health.html(DATA);
  assert.match(html, /Command &lt;y&gt; missing/);
  assert.match(html, /href="#mcp-servers">Open/);
  assert.match(html, /href="#project-detail\/C--proj">Open/);
  assert.match(html, /mark-tip-scope mark-tip-global">Global/);
});

test('link picks the settings or keybindings page for global JSON files', () => {
  assert.strictEqual(Health.link({ area: 'json', location: 'C:\\h\\.claude\\settings.local.json' }), '#settings');
  assert.strictEqual(Health.link({ area: 'json', location: '/h/.claude/keybindings.json' }), '#keybindings');
  assert.strictEqual(Health.link({ area: 'json', location: '/h/.claude.json' }), '');
});

test('before a connection test the MCP section explains what Test connections does', () => {
  const html = Health.html(DATA, null, false);
  assert.match(html, /onclick="Health\.testMcp\(\)">Test connections<\/button>/);
  assert.match(html, /runs <code>claude mcp list<\/code>/);
});

test('while testing, the button is disabled and a spinner shows', () => {
  const html = Health.html(DATA, null, true);
  assert.match(html, /Health\.testMcp\(\)" disabled>Test connections/);
  assert.match(html, /Connecting to each server/);
});

test('live results list every server and add failures to the counts', () => {
  const live = {
    checkedAt: '2026-10-22T10:05:00.000Z',
    servers: [
      { name: 'docs', status: 'Connected', level: 'ok' },
      { name: 'atlassian', status: 'Failed to connect', level: 'error' }
    ],
    findings: [{ severity: 'error', area: 'mcp', title: 'MCP server "atlassian" failed to connect', detail: 'Failed to connect', scope: 'Global', live: true }]
  };
  const html = Health.html(DATA, live, false);
  assert.match(html, /2 errors</);
  assert.match(html, /health-live-row health-ok[\s\S]*docs[\s\S]*Connected/);
  assert.match(html, /MCP server &quot;atlassian&quot; failed to connect/);
  assert.match(html, /Live status/);
});

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, paths } = require('./helpers/app');
const { parseSearchQuery } = require('../lib/session-search');

const SLUG = 'search-filters-proj';
const PROJECT_DIR = path.join(paths.PROJECTS_DIR, SLUG);
const SESSION_EDIT = 'f1111111-1111-1111-1111-111111111111';
const SESSION_CHAT = 'f2222222-2222-2222-2222-222222222222';
const SESSION_SUB = 'f3333333-3333-3333-3333-333333333333';

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function toolUse(name, input) {
  return { type: 'assistant', timestamp: '2026-02-01T10:00:05.000Z', message: { content: [{ type: 'tool_use', id: name, name, input }] } };
}

before(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  writeJsonl(path.join(PROJECT_DIR, SESSION_EDIT + '.jsonl'), [
    { type: 'custom-title', customTitle: 'Refactor the parser' },
    { type: 'user', timestamp: '2026-02-01T10:00:00.000Z', gitBranch: 'feature/parser', message: { content: 'fix the widget parser' } },
    toolUse('Edit', { file_path: 'C:\\work\\app\\src\\parser.js', old_string: 'a', new_string: 'b' }),
    toolUse('Bash', { command: 'npm test' }),
  ]);
  writeJsonl(path.join(PROJECT_DIR, SESSION_CHAT + '.jsonl'), [
    { type: 'user', timestamp: '2026-02-02T10:00:00.000Z', gitBranch: 'main', message: { content: 'talk about the widget parser' } },
    toolUse('Read', { file_path: '/work/app/src/parser.js' }),
  ]);
  writeJsonl(path.join(PROJECT_DIR, SESSION_SUB + '.jsonl'), [
    { type: 'user', timestamp: '2026-02-03T10:00:00.000Z', gitBranch: 'main', message: { content: 'delegate it' } },
  ]);
  writeJsonl(path.join(PROJECT_DIR, SESSION_SUB, 'subagents', 'agent-1.jsonl'), [
    toolUse('Write', { file_path: '/work/app/docs/notes.md', content: 'x' }),
  ]);
});

function search(q) {
  return request(app).get(`/api/projects/${SLUG}/sessions/search`).query({ q });
}

test('parseSearchQuery: splits filters from free text, quoted values keep spaces', () => {
  const q = parseSearchQuery('widget n:Refactor f:"src/my file.js" t:edit b:feature extra');
  assert.strictEqual(q.text, 'widget extra');
  assert.deepStrictEqual(q.filters, { name: ['refactor'], file: ['src/my file.js'], tool: ['edit'], branch: ['feature'] });
  assert.strictEqual(q.hasFilters, true);
});

test('parseSearchQuery: unknown prefixes and mid-word colons stay free text', () => {
  const q = parseSearchQuery('x:1 http://a.b nf:z');
  assert.strictEqual(q.text, 'x:1 http://a.b nf:z');
  assert.strictEqual(q.hasFilters, false);
});

test('search f: matches only sessions that edited the file', async () => {
  const res = await search('f:parser.js');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.map(s => s.sessionId), [SESSION_EDIT]);
  const snip = res.body[0].snippets[0];
  assert.strictEqual(snip.label, 'file');
  assert.strictEqual(snip.text, 'C:/work/app/src/parser.js');
});

test('search t: matches by tool name', async () => {
  const res = await search('t:bash');
  assert.deepStrictEqual(res.body.map(s => s.sessionId), [SESSION_EDIT]);
  assert.strictEqual(res.body[0].snippets[0].label, 'tool');
  assert.ok(res.body[0].snippets[0].text.startsWith('Bash'));
});

test('search b: matches by git branch', async () => {
  const res = await search('b:feature/parser');
  assert.deepStrictEqual(res.body.map(s => s.sessionId), [SESSION_EDIT]);
});

test('search n: matches the session name', async () => {
  const res = await search('n:refactor');
  assert.deepStrictEqual(res.body.map(s => s.sessionId), [SESSION_EDIT]);
  assert.strictEqual(res.body[0].snippets[0].label, 'name');
});

test('search: filters combine with free text (all must match)', async () => {
  const both = await search('widget b:main');
  assert.deepStrictEqual(both.body.map(s => s.sessionId), [SESSION_CHAT]);
  const none = await search('widget t:bash b:main');
  assert.deepStrictEqual(none.body, []);
});

test('search: sub-agent edits and tools count for f: and t:', async () => {
  const byFile = await search('f:notes.md');
  assert.deepStrictEqual(byFile.body.map(s => s.sessionId), [SESSION_SUB]);
  const byTool = await search('t:write');
  assert.deepStrictEqual(byTool.body.map(s => s.sessionId), [SESSION_SUB]);
});

test('search: a bare "f:" is plain text, not an empty filter', async () => {
  const res = await search('f:');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.filter(s => [SESSION_EDIT, SESSION_CHAT, SESSION_SUB].includes(s.sessionId)), []);
});

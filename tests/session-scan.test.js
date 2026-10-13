const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('./helpers/app');
const { scanSession, firstMeaningfulPrompt } = require('../lib/session-scan');

const TMP = path.join(os.tmpdir(), `cm-session-scan-${process.pid}`);
before(() => fs.mkdirSync(TMP, { recursive: true }));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writeJsonl(name, entries) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const isSkippable = t => t.includes('Caveat: The messages below were generated') || t.trim() === '/clear';
const normalize = t => t;

test('scanSession collects titles, branches, counts and bridge flag in one pass', () => {
  const file = writeJsonl('meta.jsonl', [
    { type: 'user', message: { content: 'Caveat: The messages below were generated' }, timestamp: '2026-01-01T00:00:00Z', gitBranch: 'main' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'user', message: { content: 'real prompt' }, timestamp: '2026-01-01T00:01:00Z', gitBranch: 'feature/x' },
    { type: 'summary', summary: 'Summary title' },
    { type: 'custom-title', customTitle: 'Custom' },
    { type: 'bridge-session' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] }, timestamp: '2026-01-01T00:02:00Z', gitBranch: 'main' }
  ]);
  const meta = scanSession(file);
  assert.strictEqual(meta.userCount, 3);
  assert.strictEqual(meta.customTitle, 'Custom');
  assert.strictEqual(meta.summaryTitle, 'Summary title');
  assert.strictEqual(meta.remoteControlled, true);
  assert.deepStrictEqual(meta.gitBranches, ['main', 'feature/x']);
  assert.strictEqual(meta.firstUserBranch, 'main');
  assert.strictEqual(meta.lastUserBranch, 'main');
  assert.strictEqual(meta.firstUserTimestamp, '2026-01-01T00:00:00Z');
  assert.strictEqual(meta.lastUserTimestamp, '2026-01-01T00:02:00Z');
  assert.strictEqual(firstMeaningfulPrompt(meta, isSkippable, normalize), 'real prompt');
});

test('scanSession returns cached metadata until the file changes', () => {
  const file = writeJsonl('cache.jsonl', [{ type: 'user', message: { content: 'one' } }]);
  assert.strictEqual(scanSession(file).userCount, 1);

  const readSpy = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (...args) { if (args[0] === file) reads++; return readSpy.apply(this, args); };
  try {
    assert.strictEqual(scanSession(file).userCount, 1);
    assert.strictEqual(reads, 0, 'unchanged file is not re-read');

    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'two' } }) + '\n');
    assert.strictEqual(scanSession(file).userCount, 2);
    assert.strictEqual(reads, 1, 'changed file is re-read once');
  } finally {
    fs.readFileSync = readSpy;
  }
});

test('scanSession returned branches are a copy, not the cached array', () => {
  const file = writeJsonl('copy.jsonl', [{ type: 'user', message: { content: 'a' }, gitBranch: 'main' }]);
  scanSession(file).gitBranches.push('mutated');
  assert.deepStrictEqual(scanSession(file).gitBranches, ['main']);
});

test('scanSession hasPlan follows the plan stems passed in', () => {
  const file = writeJsonl('plan.jsonl', [{ type: 'assistant', message: { content: 'see plans/brave-otter.md' } }]);
  assert.strictEqual(scanSession(file).hasPlan, undefined);
  assert.strictEqual(scanSession(file, ['other-plan']).hasPlan, false);
  assert.strictEqual(scanSession(file, ['other-plan', 'brave-otter']).hasPlan, true);
});

test('scanSession returns null for a missing file', () => {
  assert.strictEqual(scanSession(path.join(TMP, 'nope.jsonl')), null);
});

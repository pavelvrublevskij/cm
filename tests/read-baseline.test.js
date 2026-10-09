const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { readBaselines } = require('../lib/read-baseline');

const ROOT = path.resolve('/proj-root');
const read = (file, content, extra) => JSON.stringify({
  type: 'user',
  toolUseResult: { type: 'text', file: Object.assign({ filePath: path.join(ROOT, file), content, startLine: 1, numLines: 2, totalLines: 2 }, extra) }
});
const bash = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });

test('full Read before a shell write becomes the baseline', () => {
  const log = [read('a.txt', 'one\ntwo'), bash('sed -i "s/two/TWO/" a.txt')].join('\n');
  assert.strictEqual(readBaselines(log, ROOT).get('a.txt'), 'one\ntwo');
});

test('partial Read yields no baseline', () => {
  const log = [read('a.txt', 'two', { startLine: 2, numLines: 1, totalLines: 2 }), bash('sed -i "s/two/TWO/" a.txt')].join('\n');
  assert.strictEqual(readBaselines(log, ROOT).has('a.txt'), false);
});

test('Read after the first shell write is not used', () => {
  const log = [bash('sed -i "s/two/TWO/" a.txt'), read('a.txt', 'one\nTWO'), bash('sed -i "s/one/ONE/" a.txt')].join('\n');
  assert.strictEqual(readBaselines(log, ROOT).has('a.txt'), false);
});

test('Read without a shell write yields no baseline', () => {
  assert.strictEqual(readBaselines(read('a.txt', 'x'), ROOT).size, 0);
});

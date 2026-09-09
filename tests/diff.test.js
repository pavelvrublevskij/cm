const { test } = require('node:test');
const assert = require('node:assert');
const { computeDiff, MAX_LINES } = require('../lib/diff');

test('diff: identical text produces no hunks', () => {
  const result = computeDiff('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepStrictEqual(result.hunks, []);
  assert.deepStrictEqual(result.stats, { added: 0, removed: 0 });
  assert.strictEqual(result.tooLarge, undefined);
});

test('diff: a single changed line in the middle produces one hunk with correct line numbers', () => {
  const oldText = 'a\nb\nc\nd\ne\n';
  const newText = 'a\nb\nX\nd\ne\n';
  const result = computeDiff(oldText, newText);
  assert.strictEqual(result.hunks.length, 1);
  assert.strictEqual(result.stats.added, 1);
  assert.strictEqual(result.stats.removed, 1);
  const hunk = result.hunks[0];
  assert.strictEqual(hunk.oldStart, 1);
  assert.strictEqual(hunk.newStart, 1);
});

test('diff: a small change deep inside a huge file still reports the correct 1-indexed line numbers', () => {
  const commonHead = Array.from({ length: 20000 }, (_, i) => `line${i}`);
  const commonTail = Array.from({ length: 20000 }, (_, i) => `tail${i}`);
  const oldText = [...commonHead, 'CHANGED-OLD', ...commonTail].join('\n');
  const newText = [...commonHead, 'CHANGED-NEW', ...commonTail].join('\n');

  const result = computeDiff(oldText, newText);
  assert.strictEqual(result.tooLarge, undefined, 'prefix/suffix trimming keeps the DP core tiny regardless of file size');
  assert.strictEqual(result.hunks.length, 1);
  assert.strictEqual(result.stats.added, 1);
  assert.strictEqual(result.stats.removed, 1);
  // The changed line sits right after the 20000-line common head, so it's line 20001 (1-indexed).
  assert.strictEqual(result.hunks[0].lines.some(l => l.type === '-' && l.content === 'CHANGED-OLD'), true);
  const changedLineNum = result.hunks[0].oldStart +
    result.hunks[0].lines.findIndex(l => l.content === 'CHANGED-OLD');
  assert.strictEqual(changedLineNum, 20001);
});

test('diff: context lines around a trimmed boundary are preserved', () => {
  const commonHead = Array.from({ length: 100 }, (_, i) => `line${i}`);
  const oldText = [...commonHead, 'X'].join('\n');
  const newText = [...commonHead, 'Y'].join('\n');
  const result = computeDiff(oldText, newText);
  assert.strictEqual(result.hunks.length, 1);
  const contextLines = result.hunks[0].lines.filter(l => l.type === '=');
  assert.ok(contextLines.length > 0, 'unchanged lines just before the change are included as context');
});

test('diff: a differing core still over MAX_LINES is reported as too large', () => {
  const oldLines = Array.from({ length: MAX_LINES + 500 }, (_, i) => `old${i}`);
  const newLines = Array.from({ length: MAX_LINES + 500 }, (_, i) => `new${i}`);
  const result = computeDiff(oldLines.join('\n'), newLines.join('\n'));
  assert.strictEqual(result.tooLarge, true);
  assert.deepStrictEqual(result.hunks, []);
});

test('diff: pure insertion at the end of a file is not blown up by trimming', () => {
  const oldText = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
  const newText = oldText + '\nnew-last-line';
  const result = computeDiff(oldText, newText);
  assert.strictEqual(result.stats.added, 1);
  assert.strictEqual(result.stats.removed, 0);
});

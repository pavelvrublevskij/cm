const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Must come before lib requires so HOME env is set
const { paths } = require('./helpers/app');

const { safeSlug, safeMemoryFile, readJson, safeDataWrite } = require('../lib/file-helpers');
const { getCustomTitle } = require('../lib/session-title');
const { collectBranches } = require('../lib/session-branches');
const { readFrontmatterFile, readFrontmatterDir, writeFrontmatter } = require('../lib/frontmatter');
const { getISOWeek, dayInRange, hourKeyInRange, getFilteredByModel } = require('../lib/usage-filters');

const TMP = path.join(os.tmpdir(), `cm-lib-utils-${process.pid}`);
before(() => fs.mkdirSync(TMP, { recursive: true }));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── safeSlug ─────────────────────────────────────────────────────────────────

test('safeSlug: valid slug returns path under PROJECTS_DIR', () => {
  const result = safeSlug('valid-slug');
  assert.ok(result);
  assert.ok(result.startsWith(paths.PROJECTS_DIR));
  assert.ok(result.endsWith('valid-slug'));
});

test('safeSlug: rejects .. traversal', () => {
  assert.strictEqual(safeSlug('..bad'), null);
  assert.strictEqual(safeSlug('../escape'), null);
  assert.strictEqual(safeSlug('a/../b'), null);
});

test('safeSlug: rejects path separators', () => {
  assert.strictEqual(safeSlug('a/b'), null);
  assert.strictEqual(safeSlug('a\\b'), null);
});

// ── safeMemoryFile ────────────────────────────────────────────────────────────

test('safeMemoryFile: accepts valid .md filename', () => {
  assert.strictEqual(safeMemoryFile('test.md'), 'test.md');
  assert.strictEqual(safeMemoryFile('my-file.md'), 'my-file.md');
});

test('safeMemoryFile: rejects path traversal', () => {
  assert.strictEqual(safeMemoryFile('../escape.md'), null);
  assert.strictEqual(safeMemoryFile('a/b.md'), null);
  assert.strictEqual(safeMemoryFile('a\\b.md'), null);
});

test('safeMemoryFile: rejects non-.md extensions', () => {
  assert.strictEqual(safeMemoryFile('test.js'), null);
  assert.strictEqual(safeMemoryFile('test'), null);
  assert.strictEqual(safeMemoryFile('test.MD'), null);
});

// ── readJson ──────────────────────────────────────────────────────────────────

test('readJson: parses valid JSON file', () => {
  const f = path.join(TMP, 'valid.json');
  fs.writeFileSync(f, JSON.stringify({ x: 1 }));
  assert.deepStrictEqual(readJson(f), { x: 1 });
});

test('readJson: returns default fallback for missing file', () => {
  assert.deepStrictEqual(readJson(path.join(TMP, 'missing.json')), {});
});

test('readJson: returns custom fallback for missing file', () => {
  assert.deepStrictEqual(readJson(path.join(TMP, 'missing.json'), []), []);
});

test('readJson: returns fallback for malformed JSON', () => {
  const f = path.join(TMP, 'bad.json');
  fs.writeFileSync(f, 'not json{{{');
  assert.strictEqual(readJson(f, null), null);
});

// ── safeDataWrite ─────────────────────────────────────────────────────────────

test('safeDataWrite: allows writes inside DATA_DIR', () => {
  const target = path.join(paths.DATA_DIR, 'safe-test.json');
  const resolved = safeDataWrite(target);
  assert.strictEqual(resolved, path.resolve(target));
});

test('safeDataWrite: rejects writes outside DATA_DIR', () => {
  assert.throws(() => safeDataWrite(path.join(TMP, 'outside.json')));
});

test('safeDataWrite: rejects writes into CLAUDE_DIR', () => {
  assert.throws(() => safeDataWrite(path.join(paths.CLAUDE_DIR, 'danger.json')));
});

// ── getCustomTitle ────────────────────────────────────────────────────────────

test('getCustomTitle: returns empty string when no custom-title entry', () => {
  const f = path.join(TMP, 'no-title.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'hi' } }),
  ].join('\n'));
  assert.strictEqual(getCustomTitle(f), '');
});

test('getCustomTitle: returns title from custom-title entry', () => {
  const f = path.join(TMP, 'has-title.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My Session' }),
  ].join('\n'));
  assert.strictEqual(getCustomTitle(f), 'My Session');
});

test('getCustomTitle: returns last title when multiple entries exist', () => {
  const f = path.join(TMP, 'multi-title.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'custom-title', customTitle: 'First' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Last' }),
  ].join('\n'));
  assert.strictEqual(getCustomTitle(f), 'Last');
});

test('getCustomTitle: returns empty string for missing file', () => {
  assert.strictEqual(getCustomTitle(path.join(TMP, 'nonexistent.jsonl')), '');
});

test('getCustomTitle: skips malformed JSON lines', () => {
  const f = path.join(TMP, 'malformed.jsonl');
  fs.writeFileSync(f, 'not-json\n' + JSON.stringify({ type: 'custom-title', customTitle: 'Valid' }));
  assert.strictEqual(getCustomTitle(f), 'Valid');
});

// ── collectBranches ───────────────────────────────────────────────────────────

test('collectBranches: returns empty array for empty file', () => {
  const f = path.join(TMP, 'empty.jsonl');
  fs.writeFileSync(f, '');
  assert.deepStrictEqual(collectBranches(f), []);
});

test('collectBranches: returns branches in insertion order, deduplicated', () => {
  const f = path.join(TMP, 'branches.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', gitBranch: 'main' }),
    JSON.stringify({ type: 'user', gitBranch: 'feature/x' }),
    JSON.stringify({ type: 'user', gitBranch: 'main' }),
    JSON.stringify({ type: 'user', gitBranch: 'bugfix/y' }),
  ].join('\n'));
  assert.deepStrictEqual(collectBranches(f), ['main', 'feature/x', 'bugfix/y']);
});

test('collectBranches: ignores non-user entries', () => {
  const f = path.join(TMP, 'mixed.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'assistant', gitBranch: 'ignored' }),
    JSON.stringify({ type: 'user', gitBranch: 'main' }),
  ].join('\n'));
  assert.deepStrictEqual(collectBranches(f), ['main']);
});

test('collectBranches: returns empty array for missing file', () => {
  assert.deepStrictEqual(collectBranches(path.join(TMP, 'nonexistent.jsonl')), []);
});

test('collectBranches: skips entries with no gitBranch', () => {
  const f = path.join(TMP, 'no-branch.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user' }),
    JSON.stringify({ type: 'user', gitBranch: 'develop' }),
  ].join('\n'));
  assert.deepStrictEqual(collectBranches(f), ['develop']);
});

// ── frontmatter ───────────────────────────────────────────────────────────────

test('readFrontmatterFile: parses frontmatter data and content', () => {
  const f = path.join(TMP, 'fm.md');
  fs.writeFileSync(f, '---\nname: test\ntype: user\n---\nBody text here');
  const { frontmatter, content } = readFrontmatterFile(f);
  assert.strictEqual(frontmatter.name, 'test');
  assert.strictEqual(frontmatter.type, 'user');
  assert.strictEqual(content, 'Body text here');
});

test('readFrontmatterDir: returns empty array for missing directory', () => {
  assert.deepStrictEqual(readFrontmatterDir(path.join(TMP, 'nonexistent-dir')), []);
});

test('readFrontmatterDir: lists .md files with parsed frontmatter', () => {
  const dir = path.join(TMP, 'fmdir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '---\ntitle: A\n---\nContent A');
  fs.writeFileSync(path.join(dir, 'b.md'), '---\ntitle: B\n---\nContent B');
  fs.writeFileSync(path.join(dir, 'skip.txt'), 'not included');
  const result = readFrontmatterDir(dir);
  assert.strictEqual(result.length, 2);
  const a = result.find(r => r.filename === 'a.md');
  assert.ok(a, 'a.md must be included');
  assert.strictEqual(a.title, 'A');
  assert.ok(!result.find(r => r.filename === 'skip.txt'), '.txt must be excluded');
});

test('writeFrontmatter: round-trips through readFrontmatterFile', () => {
  const f = path.join(TMP, 'write-fm.md');
  writeFrontmatter(f, { name: 'slug', type: 'feedback' }, 'Body content');
  const { frontmatter, content } = readFrontmatterFile(f);
  assert.strictEqual(frontmatter.name, 'slug');
  assert.strictEqual(frontmatter.type, 'feedback');
  assert.strictEqual(content, 'Body content');
});

// ── getISOWeek ────────────────────────────────────────────────────────────────

test('getISOWeek: 2026-01-01 (Thursday) is week 01 of 2026', () => {
  assert.strictEqual(getISOWeek('2026-01-01'), '2026-W01');
});

test('getISOWeek: 2026-01-05 (Monday) is week 02 of 2026', () => {
  assert.strictEqual(getISOWeek('2026-01-05'), '2026-W02');
});

test('getISOWeek: 2025-12-29 (Monday) belongs to 2026-W01', () => {
  assert.strictEqual(getISOWeek('2025-12-29'), '2026-W01');
});

// ── dayInRange ────────────────────────────────────────────────────────────────

test('dayInRange: no bounds accepts all dates', () => {
  assert.ok(dayInRange('2026-05-01', null, null));
  assert.ok(dayInRange('2026-05-01', undefined, undefined));
});

test('dayInRange: day before `from` is excluded', () => {
  assert.ok(!dayInRange('2026-04-30', '2026-05-01', null));
});

test('dayInRange: day after `to` is excluded', () => {
  assert.ok(!dayInRange('2026-05-02', null, '2026-05-01'));
});

test('dayInRange: exact boundary dates are included', () => {
  assert.ok(dayInRange('2026-05-01', '2026-05-01', '2026-05-01'));
});

test('dayInRange: day within range is included', () => {
  assert.ok(dayInRange('2026-05-15', '2026-05-01', '2026-06-01'));
});

// ── hourKeyInRange ────────────────────────────────────────────────────────────
//
// hourKeyInRange takes a UTC "YYYY-MM-DD HH" key and compares it against from/to
// bounds using the *local* wall-clock day/hour (see lib/usage-filters.js), so
// fromTime/toTime are meant to be read in the machine's local timezone. A key
// like '2026-05-01 08' is only "8am local" on a machine running in UTC+0 — on
// any other offset the local hour is different, so hardcoding UTC strings and
// assuming they equal local hours made these tests fail outside UTC (e.g. under
// Europe/Vilnius, UTC+3). buildHourKey() below constructs the UTC key that
// corresponds to a given *local* date/hour on whichever machine runs the test.

function buildHourKey(year, month, day, localHour) {
  const d = new Date(year, month - 1, day, localHour, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}`;
}

test('hourKeyInRange: no filters accepts all', () => {
  assert.ok(hourKeyInRange(buildHourKey(2026, 5, 1, 10), null, null, null, null));
});

test('hourKeyInRange: excludes hour before fromTime', () => {
  assert.ok(!hourKeyInRange(buildHourKey(2026, 5, 1, 8), null, null, '09:00', null));
});

test('hourKeyInRange: includes hour equal to fromTime', () => {
  assert.ok(hourKeyInRange(buildHourKey(2026, 5, 1, 9), null, null, '09:00', null));
});

test('hourKeyInRange: excludes hour after toTime', () => {
  assert.ok(!hourKeyInRange(buildHourKey(2026, 5, 1, 18), null, null, null, '17:00'));
});

test('hourKeyInRange: includes hour equal to toTime', () => {
  assert.ok(hourKeyInRange(buildHourKey(2026, 5, 1, 17), null, null, null, '17:00'));
});

test('hourKeyInRange: excludes day outside date range', () => {
  assert.ok(!hourKeyInRange(buildHourKey(2026, 4, 30, 12), '2026-05-01', null, null, null));
});

// ── getFilteredByModel ────────────────────────────────────────────────────────

test('getFilteredByModel: no filters returns full byModel', () => {
  const session = {
    byModel: {
      'claude-sonnet-4-6': { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  };
  const result = getFilteredByModel(session, new Set(), null, null, null, null);
  assert.deepStrictEqual(result, session.byModel);
});

test('getFilteredByModel: model filter returns only matching models', () => {
  const session = {
    byModel: {
      'claude-sonnet-4-6': { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      'claude-haiku-4-5': { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }
  };
  const result = getFilteredByModel(session, new Set(['claude-haiku-4-5']), null, null, null, null);
  assert.ok(!result['claude-sonnet-4-6'], 'filtered-out model must not appear');
  assert.ok(result['claude-haiku-4-5'], 'requested model must appear');
});

test('getFilteredByModel: date filter uses daily data', () => {
  const session = {
    byModel: {},
    daily: {
      '2026-05-01': {
        'claude-sonnet-4-6': { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      },
      '2026-05-10': {
        'claude-sonnet-4-6': { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    }
  };
  const result = getFilteredByModel(session, new Set(), '2026-05-01', '2026-05-05', null, null);
  assert.ok(result['claude-sonnet-4-6'], 'in-range day must be included');
  assert.strictEqual(result['claude-sonnet-4-6'].input_tokens, 100, 'only in-range day tokens counted');
});
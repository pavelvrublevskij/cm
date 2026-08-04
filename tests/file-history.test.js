const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, paths, HOME } = require('./helpers/app');
const { decodeSlug } = require('../lib/slug');

const SESSION_ID = 'fhtest111-1111-1111-1111-111111111111';
const PROJ_SLUG = 'fh-test-project';
const HASH = 'deadbeef1234abcd';
const TRACKED_FILE = '/projects/myapp/src/index.js';

const FILE_HISTORY_DIR = path.join(paths.CLAUDE_DIR, 'file-history');
const PLANS_DIR = path.join(paths.CLAUDE_DIR, 'plans');
const SESSION_HIST_DIR = path.join(FILE_HISTORY_DIR, SESSION_ID);

// Session that tracks a file which physically exists on disk (for mtime tests)
const MTIME_SESSION_ID = 'mtimetest-2222-2222-2222-222222222222';
const MTIME_HASH = 'mtimehash00012ab';
const REAL_FILE = path.join(HOME, 'mtime-tracked-file.txt');

function slugForPath(p) {
  const win = p.match(/^([A-Za-z]):[\\\/](.*)/);
  if (win) return `${win[1].toUpperCase()}--${win[2].replace(/[\\\/\.]/g, '-')}`;
  return p.replace(/^\//, '').replace(/[\/\.]/g, '-');
}

before(() => {
  // Project dir + session JSONL
  const projDir = path.join(paths.PROJECTS_DIR, PROJ_SLUG);
  fs.mkdirSync(projDir, { recursive: true });

  const entries = [
    { type: 'user', timestamp: '2026-01-01T10:00:00.000Z', message: { content: 'start' } },
    {
      type: 'file-history-snapshot',
      isSnapshotUpdate: true,
      snapshot: {
        trackedFileBackups: {
          [TRACKED_FILE]: { backupFileName: `${HASH}@v1`, version: 1 },
          '/projects/myapp/src/new-file.js': { backupFileName: null, version: 0 },
        }
      }
    },
    { type: 'user', timestamp: '2026-01-01T11:00:00.000Z', message: { content: 'end' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: '# In-range Plan\n\nContent.', planFilePath: `${paths.CLAUDE_DIR}/plans/fh-in-range-plan.md` } }
        ]
      }
    }
  ];
  fs.writeFileSync(
    path.join(projDir, SESSION_ID + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n')
  );

  // File history: v1 and v2 on disk
  fs.mkdirSync(SESSION_HIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSION_HIST_DIR, `${HASH}@v1`), 'line one\nline two\n');
  fs.writeFileSync(path.join(SESSION_HIST_DIR, `${HASH}@v2`), 'line one\nline two modified\nadded line\n');

  // Plan within session window (10:00-11:00 ±30min → 09:30-11:30)
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PLANS_DIR, 'fh-in-range-plan.md'), '# In-range Plan\n\nContent.');
  const inRangeTime = new Date('2026-01-01T10:30:00.000Z');
  fs.utimesSync(path.join(PLANS_DIR, 'fh-in-range-plan.md'), inRangeTime, inRangeTime);

  // Plan outside session window
  fs.writeFileSync(path.join(PLANS_DIR, 'fh-old-plan.md'), '# Old Plan');
  const oldTime = new Date('2025-01-01T00:00:00.000Z');
  fs.utimesSync(path.join(PLANS_DIR, 'fh-old-plan.md'), oldTime, oldTime);
});

// ── /context endpoint ─────────────────────────────────────────────────────────

test('context: returns 200 with files and plans arrays', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.files));
  assert.ok(Array.isArray(res.body.plans));
});

test('context: files with null backupFileName appear flagged as isNew', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const newFile = res.body.files.find(f => f.path === '/projects/myapp/src/new-file.js');
  assert.ok(newFile, 'newly created file must appear in changes list');
  assert.strictEqual(newFile.isNew, true, 'must be flagged isNew');
  assert.strictEqual(newFile.hash, null, 'no hash for files with no backup');
  assert.deepStrictEqual(newFile.versions, [], 'no versions for files with no backup');
});

test('context: edited files have isNew=false', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  const file = res.body.files.find(f => f.path === TRACKED_FILE);
  assert.ok(file);
  assert.strictEqual(file.isNew, false);
});

test('context: files removed from disk are flagged isDeleted', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  const file = res.body.files.find(f => f.path === TRACKED_FILE);
  assert.ok(file);
  assert.strictEqual(file.isDeleted, true,
    'TRACKED_FILE path does not exist under the project dir, so it must be marked deleted');
});

test('context: versions array reflects files present on disk', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  const file = res.body.files.find(f => f.path === TRACKED_FILE);
  assert.ok(file, 'tracked file must be present');
  assert.deepStrictEqual(file.versions, [1, 2]);
});

test('context: projSlug is returned', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  assert.strictEqual(res.body.projSlug, PROJ_SLUG);
});

test('context: plans linked via ExitPlanMode planFilePath appear', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const names = res.body.plans.map(p => p.name);
  assert.ok(names.includes('fh-in-range-plan'), 'plan referenced in ExitPlanMode must appear');
  assert.ok(!names.includes('fh-old-plan'), 'plan not referenced must not appear');
});

test('context: plans not linked via ExitPlanMode are excluded even if mtime overlaps', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const names = res.body.plans.map(p => p.name);
  assert.ok(!names.includes('fh-old-plan'), 'unreferenced plan must not appear regardless of mtime');
});

test('context: invalid sessionId returns 400', async () => {
  const res = await request(app).get('/api/file-history/..bad..id/context');
  assert.strictEqual(res.status, 400);
});

test('context: unknown session returns empty files and plans', async () => {
  const res = await request(app).get('/api/file-history/99999999-0000-0000-0000-000000000000/context');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.files, []);
  assert.deepStrictEqual(res.body.plans, []);
});

// ── /diff endpoint ────────────────────────────────────────────────────────────

test('diff: returns hunks and stats for changed versions', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff`)
    .query({ from: 1, to: 2 });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.hunks));
  assert.ok(typeof res.body.stats === 'object');
  assert.ok(typeof res.body.stats.added === 'number');
  assert.ok(typeof res.body.stats.removed === 'number');
  assert.ok(res.body.stats.added > 0 || res.body.stats.removed > 0, 'diff must detect changes');
});

test('diff: identical versions produce empty hunks', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff`)
    .query({ from: 1, to: 1 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.hunks, []);
  assert.strictEqual(res.body.stats.added, 0);
  assert.strictEqual(res.body.stats.removed, 0);
});

test('diff: missing version file returns 404', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff`)
    .query({ from: 99, to: 100 });
  assert.strictEqual(res.status, 404);
});

test('diff: path traversal in sessionId returns 400', async () => {
  const res = await request(app)
    .get(`/api/file-history/..bad..id/${HASH}/diff`)
    .query({ from: 1, to: 2 });
  assert.strictEqual(res.status, 400);
});

test('diff: path traversal in hash returns 400', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/..badhash/diff`)
    .query({ from: 1, to: 2 });
  assert.strictEqual(res.status, 400);
});

// ── /diff-current with isNew ─────────────────────────────────────────────────

test('diff-current: isNew=true skips snapshot read and returns 200 even with bogus hash', async () => {
  // When isNew is true, we don't read a snapshot — so a non-existent hash is fine
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/none/diff-current`)
    .query({ isNew: 'true', projSlug: PROJ_SLUG, filePath: 'nonexistent.js' });
  assert.strictEqual(res.status, 200);
  // current file doesn't exist either, so both sides empty → no hunks
  assert.deepStrictEqual(res.body.hunks, []);
  assert.strictEqual(res.body.stats.added, 0);
  assert.strictEqual(res.body.stats.removed, 0);
});

test('diff-current: without isNew, missing version still returns 404', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff-current`)
    .query({ version: 99, projSlug: PROJ_SLUG, filePath: 'created.js' });
  assert.strictEqual(res.status, 404);
});

// ── mtime field ───────────────────────────────────────────────────────────────

before(() => {
  fs.writeFileSync(REAL_FILE, 'real tracked content');

  const projDir = path.join(paths.PROJECTS_DIR, PROJ_SLUG);
  const entries = [
    { type: 'user', timestamp: '2026-02-01T10:00:00.000Z', message: { content: 'mtime test' } },
    {
      type: 'file-history-snapshot',
      isSnapshotUpdate: true,
      snapshot: {
        trackedFileBackups: {
          [REAL_FILE]: { backupFileName: `${MTIME_HASH}@v1`, version: 1 }
        }
      }
    }
  ];
  fs.writeFileSync(
    path.join(projDir, MTIME_SESSION_ID + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n')
  );

  const histDir = path.join(FILE_HISTORY_DIR, MTIME_SESSION_ID);
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, `${MTIME_HASH}@v1`), 'backup of real file');
});

test('context: mtime is a number for files that exist on disk', async () => {
  const res = await request(app).get(`/api/file-history/${MTIME_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const file = res.body.files.find(f => f.path === REAL_FILE);
  assert.ok(file, 'tracked real file must appear');
  assert.strictEqual(typeof file.mtime, 'number');
  assert.ok(file.mtime > 0);
  assert.strictEqual(file.isDeleted, false);
});

test('context: mtime is null and isDeleted=true for files missing from disk', async () => {
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  const file = res.body.files.find(f => f.path === TRACKED_FILE);
  assert.ok(file);
  assert.strictEqual(file.mtime, null);
  assert.strictEqual(file.isDeleted, true);
});

// ── Plan detection via Write tool to PLANS_DIR ───────────────────────────────

const WRITE_PLAN_SESSION_ID = 'writeplan-4444-4444-4444-444444444444';
const WRITE_PLAN_PATH = path.join(PLANS_DIR, 'write-detected-plan.md');

before(() => {
  const projDir = path.join(paths.PROJECTS_DIR, PROJ_SLUG);
  const entries = [
    { type: 'user', timestamp: '2026-06-01T10:00:00.000Z', message: { content: 'plan request' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_plan_write', name: 'Write', input: { file_path: WRITE_PLAN_PATH, content: '# Plan\n\nContent.' } }
        ]
      }
    }
  ];
  fs.writeFileSync(
    path.join(projDir, WRITE_PLAN_SESSION_ID + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n')
  );
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(WRITE_PLAN_PATH, '# Plan\n\nContent.');
});

test('context: plan written to PLANS_DIR via Write tool appears in plans array', async () => {
  const res = await request(app).get(`/api/file-history/${WRITE_PLAN_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const names = res.body.plans.map(p => p.name);
  assert.ok(names.includes('write-detected-plan'), 'plan created via Write tool must appear even without ExitPlanMode call');
});

test('context: plan written to PLANS_DIR via Write tool does not appear in files array', async () => {
  const res = await request(app).get(`/api/file-history/${WRITE_PLAN_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const found = res.body.files.some(f => f.path.includes('write-detected-plan'));
  assert.ok(!found, 'plan file must not appear in the files section');
});

// ── Write tool scan ───────────────────────────────────────────────────────────

const WRITE_SESSION_ID = 'writetest1-3333-3333-3333-333333333333';
const WRITE_PROJ_DIR = path.resolve(decodeSlug(PROJ_SLUG));
const WRITE_FILE_PATH = path.join(WRITE_PROJ_DIR, 'write-created.md');

before(() => {
  const projDir = path.join(paths.PROJECTS_DIR, PROJ_SLUG);

  const entries = [
    { type: 'user', timestamp: '2026-03-01T10:00:00.000Z', message: { content: 'write test' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: WRITE_FILE_PATH, content: '# New File\n' } }
        ]
      }
    }
  ];
  fs.writeFileSync(
    path.join(projDir, WRITE_SESSION_ID + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n')
  );

  fs.mkdirSync(path.join(FILE_HISTORY_DIR, WRITE_SESSION_ID), { recursive: true });
});

test('context: file created via Write tool appears with isNew=true', async () => {
  const res = await request(app).get(`/api/file-history/${WRITE_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const f = res.body.files.find(f => f.path === 'write-created.md');
  assert.ok(f, 'file created via Write tool must appear in file changes');
  assert.strictEqual(f.isNew, true);
  assert.strictEqual(f.hash, null);
  assert.deepStrictEqual(f.versions, []);
});

test('context: Write tool files not in trackedFileBackups are not duplicated', async () => {
  const res = await request(app).get(`/api/file-history/${WRITE_SESSION_ID}/context`);
  const matches = res.body.files.filter(f => f.path === 'write-created.md');
  assert.strictEqual(matches.length, 1, 'must appear exactly once');
});

test('context: Write file already in snapshot is not overridden with isNew', async () => {
  // The snapshot entry for '/projects/myapp/src/new-file.js' has backupFileName=null
  // meaning it was tracked by snapshot (isNew=true from snapshot); a Write tool use
  // for the same path should not create a duplicate or change the entry.
  const res = await request(app).get(`/api/file-history/${SESSION_ID}/context`);
  const matches = res.body.files.filter(f => f.path === '/projects/myapp/src/new-file.js');
  assert.strictEqual(matches.length, 1, 'snapshot-tracked new file must appear exactly once');
});

// ── Write/Edit tool fallback with NO file-history directory ──────────────────

const NO_HISTDIR_SESSION_ID = 'nohistdir-5555-5555-5555-555555555555';
const NO_HISTDIR_PROJ_DIR = path.resolve(decodeSlug(PROJ_SLUG));
const NO_HISTDIR_WRITE_PATH = path.join(NO_HISTDIR_PROJ_DIR, 'specs', 'plan.md');
const NO_HISTDIR_EDIT_PATH = path.join(NO_HISTDIR_PROJ_DIR, 'specs', 'existing.md');

before(() => {
  const projDir = path.join(paths.PROJECTS_DIR, PROJ_SLUG);
  const entries = [
    { type: 'user', timestamp: '2026-04-01T10:00:00.000Z', message: { content: 'start' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: NO_HISTDIR_WRITE_PATH, content: '# Plan\n' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: NO_HISTDIR_EDIT_PATH, old_string: 'a', new_string: 'b' } }
        ]
      }
    }
  ];
  fs.writeFileSync(
    path.join(projDir, NO_HISTDIR_SESSION_ID + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n')
  );
  // Intentionally do NOT create FILE_HISTORY_DIR/NO_HISTDIR_SESSION_ID
});

test('context: Write-tool files appear with isNew=true when no file-history dir exists', async () => {
  const res = await request(app).get(`/api/file-history/${NO_HISTDIR_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  const f = res.body.files.find(f => f.path === 'specs/plan.md');
  assert.ok(f, 'Write-detected file must appear even when file-history directory does not exist');
  assert.strictEqual(f.isNew, true);
  assert.strictEqual(f.hash, null);
  assert.deepStrictEqual(f.versions, []);
});

test('context: session without file-history dir returns projSlug correctly', async () => {
  const res = await request(app).get(`/api/file-history/${NO_HISTDIR_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.projSlug, PROJ_SLUG);
});

test('context: Edit-tool files without snapshot are excluded (no diff available)', async () => {
  const res = await request(app).get(`/api/file-history/${NO_HISTDIR_SESSION_ID}/context`);
  assert.strictEqual(res.status, 200);
  // Edit-only files have isNew=false, hash=null, versions=[] → filtered out since no diff can be shown
  const editFile = res.body.files.find(f => f.path === 'specs/existing.md');
  assert.ok(!editFile, 'Edit-only file without snapshot should not appear (no diff data available)');
});

test('context: session with no file-history dir and no tool writes returns empty files', async () => {
  const emptySessionId = 'notools55-6666-6666-6666-666666666666';
  const projDir = path.join(paths.PROJECTS_DIR, PROJ_SLUG);
  const entries = [
    { type: 'user', timestamp: '2026-05-01T10:00:00.000Z', message: { content: 'just chatting' } },
    { type: 'assistant', message: { content: 'sure' } }
  ];
  fs.writeFileSync(
    path.join(projDir, emptySessionId + '.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n')
  );
  const res = await request(app).get(`/api/file-history/${emptySessionId}/context`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.files, []);
});

// ── /diff-current additional cases ───────────────────────────────────────────

test('diff-current: stored version vs on-disk current file returns 200 with non-empty hunks and stats', async () => {
  const homeSlug = slugForPath(HOME);
  const res = await request(app)
    .get(`/api/file-history/${MTIME_SESSION_ID}/${MTIME_HASH}/diff-current`)
    .query({ version: 1, projSlug: homeSlug, filePath: 'mtime-tracked-file.txt' });
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.hunks));
  assert.ok(res.body.hunks.length > 0, 'stored and current content differ so hunks must be non-empty');
  assert.strictEqual(typeof res.body.stats.added, 'number');
  assert.strictEqual(typeof res.body.stats.removed, 'number');
});

test('diff-current: deleted file (current absent) returns 200 with currentText empty string', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff-current`)
    .query({ version: 1, projSlug: PROJ_SLUG, filePath: 'deleted-file.txt' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.currentText, '');
});

test('diff-current: missing projSlug returns 400', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff-current`)
    .query({ version: 1, filePath: 'something.js' });
  assert.strictEqual(res.status, 400);
});

test('diff-current: path traversal in filePath returns 400', async () => {
  const res = await request(app)
    .get(`/api/file-history/${SESSION_ID}/${HASH}/diff-current`)
    .query({ version: 1, projSlug: PROJ_SLUG, filePath: '../../../etc/passwd' });
  assert.strictEqual(res.status, 400);
});

// ── /open-file endpoint ───────────────────────────────────────────────────────

test('open-file: missing projSlug returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/open-file')
    .send({ filePath: 'index.js' });
  assert.strictEqual(res.status, 400);
});

test('open-file: invalid projSlug returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/open-file')
    .send({ projSlug: '../bad', filePath: 'index.js' });
  assert.strictEqual(res.status, 400);
});

test('open-file: missing filePath returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/open-file')
    .send({ projSlug: PROJ_SLUG });
  assert.strictEqual(res.status, 400);
});

test('open-file: path traversal in filePath returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/open-file')
    .send({ projSlug: PROJ_SLUG, filePath: '../../../etc/passwd' });
  assert.strictEqual(res.status, 400);
});

test('open-file: missing file on disk returns 404', async () => {
  const res = await request(app)
    .post('/api/file-history/open-file')
    .send({ projSlug: PROJ_SLUG, filePath: 'nonexistent.js' });
  assert.strictEqual(res.status, 404);
});

test('open-file SKIPPED: spawns OS default app (side-effect)', { skip: true }, () => {});

// ── /reveal-file endpoint ─────────────────────────────────────────────────────

test('reveal-file: missing projSlug returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/reveal-file')
    .send({ filePath: 'index.js' });
  assert.strictEqual(res.status, 400);
});

test('reveal-file: invalid projSlug returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/reveal-file')
    .send({ projSlug: '../bad', filePath: 'index.js' });
  assert.strictEqual(res.status, 400);
});

test('reveal-file: missing filePath returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/reveal-file')
    .send({ projSlug: PROJ_SLUG });
  assert.strictEqual(res.status, 400);
});

test('reveal-file: path traversal in filePath returns 400', async () => {
  const res = await request(app)
    .post('/api/file-history/reveal-file')
    .send({ projSlug: PROJ_SLUG, filePath: '../../../etc/passwd' });
  assert.strictEqual(res.status, 400);
});

test('reveal-file: missing file on disk returns 404', async () => {
  const res = await request(app)
    .post('/api/file-history/reveal-file')
    .send({ projSlug: PROJ_SLUG, filePath: 'nonexistent.js' });
  assert.strictEqual(res.status, 404);
});

test('reveal-file SKIPPED: spawns OS file explorer (side-effect)', { skip: true }, () => {});

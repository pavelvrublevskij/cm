const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { paths } = require('./helpers/app');
const { listProjectDirs, isAppDataSlug, slugForPath } = require('../lib/project-list');

test('slugForPath replaces every non-alphanumeric character with a dash', () => {
  assert.strictEqual(slugForPath('C:\\Users\\a.b\\cm\\data'), 'C--Users-a-b-cm-data');
  assert.strictEqual(slugForPath('/home/user/cm/data'), '-home-user-cm-data');
});

test('isAppDataSlug matches only the app data dir', () => {
  assert.strictEqual(isAppDataSlug(slugForPath(paths.DATA_DIR)), true);
  assert.strictEqual(isAppDataSlug(slugForPath(path.join(paths.DATA_DIR, 'other'))), false);
});

test('listProjectDirs hides the app data dir project but leaves it on disk', () => {
  const dataSlug = slugForPath(paths.DATA_DIR);
  const dataProject = path.join(paths.PROJECTS_DIR, dataSlug);
  const userProject = path.join(paths.PROJECTS_DIR, 'project-list-visible');
  fs.mkdirSync(path.join(dataProject, 'memory'), { recursive: true });
  fs.mkdirSync(userProject, { recursive: true });

  const slugs = listProjectDirs().map(p => p.slug);
  assert.ok(!slugs.includes(dataSlug));
  assert.ok(slugs.includes('project-list-visible'));
  assert.ok(fs.existsSync(dataProject));
});

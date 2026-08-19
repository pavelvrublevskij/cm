const fs = require('fs');
const path = require('path');

// Every test process creates tests/tmp/home-<pid> and tests/tmp/data-<pid>, and some of those homes
// hold throwaway git repos with fixture commits. The helper only ever removed its own pid's
// directories, so a year of runs left thousands of stale ones — and an editor indexing the nested
// repos surfaces their fixture commits as if they belonged to this project.
//
// Wired to npm pretest and posttest: the tree is clean before a run, and clean again after a passing
// one. A failing run leaves its directories behind on purpose, so they can be inspected.

const TMP = path.resolve(__dirname, '..', 'tmp');

/**
 * Remove everything inside `dir`, keeping `dir`. Refuses any path outside tests/tmp.
 * On Windows an indexer or antivirus can hold a handle on a leftover directory: that entry is
 * skipped rather than aborting the sweep, because cleaning scratch must never fail a test run.
 * @returns {{removed: number, skipped: number}}
 */
function cleanDir(dir) {
  const target = path.resolve(dir);
  if (target !== TMP && !target.startsWith(TMP + path.sep)) {
    throw new Error(`refusing to clean outside tests/tmp: ${target}`);
  }
  if (!fs.existsSync(target)) return { removed: 0, skipped: 0 };

  let removed = 0;
  let skipped = 0;
  for (const entry of fs.readdirSync(target)) {
    try {
      fs.rmSync(path.join(target, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed++;
    } catch (_) {
      skipped++;
    }
  }
  return { removed, skipped };
}

if (require.main === module) {
  const { removed, skipped } = cleanDir(TMP);
  if (removed) console.log(`cleaned ${removed} stale entries from tests/tmp`);
  if (skipped) console.log(`${skipped} entries were locked and left in place`);
}

module.exports = { cleanDir, TMP };

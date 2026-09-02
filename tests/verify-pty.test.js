const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

// run.sh / run.bat shell out to this script to self-heal a broken node-pty install, and
// server.js's /api/terminal/repair endpoint uses it the same way. It must exit 0 when node-pty
// can actually spawn a process, and exit non-zero (never throw) otherwise.
const SCRIPT = path.join(__dirname, '../scripts/verify-pty.js');

test('verify-pty exits 0 on a machine with a working node-pty install', () => {
  try {
    execFileSync(process.execPath, [SCRIPT], { cwd: path.join(__dirname, '..'), encoding: 'utf-8' });
  } catch (e) {
    assert.fail(`verify-pty.js exited non-zero:\n${e.stderr}`);
  }
});

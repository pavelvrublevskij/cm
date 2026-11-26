const path = require('path');
const fs = require('fs');

const TESTS_DIR = path.resolve(__dirname, '..');
const FIXTURES = path.join(TESTS_DIR, 'fixtures');
const TMP = path.join(TESTS_DIR, 'tmp');
const HOME = path.join(TMP, `home-${process.pid}`);
const DATA = path.join(TMP, `data-${process.pid}`);

function copyRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

if (!process.env.__CLAUDE_MANAGER_TEST_HOME) {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  copyRecursive(path.join(FIXTURES, 'claude-home'), path.join(HOME, '.claude'));
  const claudeJson = path.join(FIXTURES, 'claude.json');
  if (fs.existsSync(claudeJson)) fs.copyFileSync(claudeJson, path.join(HOME, '.claude.json'));
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  process.env.CLAUDE_MANAGER_DATA_DIR = DATA;
  process.env.__CLAUDE_MANAGER_TEST_HOME = HOME;
  process.on('exit', () => {
    for (const dir of [HOME, DATA]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) {}
    }
  });
}

const app = require('../../server');
const paths = require('../../lib/paths');

module.exports = { app, HOME: process.env.__CLAUDE_MANAGER_TEST_HOME, paths, copyRecursive, FIXTURES };

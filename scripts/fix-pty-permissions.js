// Postinstall: npm's extraction of node-pty's spawn-helper binary can lose its execute bit or
// pick up a Gatekeeper quarantine flag, causing a hardcoded "posix_spawnp failed." with no other
// diagnostic (see lib/terminal-server.js's diagnoseSpawnFailure). Fix it right after install so
// the first terminal open doesn't hit this, regardless of how the app is started.
if (process.platform !== 'darwin') process.exit(0);

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
try {
  const prebuildsDir = path.join(root, 'prebuilds');
  for (const name of fs.readdirSync(prebuildsDir)) {
    candidates.push(path.join(prebuildsDir, name, 'spawn-helper'));
  }
} catch (_) { /* no prebuilds dir */ }

for (const helper of candidates) {
  if (!fs.existsSync(helper)) continue;
  try { fs.chmodSync(helper, 0o755); } catch (_) {}
  try { execFileSync('xattr', ['-d', 'com.apple.quarantine', helper], { stdio: 'ignore' }); } catch (_) {}
}

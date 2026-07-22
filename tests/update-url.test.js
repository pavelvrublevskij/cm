const { test } = require('node:test');
const assert = require('node:assert');

const OWNER = 'pavelvrublevskij';
const REPO = 'cm';

// v1.2.1 is created with release/v1.2.1 branch (no tag/branch name collision),
// so its zipball_url returns a clean 302 redirect — not the HTTP 300 that
// occurs when a branch and tag share the same name.
const KNOWN_TAG = 'v1.2.1';

async function fetchZip(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'cm' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function assertValidZip(buf, label) {
  assert.ok(buf.length > 1000, `${label}: zip too small (${buf.length} bytes)`);
  assert.strictEqual(buf[0], 0x50, `${label}: expected ZIP magic byte P`);
  assert.strictEqual(buf[1], 0x4B, `${label}: expected ZIP magic byte K`);
}

test('zipball_url for known release tag returns valid zip', { skip: 'enable once v1.2.1 release is published on GitHub' }, async () => {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/zipball/${KNOWN_TAG}`;
  const buf = await fetchZip(url);
  assertValidZip(buf, KNOWN_TAG);
}, { timeout: 15000 });

test('fallback main-branch zip returns valid zip', async () => {
  const url = `https://github.com/${OWNER}/${REPO}/archive/refs/heads/main.zip`;
  const buf = await fetchZip(url);
  assertValidZip(buf, 'main');
}, { timeout: 15000 });

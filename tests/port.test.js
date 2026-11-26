const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
require('./helpers/app');
const { APP_CONFIG_FILE } = require('../lib/paths');
const { getPort, savePort } = require('../lib/port');

function withEnvPort(value, fn) {
  const orig = process.env.PORT;
  if (value === undefined) delete process.env.PORT;
  else process.env.PORT = value;
  try { return fn(); }
  finally {
    if (orig === undefined) delete process.env.PORT;
    else process.env.PORT = orig;
  }
}

test('getPort defaults to 3000 when nothing is saved', () => {
  fs.rmSync(APP_CONFIG_FILE, { force: true });
  withEnvPort(undefined, () => assert.strictEqual(getPort(), 3000));
});

test('getPort uses the saved port so autostart reuses the last chosen one', () => {
  fs.rmSync(APP_CONFIG_FILE, { force: true });
  savePort('3001');
  withEnvPort(undefined, () => assert.strictEqual(getPort(), 3001));
});

test('PORT env var wins over the saved port', () => {
  savePort(3001);
  withEnvPort('3005', () => assert.strictEqual(getPort(), 3005));
});

test('savePort keeps the other app-config.json keys', () => {
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify({ autostartPrompted: true }));
  savePort(3002);
  const config = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf-8'));
  assert.deepStrictEqual(config, { autostartPrompted: true, port: 3002 });
});

test('scripts/port.js saves a port and prints it back', () => {
  fs.rmSync(APP_CONFIG_FILE, { force: true });
  const script = path.join(__dirname, '..', 'scripts', 'port.js');
  const env = { ...process.env };
  delete env.PORT;
  cp.execFileSync(process.execPath, [script, '3007'], { env });
  assert.strictEqual(cp.execFileSync(process.execPath, [script], { env, encoding: 'utf-8' }).trim(), '3007');
});

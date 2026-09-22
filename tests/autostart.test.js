const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const request = require('supertest');
const { app, HOME } = require('./helpers/app');
const autostartLib = require('../lib/autostart');
const { APP_CONFIG_FILE } = require('../lib/paths');

function withPlatform(name, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: name, configurable: true });
  try { return fn(); }
  finally { Object.defineProperty(process, 'platform', orig); }
}

test('isSupported is true on win32/darwin/linux, false elsewhere', () => {
  withPlatform('win32', () => assert.strictEqual(autostartLib.isSupported(), true));
  withPlatform('darwin', () => assert.strictEqual(autostartLib.isSupported(), true));
  withPlatform('linux', () => assert.strictEqual(autostartLib.isSupported(), true));
  withPlatform('sunos', () => assert.strictEqual(autostartLib.isSupported(), false));
});

test('macOS: enable/disable manage a LaunchAgent plist under the (faked) home directory', () => {
  withPlatform('darwin', () => {
    const plistPath = path.join(HOME, 'Library', 'LaunchAgents', 'com.claude-manager.autostart.plist');
    fs.rmSync(plistPath, { force: true });

    assert.strictEqual(autostartLib.isEnabled(), false);
    autostartLib.enable();
    assert.strictEqual(fs.existsSync(plistPath), true);
    assert.strictEqual(autostartLib.isEnabled(), true);
    const content = fs.readFileSync(plistPath, 'utf-8');
    assert.ok(content.includes('RunAtLoad'));
    assert.ok(content.includes('CM_AUTOSTART_OPEN'));

    autostartLib.disable();
    assert.strictEqual(fs.existsSync(plistPath), false);
    assert.strictEqual(autostartLib.isEnabled(), false);
  });
});

test('Linux: enable/disable manage an XDG autostart .desktop entry under the (faked) home directory', () => {
  withPlatform('linux', () => {
    const desktopPath = path.join(HOME, '.config', 'autostart', 'claude-manager.desktop');
    fs.rmSync(desktopPath, { force: true });

    assert.strictEqual(autostartLib.isEnabled(), false);
    autostartLib.enable();
    assert.strictEqual(fs.existsSync(desktopPath), true);
    assert.strictEqual(autostartLib.isEnabled(), true);
    const content = fs.readFileSync(desktopPath, 'utf-8');
    assert.ok(content.includes('CM_AUTOSTART_OPEN=1'));

    autostartLib.disable();
    assert.strictEqual(fs.existsSync(desktopPath), false);
    assert.strictEqual(autostartLib.isEnabled(), false);
  });
});

test('Windows: enable/disable drive the registry Run key via a hidden-launch .vbs wrapper (child_process mocked — never touches the real registry)', (t) => {
  withPlatform('win32', () => {
    const calls = [];
    let queryShouldSucceed = false;
    t.mock.method(cp, 'execFileSync', (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'reg' && args[0] === 'query') {
        if (!queryShouldSucceed) throw new Error('not found');
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    assert.strictEqual(autostartLib.isEnabled(), false);

    autostartLib.enable();
    const addCall = calls.find(c => c.cmd === 'reg' && c.args[0] === 'add');
    assert.ok(addCall, 'reg add was called');
    assert.ok(addCall.args.includes('ClaudeManager'));
    const vbsPath = path.join(__dirname, '..', 'scripts', 'autostart-launcher.vbs');
    assert.strictEqual(fs.existsSync(vbsPath), true);
    const vbsContent = fs.readFileSync(vbsPath, 'utf-8');
    assert.ok(vbsContent.includes('CM_AUTOSTART_OPEN'));
    assert.ok(vbsContent.includes('WScript.Shell'));

    queryShouldSucceed = true;
    assert.strictEqual(autostartLib.isEnabled(), true);

    autostartLib.disable();
    const deleteCall = calls.find(c => c.cmd === 'reg' && c.args[0] === 'delete');
    assert.ok(deleteCall, 'reg delete was called');
    assert.strictEqual(fs.existsSync(vbsPath), false);
  });
});

test('GET /api/autostart reports supported/enabled/prompted', async (t) => {
  fs.rmSync(APP_CONFIG_FILE, { force: true });
  t.mock.method(autostartLib, 'isSupported', () => true);
  t.mock.method(autostartLib, 'isEnabled', () => false);

  const res = await request(app).get('/api/autostart');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { supported: true, enabled: false, prompted: false });
});

test('POST /api/autostart/enable calls autostart.enable() and reports enabled', async (t) => {
  t.mock.method(autostartLib, 'isSupported', () => true);
  let enableCalled = false;
  t.mock.method(autostartLib, 'enable', () => { enableCalled = true; });

  const res = await request(app).post('/api/autostart/enable');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, true);
  assert.strictEqual(enableCalled, true);
});

test('POST /api/autostart/enable on an unsupported platform is rejected', async (t) => {
  t.mock.method(autostartLib, 'isSupported', () => false);

  const res = await request(app).post('/api/autostart/enable');
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /api/autostart/disable calls autostart.disable()', async (t) => {
  t.mock.method(autostartLib, 'isSupported', () => true);
  let disableCalled = false;
  t.mock.method(autostartLib, 'disable', () => { disableCalled = true; });

  const res = await request(app).post('/api/autostart/disable');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.enabled, false);
  assert.strictEqual(disableCalled, true);
});

test('POST /api/autostart/dismiss persists the prompted flag so the first-run prompt never asks again', async () => {
  fs.rmSync(APP_CONFIG_FILE, { force: true });

  const before = await request(app).get('/api/autostart');
  assert.strictEqual(before.body.prompted, false);

  const dismiss = await request(app).post('/api/autostart/dismiss');
  assert.strictEqual(dismiss.status, 200);

  const config = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf-8'));
  assert.strictEqual(config.autostartPrompted, true);
});

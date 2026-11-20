const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const request = require('supertest');
const { app } = require('./helpers/app');
const terminalServer = require('../lib/terminal-server');

// A browser-terminal claude reports through its hooks whether it waits for the user; the tab badge
// counts those sessions.

const SLUG = 'C--work-attention-proj';
const SID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'abc123';

const hook = body => request(app).post('/api/terminal/hook').send(Object.assign({ token: TOKEN }, body));
const waiting = async () => (await request(app).get('/api/terminal/attention')).body.waiting;

afterEach(() => {
  terminalServer._clearAll();
  terminalServer._resetHooks();
});

test('initHooks writes a hooks file wiring every reported event to the session hook script', () => {
  terminalServer.initHooks('http://127.0.0.1:1');
  const { hooks } = JSON.parse(fs.readFileSync(terminalServer.SESSION_HOOKS_FILE, 'utf-8'));
  assert.deepStrictEqual(Object.keys(hooks), terminalServer.SESSION_HOOK_EVENTS);
  assert.match(hooks.Notification[0].hooks[0].command, /session-hook\.js/);
});

test('a notification marks the session waiting; a prompt, a finished tool or a stop clears it', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  assert.strictEqual(await waiting(), 0);
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    assert.strictEqual((await hook({ event: 'Notification', notificationType: 'permission_prompt' })).status, 200);
    assert.strictEqual(await waiting(), 1);
    await hook({ event });
    assert.strictEqual(await waiting(), 0, `${event} clears it`);
  }
});

test('a login confirmation does not count as waiting', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  await hook({ event: 'Notification', notificationType: 'auth_success' });
  assert.strictEqual(await waiting(), 0);
});

test('a session that ends no longer counts', async () => {
  const entry = terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  await hook({ event: 'Notification', notificationType: 'idle_prompt' });
  assert.strictEqual(await waiting(), 1);
  entry.terminate('closed');
  assert.strictEqual(await waiting(), 0);
});

test('an unknown or missing token is rejected', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  assert.strictEqual((await hook({ token: 'wrong', event: 'Notification' })).status, 403);
  assert.strictEqual((await request(app).post('/api/terminal/hook').send({ event: 'Notification' })).status, 403);
  assert.strictEqual(await waiting(), 0);
});

test('another tool finishing does not answer a permission prompt; the prompted tool finishing does', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  await hook({ event: 'PreToolUse', toolUseId: 'read' });
  await hook({ event: 'PreToolUse', toolUseId: 'bash' });
  await hook({ event: 'Notification', notificationType: 'permission_prompt' });
  await hook({ event: 'PostToolUse', toolUseId: 'read' });
  assert.strictEqual(await waiting(), 1);
  await hook({ event: 'PostToolUseFailure', toolUseId: 'bash' });
  assert.strictEqual(await waiting(), 0);
});

test('an idle notification while a subagent works is not waiting', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  await hook({ event: 'SubagentStart', agentId: 'a1' });
  await hook({ event: 'Notification', notificationType: 'idle_prompt' });
  assert.strictEqual(await waiting(), 0);
  await hook({ event: 'SubagentStop', agentId: 'a1' });
  await hook({ event: 'Notification', notificationType: 'idle_prompt' });
  assert.strictEqual(await waiting(), 1);
});

test('a hidden background session is not counted', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, hidden: true });
  await hook({ event: 'Notification', notificationType: 'permission_prompt' });
  assert.strictEqual(await waiting(), 0);
});

test('a claude terminal gets the session hooks and a token once initHooks ran; a shell never does', () => {
  assert.deepStrictEqual(terminalServer._spawnOptions(false), { hookToken: '', opts: { cols: 80, rows: 24 } });
  terminalServer.initHooks('http://127.0.0.1:1');
  const { hookToken, opts } = terminalServer._spawnOptions(false);
  assert.match(hookToken, /^[0-9a-f]{32}$/);
  assert.deepStrictEqual(opts.args, ['--settings', terminalServer.SESSION_HOOKS_FILE]);
  assert.deepStrictEqual(opts.env, { CM_SESSION_URL: 'http://127.0.0.1:1', CM_SESSION_TOKEN: hookToken });
  assert.notStrictEqual(terminalServer._spawnOptions(false).hookToken, hookToken, 'a new token per session');
  assert.deepStrictEqual(terminalServer._spawnOptions(true), { hookToken: '', opts: { cols: 80, rows: 24 } });
});

/** Run scripts/session-hook.js with a hook event on stdin and the given environment. */
function runHookScript(event, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'session-hook.js')], {
      env: Object.assign({}, process.env, env), stdio: ['pipe', 'ignore', 'ignore']
    });
    child.on('exit', resolve);
    child.stdin.end(JSON.stringify(event));
  });
}

test('the hook script reports the event with its token to CM', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { bodies.push({ url: req.url, body: JSON.parse(body) }); res.end('{}'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const code = await runHookScript(
    { hook_event_name: 'PreToolUse', notification_type: '', tool_use_id: 'tu1', agent_id: 'ag1' },
    { CM_SESSION_URL: url, CM_SESSION_TOKEN: 'tok' }
  );
  server.close();
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(bodies, [{
    url: '/api/terminal/hook',
    body: { token: 'tok', event: 'PreToolUse', notificationType: '', toolUseId: 'tu1', agentId: 'ag1' }
  }]);
});

test('the hook script does nothing outside a CM session and never fails when CM is down', async () => {
  assert.strictEqual(await runHookScript({ hook_event_name: 'Stop' }, { CM_SESSION_URL: '', CM_SESSION_TOKEN: '' }), 0);
  assert.strictEqual(await runHookScript({ hook_event_name: 'Stop' }, { CM_SESSION_URL: 'http://127.0.0.1:1', CM_SESSION_TOKEN: 'tok' }), 0);
});

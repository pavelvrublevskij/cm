const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('./helpers/app');
const terminalServer = require('../lib/terminal-server');

// The conversation view's message box: the server says whether a CM-run session can take a
// message now, and pastes and submits one into its pty.

const SLUG = 'C--work-input-proj';
const SID = '11111111-2222-3333-4444-666666666666';
const TOKEN = 'input-token';

const hook = body => request(app).post('/api/terminal/hook').send(Object.assign({ token: TOKEN }, body));
const state = async () => (await request(app).get(`/api/projects/${SLUG}/sessions/${SID}/input-state`)).body.state;
const send = text => request(app).post(`/api/projects/${SLUG}/sessions/${SID}/input`).send({ text });

function fakeTerm() {
  const writes = [];
  return { writes, write(s) { writes.push(s); }, kill() {}, pid: process.pid };
}

afterEach(() => terminalServer._clearAll());

test('a session with no CM pty, a hidden one or a shell cannot take input', async () => {
  assert.strictEqual(await state(), 'none');
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, hidden: true });
  assert.strictEqual(await state(), 'none');
  terminalServer._clearAll();
  terminalServer._injectFakeEntry(SLUG, SID, { mode: 'shell' });
  assert.strictEqual(await state(), 'none');
});

test('a prompt makes the session busy until it stops or sits idle at the prompt', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  assert.strictEqual(await state(), 'ready');
  await hook({ event: 'UserPromptSubmit' });
  assert.strictEqual(await state(), 'busy');
  await hook({ event: 'Stop' });
  assert.strictEqual(await state(), 'ready');
  await hook({ event: 'UserPromptSubmit' });
  await hook({ event: 'Notification', notificationType: 'idle_prompt' });
  assert.strictEqual(await state(), 'ready');
});

test('an open AskUserQuestion or permission prompt is a question until its tool finishes', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  await hook({ event: 'UserPromptSubmit' });
  await hook({ event: 'PreToolUse', toolUseId: 'q1', toolName: 'AskUserQuestion' });
  assert.strictEqual(await state(), 'question');
  await hook({ event: 'PostToolUse', toolUseId: 'q1' });
  assert.strictEqual(await state(), 'busy');
  await hook({ event: 'PreToolUse', toolUseId: 'b1', toolName: 'Bash' });
  assert.strictEqual(await state(), 'busy', 'a running tool is not a question');
  await hook({ event: 'Notification', notificationType: 'permission_prompt' });
  assert.strictEqual(await state(), 'question');
  await hook({ event: 'PostToolUse', toolUseId: 'b1' });
  assert.strictEqual(await state(), 'busy');
});

test('sending pastes the text, presses Enter after a moment and marks the session busy', async () => {
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, term });
  const res = await send('line one\r\nline two');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(term.writes, ['\x1b[200~line one\nline two\x1b[201~']);
  assert.strictEqual(await state(), 'busy');
  await new Promise(r => setTimeout(r, 200));
  assert.deepStrictEqual(term.writes.slice(1), ['\r']);
});

test('a session without the session hooks (a Task Board session, one started before initHooks) cannot take input', async () => {
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { term });
  assert.strictEqual(await state(), 'none');
  assert.strictEqual((await send('hi')).status, 404);
  assert.deepStrictEqual(term.writes, []);
});

test('Enter is pressed again until UserPromptSubmit confirms the message went out', async () => {
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, term });
  await send('/plan something');
  await new Promise(r => setTimeout(r, 1800));
  assert.deepStrictEqual(term.writes.slice(1), ['\r', '\r'], 'the first Enter was not confirmed');
  await hook({ event: 'UserPromptSubmit' });
  await new Promise(r => setTimeout(r, 1600));
  assert.deepStrictEqual(term.writes.slice(1), ['\r', '\r'], 'no Enter after the confirmation');
});

test('an idle prompt clears a tool or question left open by an interrupt, and busy even while a subagent is listed', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  await hook({ event: 'UserPromptSubmit' });
  await hook({ event: 'PreToolUse', toolUseId: 'q1', toolName: 'AskUserQuestion' });
  await hook({ event: 'Notification', notificationType: 'idle_prompt' });
  assert.strictEqual(await state(), 'ready');
  await hook({ event: 'UserPromptSubmit' });
  await hook({ event: 'SubagentStart', agentId: 'a1' });
  await hook({ event: 'Notification', notificationType: 'idle_prompt' });
  assert.strictEqual(await state(), 'ready');
});

test('sending is refused when there is no pty, Claude is busy, a question is open or the text is empty', async () => {
  assert.strictEqual((await send('hi')).status, 404);
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, term });
  assert.strictEqual((await send('   ')).status, 400);
  await hook({ event: 'UserPromptSubmit' });
  assert.strictEqual((await send('hi')).status, 409);
  await hook({ event: 'PreToolUse', toolUseId: 'q1', toolName: 'AskUserQuestion' });
  assert.strictEqual((await send('hi')).status, 409);
  assert.deepStrictEqual(term.writes, []);
});

// --- client: public/js/session-input.js ---

function loadClient() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/session-input.js'), 'utf-8');
  const els = {
    'session-input': { style: {}, dataset: {} },
    'session-input-text': { value: '', disabled: false },
    'session-input-send': { disabled: false },
    'session-input-note': { textContent: '' }
  };
  const h = { els, calls: [], response: {}, toasts: [] };
  const context = vm.createContext({
    document: { getElementById: id => els[id] || null },
    Sessions: { detailState: { slug: 'proj', sessionId: 'sid' } },
    api: async (url, opts) => {
      h.calls.push({ url, opts });
      if (h.gate) await h.gate;
      if (h.error && opts) throw new Error(h.error);
      return opts ? { ok: true } : h.response;
    },
    toast: (msg, type) => h.toasts.push({ msg, type })
  });
  vm.runInContext(src + '\nthis.SessionInput = SessionInput;', context);
  h.SessionInput = context.SessionInput;
  h.context = context;
  return h;
}

test('client: the box is enabled only when ready and says why otherwise', async () => {
  const h = loadClient();
  for (const s of ['none', 'busy', 'question']) {
    h.response = { state: s };
    await h.SessionInput.refresh();
    assert.strictEqual(h.els['session-input-text'].disabled, true, s);
    assert.strictEqual(h.els['session-input-send'].disabled, true, s);
    assert.ok(h.els['session-input-note'].textContent, s);
  }
  h.response = { state: 'ready' };
  await h.SessionInput.refresh();
  assert.strictEqual(h.els['session-input-text'].disabled, false);
  assert.strictEqual(h.els['session-input-note'].textContent, '');
  assert.strictEqual(h.calls[0].url, '/api/projects/proj/sessions/sid/input-state');
});

test('client: the box is hidden until the session has an id', () => {
  const h = loadClient();
  h.context.Sessions.detailState = { slug: 'proj', sessionId: null };
  h.SessionInput.render('none');
  assert.strictEqual(h.els['session-input'].style.display, 'none');
});

test('client: Enter sends, Shift+Enter does not', async () => {
  const h = loadClient();
  h.SessionInput.render('ready');
  h.els['session-input-text'].value = 'hello';
  let prevented = 0;
  h.SessionInput.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault: () => prevented++ });
  assert.strictEqual(prevented, 0);
  assert.strictEqual(h.calls.length, 0);
  h.response = { state: 'busy' };
  h.SessionInput.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault: () => prevented++ });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(prevented, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.calls[0])),
    { url: '/api/projects/proj/sessions/sid/input', opts: { method: 'POST', body: { text: 'hello' } } });
  assert.strictEqual(h.calls[1].url, '/api/projects/proj/sessions/sid/input-state', 'state checked after sending');
  assert.strictEqual(h.els['session-input-text'].value, '', 'cleared after sending');
  assert.strictEqual(h.SessionInput.state, 'busy');
});

test('client: nothing is sent while not ready or when empty; a failed send keeps the text', async () => {
  const h = loadClient();
  h.SessionInput.render('busy');
  h.els['session-input-text'].value = 'hello';
  await h.SessionInput.send();
  h.SessionInput.render('ready');
  h.els['session-input-text'].value = '  ';
  await h.SessionInput.send();
  assert.strictEqual(h.calls.length, 0);
  h.els['session-input-text'].value = 'hello';
  h.error = 'Claude is busy';
  await h.SessionInput.send();
  assert.strictEqual(h.els['session-input-text'].value, 'hello');
  assert.deepStrictEqual(h.toasts, [{ msg: 'Claude is busy', type: 'error' }]);
});

test('client: a read-only view hides the box and sends nothing', async () => {
  const h = loadClient();
  h.context.Sessions.detailState = { slug: 'proj', sessionId: 'sid', readOnly: true };
  h.SessionInput.render('ready');
  assert.strictEqual(h.els['session-input'].style.display, 'none');
  h.els['session-input-text'].value = 'hello';
  await h.SessionInput.send();
  assert.strictEqual(h.calls.length, 0);
});

test('client: a poll started before a send cannot re-enable the box; a double Enter sends once', async () => {
  const h = loadClient();
  h.SessionInput.render('ready');
  let release;
  h.gate = new Promise(r => { release = r; });
  h.response = { state: 'ready' };
  const poll = h.SessionInput.refresh();
  h.els['session-input-text'].value = 'hello';
  const first = h.SessionInput.send();
  const second = h.SessionInput.send();
  release();
  h.gate = null;
  h.response = { state: 'busy' };
  await Promise.all([poll, first, second]);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(h.calls.filter(c => c.opts).length, 1, 'one POST');
  assert.strictEqual(h.SessionInput.state, 'busy');
  assert.strictEqual(h.els['session-input-text'].disabled, true);
});

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

test('a session with no CM pty or a shell cannot take input', async () => {
  assert.strictEqual(await state(), 'none');
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

test('sending is refused when there is no pty, a question is open or the text is empty', async () => {
  assert.strictEqual((await send('hi')).status, 404);
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, term });
  assert.strictEqual((await send('   ')).status, 400);
  await hook({ event: 'PreToolUse', toolUseId: 'q1', toolName: 'AskUserQuestion' });
  assert.strictEqual((await send('hi')).status, 409);
  assert.deepStrictEqual(term.writes, []);
});

test('a message sent while Claude works is pasted and gets one Enter, for claude to queue', async () => {
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, term });
  await hook({ event: 'UserPromptSubmit' });
  assert.strictEqual((await send('also this')).status, 200);
  await new Promise(r => setTimeout(r, 1800));
  assert.deepStrictEqual(term.writes, ['\x1b[200~also this\x1b[201~', '\r']);
});

test('no Enter is pressed again once a question opens', async () => {
  const term = fakeTerm();
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN, term });
  await send('hi');
  await new Promise(r => setTimeout(r, 200));
  await hook({ event: 'PreToolUse', toolUseId: 'q1', toolName: 'AskUserQuestion' });
  await new Promise(r => setTimeout(r, 1600));
  assert.deepStrictEqual(term.writes.slice(1), ['\r']);
});

test('a new session without an id yet sends its message over the terminal WebSocket', async () => {
  const term = fakeTerm();
  const entry = { slug: SLUG, sessionId: '', mode: 'claude', hookToken: TOKEN, term, terminated: false };
  const handlers = {};
  const sent = [];
  const ws = { readyState: 1, on(evt, fn) { handlers[evt] = fn; }, send(d) { sent.push(d); }, close() {} };
  terminalServer._bindWs(entry, ws);
  handlers.message(JSON.stringify({ t: 'send', text: 'first message' }));
  assert.deepStrictEqual(term.writes, ['\x1b[200~first message\x1b[201~']);
  entry.questions = new Set(['q1']);
  handlers.message(JSON.stringify({ t: 'send', text: 'second' }));
  assert.deepStrictEqual(sent.map(d => JSON.parse(d)), [{ t: 'send-error', error: 'A question is open' }]);
  entry.terminated = true;
});

// --- client: public/js/session-input.js ---

// Setting textContent or innerHTML replaces the other, as on a real element.
function fakeNote() {
  let html = '';
  return {
    dataset: {},
    writes: 0,
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; this.writes++; },
    get textContent() { return html.replace(/<[^>]*>/g, ''); },
    set textContent(v) { html = v; this.writes++; }
  };
}

function loadClient() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/session-input.js'), 'utf-8');
  const els = {
    'session-input': { style: {}, dataset: {} },
    'session-input-text': { value: '', disabled: false },
    'session-input-note': fakeNote()
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

test('client: the box is disabled with a note without a CM pty or while a question is open', async () => {
  const h = loadClient();
  for (const s of ['none', 'question']) {
    h.response = { state: s };
    await h.SessionInput.refresh();
    assert.strictEqual(h.els['session-input-text'].disabled, true, s);
    assert.ok(h.els['session-input-note'].textContent, s);
  }
  h.response = { state: 'busy' };
  await h.SessionInput.refresh();
  assert.strictEqual(h.els['session-input-text'].disabled, false, 'busy: a message can be queued');
  assert.ok(h.els['session-input-note'].textContent);
  h.response = { state: 'ready' };
  await h.SessionInput.refresh();
  assert.strictEqual(h.els['session-input-text'].disabled, false);
  assert.strictEqual(h.els['session-input-note'].textContent, '');
  assert.strictEqual(h.calls[0].url, '/api/projects/proj/sessions/sid/input-state');
});

test('client: only the busy note shows a spinner', async () => {
  const h = loadClient();
  const note = h.els['session-input-note'];
  h.SessionInput.render('busy');
  assert.ok(note.innerHTML.startsWith('<span class="btn-spinner"></span>'));
  assert.strictEqual(note.textContent, h.SessionInput.NOTES.busy);
  for (const s of ['none', 'question', 'ready']) {
    h.SessionInput.render(s);
    assert.ok(!note.innerHTML.includes('btn-spinner'), s);
    assert.strictEqual(note.textContent, h.SessionInput.NOTES[s], s);
  }
});

test('client: a repeated busy render keeps the running spinner', () => {
  const h = loadClient();
  const note = h.els['session-input-note'];
  h.SessionInput.render('busy');
  const writes = note.writes;
  h.SessionInput.render('busy');
  assert.strictEqual(note.writes, writes, 'a poll in the same state does not rewrite the note');
  h.SessionInput.render('ready');
  assert.strictEqual(note.writes, writes + 1);
});

test('client: a new session without an id is ready and sends through the terminal panel', async () => {
  const h = loadClient();
  const sent = [];
  let connected = true;
  h.context.TerminalPanel = { sendMessage: t => { if (connected) sent.push(t); return connected; } };
  h.context.Sessions.detailState = { slug: 'proj', sessionId: null };
  await h.SessionInput.refresh();
  assert.strictEqual(h.els['session-input'].style.display, '');
  assert.strictEqual(h.SessionInput.state, 'ready');
  assert.strictEqual(h.calls.length, 0, 'no input-state request without an id');
  h.els['session-input-text'].value = 'hello';
  await h.SessionInput.send();
  assert.deepStrictEqual(sent, ['hello']);
  assert.strictEqual(h.els['session-input-text'].value, '');
  assert.strictEqual(h.SessionInput.state, 'busy');
  await h.SessionInput.refresh();
  assert.strictEqual(h.SessionInput.state, 'busy', 'stays busy until the session is found');
  connected = false;
  h.els['session-input-text'].value = 'again';
  await h.SessionInput.send();
  assert.strictEqual(h.els['session-input-text'].value, 'again');
  assert.deepStrictEqual(h.toasts, [{ msg: 'The terminal is not connected yet', type: 'error' }]);
  assert.strictEqual(h.calls.length, 0);
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

test('client: nothing is sent while a question is open or when empty; a failed send keeps the text', async () => {
  const h = loadClient();
  h.SessionInput.render('question');
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

test('client: a poll started before a send cannot overwrite its state; a double Enter sends once', async () => {
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
});

test('a revealed Task Board session follows the board-forwarded hook events and is not counted for attention', async () => {
  const entry = terminalServer._injectFakeEntry(SLUG, SID, { boardHooks: true });
  assert.strictEqual(await state(), 'ready');
  terminalServer.trackHookEvent(entry, { event: 'UserPromptSubmit' });
  assert.strictEqual(await state(), 'busy');
  terminalServer.trackHookEvent(entry, { event: 'PreToolUse', toolUseId: 'q1', toolName: 'AskUserQuestion' });
  terminalServer.trackHookEvent(entry, { event: 'Notification', notificationType: 'elicitation_dialog' });
  assert.strictEqual(await state(), 'question');
  assert.strictEqual((await request(app).get('/api/terminal/attention')).body.waiting, 0);
  terminalServer.trackHookEvent(entry, { event: 'PostToolUse', toolUseId: 'q1' });
  entry.hidden = true;
  assert.strictEqual(await state(), 'busy', 'hidden on the board, it still takes messages');
  const term = fakeTerm();
  entry.term = term;
  assert.strictEqual((await send('go on')).status, 200);
  assert.deepStrictEqual(term.writes, ['\x1b[200~go on\x1b[201~']);
  assert.strictEqual(entry.hidden, true, 'sending does not reveal it');
  await new Promise(r => setTimeout(r, 200));
});

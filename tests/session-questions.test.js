const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const request = require('supertest');
const { app, paths } = require('./helpers/app');
const terminalServer = require('../lib/terminal-server');
const { answersError, questionHookGroup, QUESTION_HOLD_MS } = require('../lib/question-hook');
const { answerOutput } = require('../scripts/question-hook');

// Claude's AskUserQuestion as a card in CM's conversation: parsed from the JSONL, held by the
// PreToolUse question hook for sessions CM runs, and answered or released from the card.

const SLUG = 'C--work-question-proj';
const SID = '11111111-2222-3333-4444-777777777777';
const TOKEN = 'question-token';
const BASE = `/api/projects/${SLUG}/sessions/${SID}`;

const QUESTIONS = [
  { question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: 'SQL' }, { label: 'Mongo', description: 'Docs' }] },
  { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Cache', description: '' }, { label: 'Queue', description: '' }] }
];

afterEach(() => terminalServer._clearAll());

/** Start a hold like scripts/question-hook.js does; resolves with the hook's response once CM replies. */
function hold(body) {
  return new Promise(resolve => {
    request(app).post('/api/terminal/question')
      .send(Object.assign({ token: TOKEN, toolUseId: 'q1', questions: QUESTIONS }, body))
      .then(resolve);
  });
}

async function waitHeld(n = 1) {
  for (let i = 0; i < 100; i++) {
    if (terminalServer.heldQuestions(SLUG, SID).length >= n) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('question was not held');
}

// --- lib/question-hook.js and the hook's output ---

test('the question hook is a PreToolUse group for AskUserQuestion that outlasts the hold', () => {
  const group = questionHookGroup();
  assert.strictEqual(group.matcher, 'AskUserQuestion');
  assert.match(group.hooks[0].command, /question-hook\.js"$/);
  assert.ok(group.hooks[0].timeout > QUESTION_HOLD_MS / 1000);
  assert.strictEqual(QUESTION_HOLD_MS, 600000);
});

test('answers need one non-empty string per question, keyed by the question text', () => {
  assert.strictEqual(answersError(QUESTIONS, { 'Which DB?': 'Postgres', 'Which extras?': 'Cache, Queue' }), '');
  assert.strictEqual(answersError(QUESTIONS, null), 'Answers are missing');
  assert.strictEqual(answersError(QUESTIONS, ['x']), 'Answers are missing');
  assert.strictEqual(answersError(QUESTIONS, { 'Which DB?': 'Postgres' }), 'Answer every question');
  assert.strictEqual(answersError(QUESTIONS, { 'Which DB?': 'Postgres', 'Other?': 'x' }), 'Answer every question');
  assert.strictEqual(answersError(QUESTIONS, { 'Which DB?': '  ', 'Which extras?': 'Cache' }), 'Answer every question');
  assert.strictEqual(answersError(QUESTIONS, { 'Which DB?': 1, 'Which extras?': 'Cache' }), 'Answer every question');
});

test('the hook output allows the tool with the answers added to its whole input', () => {
  const input = { questions: QUESTIONS, metadata: { source: 'x' } };
  const out = JSON.parse(answerOutput(input, { 'Which DB?': 'Mongo' }));
  assert.deepStrictEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions: QUESTIONS, metadata: { source: 'x' }, answers: { 'Which DB?': 'Mongo' } }
    }
  });
});

test('the session and Task Board hooks files hold AskUserQuestion with the question hook', () => {
  terminalServer.initHooks('http://127.0.0.1:1');
  const { hooks } = JSON.parse(fs.readFileSync(terminalServer.SESSION_HOOKS_FILE, 'utf-8'));
  assert.match(hooks.PreToolUse[0].hooks[0].command, /session-hook\.js"$/);
  assert.strictEqual(hooks.PreToolUse[1].matcher, 'AskUserQuestion');
  assert.match(hooks.PreToolUse[1].hooks[0].command, /question-hook\.js"$/);
  terminalServer._resetHooks();
});

// --- hold, answer, release ---

test('a held question is listed with the input state until it is answered; the hook gets the answers', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  const reply = hold();
  await waitHeld();
  const st = (await request(app).get(BASE + '/input-state')).body;
  assert.deepStrictEqual(st.questions, [{ toolUseId: 'q1', questions: QUESTIONS }]);
  const answers = { 'Which extras?': 'Cache, my own', 'Which DB?': 'Postgres' };
  assert.strictEqual((await request(app).post(BASE + '/question/answer').send({ toolUseId: 'q1', answers })).status, 200);
  const res = await reply;
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { answers: { 'Which DB?': 'Postgres', 'Which extras?': 'Cache, my own' } });
  assert.deepStrictEqual((await request(app).get(BASE + '/input-state')).body.questions, []);
  assert.strictEqual((await request(app).post(BASE + '/question/answer').send({ toolUseId: 'q1', answers })).status, 404,
    'an answered question is no longer open');
});

test('incomplete answers are refused and the question stays held', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  const reply = hold();
  await waitHeld();
  const res = await request(app).post(BASE + '/question/answer').send({ toolUseId: 'q1', answers: { 'Which DB?': 'Postgres' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Answer every question');
  assert.strictEqual(terminalServer.heldQuestions(SLUG, SID).length, 1);
  await request(app).post(BASE + '/question/release').send({ toolUseId: 'q1' });
  await reply;
});

test('releasing a question hands it to the terminal: the hook gets no answers', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  const reply = hold();
  await waitHeld();
  assert.strictEqual((await request(app).post(BASE + '/question/release').send({ toolUseId: 'q1' })).status, 200);
  assert.deepStrictEqual((await reply).body, {});
  assert.strictEqual((await request(app).post(BASE + '/question/release').send({ toolUseId: 'q1' })).status, 404);
});

test('a hold needs the token of a running CM pty and a well-formed question', async () => {
  assert.strictEqual((await hold({ token: 'nope' })).status, 403);
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  assert.strictEqual((await hold({ toolUseId: '' })).status, 400);
  assert.strictEqual((await hold({ questions: [] })).status, 400);
  assert.strictEqual((await hold({ questions: [{ question: 'x' }] })).status, 400);
  assert.strictEqual((await request(app).post(BASE + '/question/answer').send({ toolUseId: 'q9', answers: {} })).status, 404);
});

test('a Task Board session holds its question with its run token', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { boardToken: 'run-token', boardHooks: true });
  const reply = hold({ token: 'run-token' });
  await waitHeld();
  await request(app).post(BASE + '/question/answer').send({ toolUseId: 'q1', answers: { 'Which DB?': 'Mongo', 'Which extras?': 'Queue' } });
  assert.deepStrictEqual((await reply).body.answers, { 'Which DB?': 'Mongo', 'Which extras?': 'Queue' });
});

test('a hook that goes away (answered in the terminal, timed out) no longer holds its question', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  const server = app.listen(0);
  const port = server.address().port;
  const body = JSON.stringify({ token: TOKEN, toolUseId: 'q1', questions: QUESTIONS });
  const req = http.request(`http://127.0.0.1:${port}/api/terminal/question`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', () => {});
  req.end(body);
  await waitHeld();
  req.destroy();
  for (let i = 0; i < 100 && terminalServer.heldQuestions(SLUG, SID).length; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual(terminalServer.heldQuestions(SLUG, SID), []);
  server.close();
});

test('the hook script prints the answers given in CM, and nothing when released', async () => {
  terminalServer._injectFakeEntry(SLUG, SID, { hookToken: TOKEN });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (toolUseId, settle) => new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/question-hook.js')], {
      env: Object.assign({}, process.env, { CM_SESSION_URL: url, CM_SESSION_TOKEN: TOKEN })
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('exit', code => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ tool_name: 'AskUserQuestion', tool_use_id: toolUseId, tool_input: { questions: QUESTIONS } }));
    waitHeld().then(settle);
  });
  const answered = await run('q1', () => request(app).post(BASE + '/question/answer')
    .send({ toolUseId: 'q1', answers: { 'Which DB?': 'Mongo', 'Which extras?': 'Cache' } }));
  assert.strictEqual(answered.code, 0);
  assert.deepStrictEqual(JSON.parse(answered.out).hookSpecificOutput.updatedInput.answers, { 'Which DB?': 'Mongo', 'Which extras?': 'Cache' });
  const released = await run('q2', () => request(app).post(BASE + '/question/release').send({ toolUseId: 'q2' }));
  assert.deepStrictEqual(released, { code: 0, out: '' });
  server.close();
});

// --- JSONL parsing ---

test('the conversation keeps the tool call id and an AskUserQuestion result\'s answers', async () => {
  const slug = 'question-parse-proj';
  const sid = '11111111-2222-3333-4444-888888888888';
  const dir = path.join(paths.PROJECTS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', timestamp: '2026-11-23T10:00:00Z', message: { content: 'start' } },
    { type: 'assistant', timestamp: '2026-11-23T10:00:01Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] } },
    { type: 'user', timestamp: '2026-11-23T10:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'User has answered' }] },
      toolUseResult: { questions: QUESTIONS, answers: { 'Which DB?': 'Postgres' }, annotations: {} } },
    { type: 'assistant', timestamp: '2026-11-23T10:00:03Z', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] } },
    { type: 'user', timestamp: '2026-11-23T10:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'declined', is_error: true }] },
      toolUseResult: { questions: QUESTIONS } },
    { type: 'user', timestamp: '2026-11-23T10:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'ok' }] }, toolUseResult: { stdout: 'ok' } },
    { type: 'assistant', timestamp: '2026-11-23T10:00:06Z', message: { content: [{ type: 'tool_use', id: 'tu4', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] } },
    { type: 'user', timestamp: '2026-11-23T10:00:07Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'rejected', is_error: true }] },
      toolUseResult: 'Error: rejected' }
  ];
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const { messages } = (await request(app).get(`/api/projects/${slug}/sessions/${sid}?offset=0&limit=20`)).body;
  const blocks = messages.flatMap(m => m.content);
  const ask = blocks.find(b => b.type === 'tool_use' && b.id === 'tu1');
  assert.strictEqual(ask.name, 'AskUserQuestion');
  const results = Object.fromEntries(blocks.filter(b => b.type === 'tool_result').map(b => [b.toolUseId, b]));
  assert.deepStrictEqual(results.tu1.answers, { 'Which DB?': 'Postgres' });
  assert.deepStrictEqual(results.tu2.answers, {}, 'a declined question has no answers');
  assert.strictEqual(results.tu3.answers, undefined, 'another tool\'s result carries none');
  assert.deepStrictEqual(results.tu4.answers, {}, 'a question cancelled with Esc logs an error string: declined too');
});

// --- client: public/js/session-questions.js ---

function loadClient() {
  const ctx = vm.createContext({
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    CSS: { escape: s => s },
    JSON,
    toast: (msg, kind) => ctx.toasts.push([msg, kind]),
    toasts: [],
    calls: [],
    api: async (url, opts) => { ctx.calls.push([url, opts.body]); if (ctx.fail) throw new Error(ctx.fail); return { ok: true }; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/session-questions.js'), 'utf-8') + '\nthis.SQ = SessionQuestions;', ctx);
  return ctx;
}

const unescape = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A card element as apply() and the form handlers use it. */
function fakeCard(html, live) {
  const id = /data-tool-use-id="([^"]*)"/.exec(html)[1];
  const questions = unescape(/data-questions="([^"]*)"/.exec(html)[1]);
  return { dataset: { toolUseId: id, questions }, innerHTML: '', live, classList: { contains: c => c === 'chat-question--live' && !!live } };
}

/** A conversation root holding cards, result markers and live wrappers, enough for apply(). */
function fakeRoot(cards, markers) {
  const root = {
    cards, markers, lives: [],
    querySelectorAll(sel) {
      if (sel.startsWith('.chat-question-answer')) return root.markers;
      if (sel === '.chat-question:not(.chat-question--live)') return root.cards.filter(c => !c.live);
      if (sel === '.chat-question-live') return root.lives.slice();
      if (sel === '.chat-question[data-tool-use-id]') return root.cards;
      throw new Error('unexpected selector ' + sel);
    },
    querySelector(sel) {
      const id = /data-tool-use-id="([^"]*)"/.exec(sel)[1];
      return root.lives.find(w => w.dataset.toolUseId === id) || null;
    },
    insertAdjacentHTML(where, html) {
      assert.strictEqual(where, 'afterbegin');
      const id = /data-tool-use-id="([^"]*)"/.exec(html)[1];
      const card = fakeCard(html.slice(html.indexOf('<div class="chat-question')), true);
      const wrap = { dataset: { toolUseId: id }, html, remove() { root.lives.splice(root.lives.indexOf(wrap), 1); root.cards.splice(root.cards.indexOf(card), 1); } };
      root.lives.push(wrap);
      root.cards.push(card);
    }
  };
  return root;
}

test('a question card shows the header chip, question, options with descriptions and the multi-select marker', () => {
  const { SQ } = loadClient();
  const html = SQ.cardHtml({ id: 'q1', input: { questions: QUESTIONS } });
  assert.match(html, /class="chat-question" data-tool-use-id="q1"/);
  assert.match(html, /<span class="cq-chip">DB<\/span>/);
  assert.match(html, /<div class="cq-text">Which DB\?<\/div>/);
  assert.match(html, /<span class="cq-label">Postgres<\/span><span class="cq-desc">SQL<\/span>/);
  assert.strictEqual((html.match(/cq-multi/g) || []).length, 1, 'only the multi-select question is marked');
  assert.match(html, /Waiting for an answer in the terminal/);
});

test('an answer is split into the picked options and the own text', () => {
  const { SQ } = loadClient();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SQ.splitAnswer(QUESTIONS[0], 'Postgres'))), { chosen: ['Postgres'], other: '' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SQ.splitAnswer(QUESTIONS[1], 'Cache, Queue'))), { chosen: ['Cache', 'Queue'], other: '' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SQ.splitAnswer(QUESTIONS[1], 'Queue, a cron job'))), { chosen: ['Queue'], other: 'a cron job' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(SQ.splitAnswer(QUESTIONS[0], 'SQLite'))), { chosen: [], other: 'SQLite' });
});

test('apply: a logged answer makes the card read-only with the chosen options; none means declined', () => {
  const { SQ } = loadClient();
  const card = fakeCard(SQ.cardHtml({ id: 'q1', input: { questions: QUESTIONS } }));
  const declined = fakeCard(SQ.cardHtml({ id: 'q2', input: { questions: QUESTIONS } }));
  const marker = id => ({ dataset: { toolUseId: id, answers: unescape(/data-answers="([^"]*)"/.exec(SQ.resultMarkerHtml(
    { toolUseId: id, answers: id === 'q1' ? { 'Which DB?': 'Mongo', 'Which extras?': 'Cache, own' } : {} }))[1]) } });
  SQ.setHeld('/s', [{ toolUseId: 'q1', questions: QUESTIONS }]);
  SQ.apply(fakeRoot([card, declined], [marker('q1'), marker('q2')]), '/s', true);
  assert.match(card.innerHTML, /cq-opt cq-chosen"><span class="cq-label">Mongo/);
  assert.match(card.innerHTML, /Other:<\/span> <span class="cq-other-answer">own/);
  assert.doesNotMatch(card.innerHTML, /<input|<button/, 'an answered card is read-only even while still listed as held');
  assert.match(declined.innerHTML, /Not answered/);
});

test('apply: a held question is answerable only where answering is allowed', () => {
  const { SQ } = loadClient();
  SQ.setHeld('/s', [{ toolUseId: 'q1', questions: QUESTIONS }]);
  const card = fakeCard(SQ.cardHtml({ id: 'q1', input: { questions: QUESTIONS } }));
  SQ.apply(fakeRoot([card], []), '/s', false);
  assert.strictEqual(card.dataset.state, 'open');
  assert.doesNotMatch(card.innerHTML, /<input/);
  SQ.apply(fakeRoot([card], []), '/s', true);
  assert.strictEqual(card.dataset.state, 'ask');
  assert.match(card.innerHTML, /type="radio" name="cq\d+-0" value="Postgres"/);
  assert.match(card.innerHTML, /type="checkbox" name="cq\d+-1" value="Cache"/);
  assert.match(card.innerHTML, /data-other="1"/);
  assert.match(card.innerHTML, /Submit/);
  assert.match(card.innerHTML, /Answer in terminal/);
  const form = card.innerHTML;
  SQ.apply(fakeRoot([card], []), '/s', true);
  assert.strictEqual(card.innerHTML, form, 'an unchanged state keeps the form (and what was picked)');
  SQ.setHeld('/s', []);
  SQ.apply(fakeRoot([card], []), '/s', true);
  assert.strictEqual(card.dataset.state, 'open', 'released or answered in the terminal');
});

test('apply: a held question not yet in the JSONL gets a live card, dropped once the logged one shows', () => {
  const { SQ } = loadClient();
  SQ.setHeld('/s', [{ toolUseId: 'q1', questions: QUESTIONS }]);
  const root = fakeRoot([], []);
  SQ.apply(root, '/s', true);
  assert.strictEqual(root.lives.length, 1);
  assert.match(root.lives[0].html, /chat-msg assistant chat-question-live/);
  assert.strictEqual(root.cards[0].dataset.state, 'ask');
  SQ.apply(root, '/s', true);
  assert.strictEqual(root.lives.length, 1, 'not added twice');
  root.cards.push(fakeCard(SQ.cardHtml({ id: 'q1', input: { questions: QUESTIONS } })));
  SQ.apply(root, '/s', true);
  assert.strictEqual(root.lives.length, 0);
  assert.strictEqual(root.cards.length, 1);
});

/** A card in the answer form with given picks: per question, the checked values ('' = Other) and the Other text. */
function formCard(picks) {
  const card = {
    dataset: { toolUseId: 'q1', url: '/s', questions: JSON.stringify(QUESTIONS), state: 'ask' },
    innerHTML: 'FORM',
    buttons: [{ disabled: false }, { disabled: false }],
    querySelectorAll(sel) {
      if (sel === 'button') return card.buttons;
      if (sel === '.cq-q[data-index]') {
        return picks.map((p, i) => ({
          dataset: { index: String(i) },
          querySelectorAll: () => p.checked.map(v => ({ value: v, dataset: v === '' ? { other: '1' } : {} })),
          querySelector: () => ({ value: p.other || '' })
        }));
      }
      return [];
    }
  };
  return card;
}

test('submit sends one answer per question (multi-select joined with ", ", Other as own text) and locks the card', async () => {
  const ctx = loadClient();
  const { SQ } = ctx;
  SQ.setHeld('/s', [{ toolUseId: 'q1', questions: QUESTIONS }]);
  const card = formCard([{ checked: ['Mongo'] }, { checked: ['Cache', ''], other: ' a cron job ' }]);
  await SQ.submit({ closest: () => card });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.calls)), [['/s/question/answer',
    { toolUseId: 'q1', answers: { 'Which DB?': 'Mongo', 'Which extras?': 'Cache, a cron job' } }]]);
  assert.match(card.dataset.state, /^answered:/);
  assert.doesNotMatch(card.innerHTML, /<input|<button/);
  assert.match(card.innerHTML, /cq-chosen"><span class="cq-label">Mongo/);
  assert.strictEqual(SQ.held.get('/s').size, 0);
});

test('submit refuses a question left unanswered or an empty Other, and keeps the form on a server error', async () => {
  const ctx = loadClient();
  const { SQ } = ctx;
  await SQ.submit({ closest: () => formCard([{ checked: ['Mongo'] }, { checked: [] }]) });
  await SQ.submit({ closest: () => formCard([{ checked: [''], other: '  ' }, { checked: ['Cache'] }]) });
  assert.deepStrictEqual(ctx.calls, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.toasts)), [['Answer every question', 'error'], ['Answer every question', 'error']]);
  ctx.fail = 'This question is no longer open here';
  const card = formCard([{ checked: ['Mongo'] }, { checked: ['Cache'] }]);
  await SQ.submit({ closest: () => card });
  assert.strictEqual(card.innerHTML, 'FORM');
  assert.ok(card.buttons.every(b => !b.disabled));
});

test('answer in terminal releases the question and leaves the card open, read-only', async () => {
  const ctx = loadClient();
  const { SQ } = ctx;
  SQ.setHeld('/s', [{ toolUseId: 'q1', questions: QUESTIONS }]);
  const card = formCard([]);
  await SQ.release({ closest: () => card });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.calls)), [['/s/question/release', { toolUseId: 'q1' }]]);
  assert.strictEqual(card.dataset.state, 'open');
  assert.match(card.innerHTML, /Waiting for an answer in the terminal/);
  assert.strictEqual(SQ.held.get('/s').size, 0);
  SQ.setHeld('/s', [{ toolUseId: 'q1', questions: QUESTIONS }]);
  assert.strictEqual(SQ.held.get('/s').size, 0, 'a poll started before the release does not make it answerable again');
});

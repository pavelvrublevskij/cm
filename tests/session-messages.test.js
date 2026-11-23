const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Minimal Sessions stub — session-messages.js calls Object.assign(Sessions, {...})
const Sessions = { detailState: { slug: 'proj', sessionId: 'sess' } };

let apiResponse = { messages: [] };
let apiCalls = 0;
const api = async () => { apiCalls++; return apiResponse; };

const fakeConvNodes = [];
const document = {
  getElementById: () => null,
  querySelectorAll: () => fakeConvNodes,
};

const src = fs.readFileSync(path.join(__dirname, '../public/js/session-messages.js'), 'utf-8');
const context = vm.createContext({
  Sessions,
  api,
  escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  decodeHtmlEntities: s => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  renderMarkdown: s => String(s),
  renderChatMarkdown: s => String(s),
  shortModel: s => String(s),
  debounce: fn => fn,
  document,
  addCodeCopyButtons: () => {},
  clearTimeout: () => {},
  setTimeout: () => {},
});
vm.runInContext(src, context);

function makeConvEl(agentId) {
  return { dataset: { agentId }, style: {}, innerHTML: '' };
}

function makeMsg(timestamp, role = 'user') {
  return { timestamp, role, content: [{ type: 'text', text: 'hi' }], model: null };
}

function extractTime(html) {
  const m = html.match(/<span class="chat-time">([^<]*)<\/span>/);
  return m ? m[1] : null;
}

test('renderMessage: no timestamp renders empty chat-time', () => {
  const html = Sessions.renderMessage(makeMsg(null));
  assert.strictEqual(extractTime(html), '');
});

test('renderMessage: today\'s timestamp shows only time (no date prefix)', () => {
  const now = new Date();
  const html = Sessions.renderMessage(makeMsg(now.toISOString()));
  const time = extractTime(html);
  assert.ok(time && time.length > 0, 'time should be non-empty');
  // Today's time should NOT contain a comma (date part like "Jun 17, ")
  assert.ok(!time.includes(','), `expected time-only but got: "${time}"`);
});

test('renderMessage: yesterday\'s timestamp includes date prefix', () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const html = Sessions.renderMessage(makeMsg(yesterday.toISOString()));
  const time = extractTime(html);
  assert.ok(time && time.length > 0, 'time should be non-empty');
  // Non-today timestamps include a short month name + day, formatted as "Mon D HH:MM..."
  // At minimum the string should be longer than a bare time string
  const bareTime = new Date(yesterday).toLocaleTimeString();
  assert.ok(time.length > bareTime.length, `expected date+time but got: "${time}"`);
});

test('renderMessage: old timestamp includes date prefix', () => {
  const old = new Date('2024-01-15T09:30:00.000Z');
  const html = Sessions.renderMessage(makeMsg(old.toISOString()));
  const time = extractTime(html);
  const bareTime = old.toLocaleTimeString();
  assert.ok(time.length > bareTime.length, `expected date+time but got: "${time}"`);
});

test('renderMessage: same-day messages across midnight boundary show only time', () => {
  const today = new Date();
  today.setHours(0, 1, 0, 0);
  const html = Sessions.renderMessage(makeMsg(today.toISOString()));
  const time = extractTime(html);
  assert.ok(!time.includes(','), `expected time-only for start-of-today but got: "${time}"`);
});

test('_loadAgentConv: re-fetches and re-renders when message count grew', async () => {
  apiCalls = 0;
  apiResponse = { messages: [makeMsg('2024-01-15T09:30:00.000Z')] };
  const convEl = makeConvEl('agent-1');

  await Sessions._loadAgentConv('agent-1', convEl);
  assert.strictEqual(apiCalls, 1);
  assert.strictEqual(convEl.dataset.loaded, '1');
  assert.strictEqual(convEl.dataset.msgCount, '1');
  const firstRender = convEl.innerHTML;
  assert.ok(firstRender.length > 0);

  apiResponse = { messages: [makeMsg('2024-01-15T09:30:00.000Z'), makeMsg('2024-01-15T09:31:00.000Z')] };
  await Sessions._loadAgentConv('agent-1', convEl);
  assert.strictEqual(apiCalls, 2);
  assert.strictEqual(convEl.dataset.msgCount, '2');
  assert.notStrictEqual(convEl.innerHTML, firstRender);
});

test('_loadAgentConv: skips re-render when message count unchanged', async () => {
  apiCalls = 0;
  apiResponse = { messages: [makeMsg('2024-01-15T09:30:00.000Z')] };
  const convEl = makeConvEl('agent-2');

  await Sessions._loadAgentConv('agent-2', convEl);
  convEl.innerHTML = '<marker>';

  await Sessions._loadAgentConv('agent-2', convEl);
  assert.strictEqual(apiCalls, 2, 'should still poll the endpoint');
  assert.strictEqual(convEl.innerHTML, '<marker>', 'should not clobber DOM when nothing changed');
});

test('refreshOpenAgentConvs: only refreshes visible, previously-loaded panels', async () => {
  apiCalls = 0;
  apiResponse = { messages: [makeMsg('2024-01-15T09:30:00.000Z')] };

  const openConv = makeConvEl('agent-open');
  const closedConv = makeConvEl('agent-closed');
  closedConv.style.display = 'none';
  fakeConvNodes.length = 0;
  fakeConvNodes.push(openConv, closedConv);

  await Sessions.refreshOpenAgentConvs();
  assert.strictEqual(apiCalls, 1, 'closed panel should be skipped');
  assert.strictEqual(openConv.dataset.loaded, '1');
});

// --- task-notification rendering ---

const NOTIF = '<task-notification>\n<task-id>a1d22731</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:\tmp\a1.output</output-file>\n<status>completed</status>\n<summary>Agent "Check hook answers" finished</summary>\n<note>May notify more than once.</note>\n<result>Report delivered.</result>\n<usage><subagent_tokens>58776</subagent_tokens><tool_uses>6</tool_uses><duration_ms>58461</duration_ms></usage>\n</task-notification>';

function textMsg(text) {
  return { timestamp: null, role: 'user', content: [{ type: 'text', text }], model: null };
}

test('task-notification only: rendered as card, no raw XML', () => {
  const html = Sessions.renderMessage(textMsg(NOTIF));
  assert.ok(html.includes('class="chat-task-notif"'));
  assert.ok(!html.includes('<task-notification>'));
  assert.ok(html.includes('Agent &quot;Check hook answers&quot; finished'));
  assert.ok(html.includes('task-notif-status ok'));
  assert.ok(html.includes('Report delivered.'));
  assert.ok(html.includes('58,776 tokens · 6 tool uses · 58s'));
  assert.ok(html.includes('a1d22731'));
  assert.ok(html.includes('C:\tmp\a1.output'));
});

test('task-notification followed by user text: both rendered in order', () => {
  const html = Sessions.renderMessage(textMsg(NOTIF + '\n\nRead what user asking'));
  const cardAt = html.indexOf('chat-task-notif');
  const textAt = html.indexOf('Read what user asking');
  assert.ok(cardAt >= 0 && textAt > cardAt);
  assert.ok(html.includes('<div class="chat-text">\nRead what user asking</div>'));
});

test('task-notification without usage: no usage line', () => {
  const html = Sessions.renderMessage(textMsg('<task-notification><task-id>x</task-id><status>completed</status><summary>done</summary></task-notification>'));
  assert.ok(html.includes('chat-task-notif'));
  assert.ok(!html.includes('task-notif-usage'));
});

test('task-notification failed status gets error class', () => {
  const html = Sessions.renderMessage(textMsg('<task-notification><status>failed</status><summary>boom</summary></task-notification>'));
  assert.ok(html.includes('task-notif-status err'));
});

test('text without task-notification renders unchanged', () => {
  const html = Sessions.renderMessage(textMsg('plain hello'));
  assert.ok(html.includes('<div class="chat-text">plain hello</div>'));
  assert.ok(!html.includes('chat-task-notif'));
});

test('task-notification: pre-escaped entities are decoded once, then escaped', () => {
  const html = Sessions.renderMessage(textMsg('<task-notification><status>completed</status><summary>Agent &quot;X&quot; &lt;img src=x onerror=1&gt;</summary><task-id>&lt;b&gt;</task-id></task-notification>'));
  assert.ok(html.includes('Agent &quot;X&quot; &lt;img src=x onerror=1&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(!html.includes('&amp;quot;'));
});

test('task-notification: raw HTML in summary/status/details is escaped', () => {
  const html = Sessions.renderMessage(textMsg('<task-notification><status><b>x</b></status><summary><img src=x></summary><note><script>1</script></note></task-notification>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>x</b>'));
});

test('task-notification tags quoted inline by the user are not turned into a card', () => {
  const text = 'please render <task-notification>...</task-notification> as a card';
  const html = Sessions.renderMessage(textMsg(text));
  assert.ok(!html.includes('chat-task-notif'));
  assert.ok(html.includes(`<div class="chat-text">${text}</div>`));
});

test('task-notification whose result mentions the closing tag mid-line keeps the full result', () => {
  const text = '<task-notification>\n<status>completed</status>\n<result>It now parses </task-notification> inside text. Done.</result>\n<usage><subagent_tokens>10</subagent_tokens></usage>\n</task-notification>\nafter';
  const segs = Sessions._splitTaskNotifications(text);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].fields.result, 'It now parses </task-notification> inside text. Done.');
  assert.strictEqual(segs[0].fields.tokens, '10');
  assert.strictEqual(segs[1].text, 'after');
});

test('consecutive task-notifications each become a card', () => {
  const segs = Sessions._splitTaskNotifications(NOTIF + '\n' + NOTIF + '\nhello');
  assert.strictEqual(segs.map(s => s.type).join(','), 'notification,notification,text');
});

test('detail search (tool details hidden) covers task-notification cards without double-counting their result', () => {
  assert.strictEqual(Sessions._SEARCHABLE_TEXT, '.chat-text:not(.chat-task-notif .chat-text), .chat-task-notif');
});

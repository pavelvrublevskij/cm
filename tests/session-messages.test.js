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
  escapeHtml: s => String(s),
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

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Minimal Sessions stub — session-messages.js calls Object.assign(Sessions, {...})
const Sessions = { detailState: { slug: null } };

const src = fs.readFileSync(path.join(__dirname, '../public/js/session-messages.js'), 'utf-8');
const context = vm.createContext({
  Sessions,
  escapeHtml: s => String(s),
  renderMarkdown: s => String(s),
  renderChatMarkdown: s => String(s),
  shortModel: s => String(s),
  debounce: fn => fn,
  document: { getElementById: () => null },
  clearTimeout: () => {},
  setTimeout: () => {},
});
vm.runInContext(src, context);

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

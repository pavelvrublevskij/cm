const { test, afterEach } = require('node:test');
const assert = require('node:assert');
require('./helpers/app');
const terminalServer = require('../lib/terminal-server');
const activeSessions = require('../lib/active-sessions');
const { listAllActiveSessions } = require('../lib/session-status');

// A Task Board ticket's session runs as a hidden background pty: it stays out of every
// active-session list until someone opens it from the board.

const SLUG = 'C--work-hidden-proj';
const SID = '99999999-8888-7777-6666-555555555555';

/** A hidden background entry still waiting for its session id, as spawnBackground leaves it. */
function hiddenEntry() {
  const entry = terminalServer._injectFakeEntry(SLUG, 'pending-placeholder', { hidden: true });
  entry.sessionId = '';
  return entry;
}

const listed = () => listAllActiveSessions().some(s => s.sessionId === SID);

afterEach(() => {
  terminalServer._clearAll();
  activeSessions.unregister(SLUG, SID);
});

test('a hidden session is not listed as active, nor registered when its id is bound', () => {
  terminalServer.bindSessionId(hiddenEntry(), SID);
  assert.strictEqual(terminalServer.hasActiveTerminal(SLUG, SID), false);
  assert.ok(!terminalServer.getActiveTerminals().some(t => t.sessionId === SID));
  assert.strictEqual(listed(), false);
});

test('reveal lists it like any running session', () => {
  terminalServer.bindSessionId(hiddenEntry(), SID);
  assert.strictEqual(terminalServer.reveal(SLUG, SID), true);
  assert.strictEqual(terminalServer.hasActiveTerminal(SLUG, SID), true);
  assert.ok(terminalServer.getActiveTerminals().some(t => t.sessionId === SID));
  assert.strictEqual(listed(), true);
  assert.strictEqual(terminalServer.reveal(SLUG, SID), false, 'already visible');
});

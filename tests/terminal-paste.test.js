const { test } = require('node:test');
const assert = require('node:assert');
const { bracketedPaste } = require('../lib/terminal-paste');

test('bracketedPaste wraps the text and turns CRLF into LF', () => {
  assert.strictEqual(bracketedPaste('a\r\nb\nc'), '\x1b[200~a\nb\nc\x1b[201~');
});

test('bracketedPaste removes ESC so the text cannot end the paste or send control sequences', () => {
  assert.strictEqual(bracketedPaste('hi\x1b[201~\rrm -rf /\x1b[200~'), '\x1b[200~hi[201~\rrm -rf /[200~\x1b[201~');
  assert.strictEqual(bracketedPaste('\x1b[2J\x1b]0;x\x07ok'), '\x1b[200~[2J]0;x\x07ok\x1b[201~');
});

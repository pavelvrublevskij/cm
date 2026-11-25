/**
 * Wrap text in a bracketed paste for a pty. ESC characters are removed so the text cannot
 * end the paste early (ESC[201~) and have the rest taken as typed keys or control sequences.
 */
function bracketedPaste(text) {
  return '\x1b[200~' + text.replace(/\r\n/g, '\n').replace(/\x1b/g, '') + '\x1b[201~';
}

module.exports = { bracketedPaste };

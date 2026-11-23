// Claude Code PreToolUse hook for AskUserQuestion in sessions CM runs (wired in data/session-hooks.json
// and data/board-hooks.json). It hands the question to CM and waits: an answer given in CM's
// conversation view comes back as the tool's answers; anything else (released to the terminal, no
// answer within the hold, CM down) exits silently and claude shows its own menu.
const http = require('http');
const { QUESTION_HOLD_MS } = require('../lib/question-hook');

const url = process.env.CM_SESSION_URL || process.env.CM_BOARD_URL;
const token = process.env.CM_SESSION_TOKEN || process.env.CM_BOARD_TOKEN;

/** The hook's stdout for answers given in CM: allow the tool with the answers added to its input. */
function answerOutput(toolInput, answers) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: Object.assign({}, toolInput, { answers })
    }
  });
}

function hold(event) {
  const body = JSON.stringify({
    token,
    toolUseId: event.tool_use_id || '',
    questions: (event.tool_input && event.tool_input.questions) || []
  });
  const req = http.request(url + '/api/terminal/question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: QUESTION_HOLD_MS
  }, res => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', c => { data += c; });
    res.on('end', () => {
      let reply = {};
      try { reply = JSON.parse(data); } catch (_) { /* no answer */ }
      // Exit only once stdout is flushed: a pipe is written asynchronously on Linux and macOS.
      if (res.statusCode === 200 && reply.answers) process.stdout.write(answerOutput(event.tool_input, reply.answers), () => process.exit(0));
      else process.exit(0);
    });
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

function main() {
  if (!url || !token) process.exit(0);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    let event = {};
    try { event = JSON.parse(input); } catch (_) { process.exit(0); }
    if (event.tool_name !== 'AskUserQuestion' || !event.tool_use_id) process.exit(0);
    hold(event);
  });
}

if (require.main === module) main();

module.exports = { answerOutput };

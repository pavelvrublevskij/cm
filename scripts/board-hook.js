// Claude Code hook for Task Board sessions (wired in data/board-hooks.json, passed with --settings).
// Reads the hook event from stdin and reports it to CM. The ticket, token and CM address come from
// the environment CM started claude with, so in any other session this does nothing. Never fails
// the hook: claude must not stall because CM is down.
const http = require('http');

const { CM_BOARD_URL, CM_BOARD_CARD, CM_BOARD_TOKEN } = process.env;

function post(payload) {
  const body = JSON.stringify(payload);
  const req = http.request(CM_BOARD_URL + '/api/task-board/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 3000
  }, res => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

if (!CM_BOARD_URL || !CM_BOARD_CARD || !CM_BOARD_TOKEN) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch (_) { /* report the bare event name below */ }
  post({
    card: CM_BOARD_CARD,
    token: CM_BOARD_TOKEN,
    event: event.hook_event_name || '',
    sessionId: event.session_id || '',
    transcriptPath: event.transcript_path || '',
    message: event.message || '',
    lastAssistantMessage: event.last_assistant_message || ''
  });
});

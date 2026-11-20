// Claude Code hook for sessions run in CM's browser terminal (wired in data/session-hooks.json, passed
// with --settings). Reads the hook event from stdin and reports it to CM, which counts the sessions
// waiting for the user. The token and CM address come from the environment CM started claude with,
// so in any other session this does nothing. Never fails the hook: claude must not stall because CM is down.
const http = require('http');

const { CM_SESSION_URL, CM_SESSION_TOKEN } = process.env;

function post(payload) {
  const body = JSON.stringify(payload);
  const req = http.request(CM_SESSION_URL + '/api/terminal/hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 3000
  }, res => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

if (!CM_SESSION_URL || !CM_SESSION_TOKEN) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(input); } catch (_) { /* report the bare event name below */ }
  post({
    token: CM_SESSION_TOKEN,
    event: event.hook_event_name || '',
    notificationType: event.notification_type || '',
    toolUseId: event.tool_use_id || '',
    toolName: event.tool_name || '',
    agentId: event.agent_id || ''
  });
});

const os = require('os');
const { spawn } = require('child_process');
const { sessionFreeEnv } = require('./usage-insights');

const RUN_TIMEOUT_MS = 3 * 60 * 1000;
// "name: <command or url> - <status>", status starting with ✔ (ok), ! / ⚠ (needs attention) or ✘ (failed).
const LINE_RE = /^(.+?): .* - ([✔✓✘✗!⚠].*)$/;

/** Anything token-like in a status message is masked before it reaches the page. */
function maskSecrets(text) {
  return String(text).replace(/[A-Za-z0-9_\-]{32,}/g, '…');
}

/**
 * Server name and status from `claude mcp list` output. Only those two parts are kept — the
 * middle (command, args, URL) can carry tokens and is dropped.
 */
function parseMcpList(output) {
  const servers = [];
  for (const raw of String(output).split(/\r?\n/)) {
    const m = raw.trim().match(LINE_RE);
    if (!m) continue;
    const status = maskSecrets(m[2].trim());
    const level = /^[✔✓]/.test(status) ? 'ok' : /^[✘✗]/.test(status) ? 'error' : 'warn';
    servers.push({ name: m[1].trim(), status: status.replace(/^[✔✓✘✗!⚠]\s*/, ''), level });
  }
  return servers;
}

/** Live servers as health findings: failed ones are errors, ones that need attention are warnings. */
function liveFindings(servers) {
  return servers.filter(s => s.level !== 'ok').map(s => ({
    severity: s.level === 'error' ? 'error' : 'warn',
    area: 'mcp',
    title: s.level === 'error' ? `MCP server "${s.name}" failed to connect` : `MCP server "${s.name}" needs attention`,
    detail: s.status,
    scope: s.name.startsWith('claude.ai ') ? 'claude.ai' : 'Global',
    live: true
  }));
}

/**
 * Runs the user's own `claude mcp list` from the home folder: Claude Code connects to every user,
 * claude.ai and home-folder server and reports its status. No model is called. It does start the
 * servers, exactly as starting a Claude session would.
 */
function runMcpList() {
  const { cmd, args } = process.platform === 'win32'
    ? { cmd: 'cmd.exe', args: ['/c', 'claude', 'mcp', 'list'] }
    : { cmd: '/bin/sh', args: ['-c', 'claude mcp list'] };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: os.homedir(), env: sessionFreeEnv(process.env), windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude mcp list did not finish within ' + (RUN_TIMEOUT_MS / 60000) + ' minutes'));
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out + '\n' + err);
      else reject(new Error(maskSecrets((err || out).trim()) || 'claude mcp list exited with code ' + code));
    });
  });
}

/** Live status of every server claude knows about from the home folder, plus findings for the bad ones. */
async function liveMcpCheck() {
  const servers = parseMcpList(await module.exports.runMcpList());
  return { checkedAt: new Date().toISOString(), servers, findings: liveFindings(servers) };
}

module.exports = { parseMcpList, liveFindings, runMcpList, liveMcpCheck, maskSecrets };

const fs = require('fs');
const { spawn } = require('child_process');

const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];

function safeSpawn(cmd, args, opts) {
  const proc = spawn(cmd, args, opts);
  // Without an 'error' listener, an async spawn failure crashes Node.
  proc.on('error', () => { /* swallowed; caller decides what to do */ });
  return proc;
}

/**
 * [command, args, options] that open an OS terminal in projectPath running cmd. The folder never
 * goes into a command line (cwd or environment instead), so its characters can't run as commands.
 * `term` picks the Linux terminal. On Windows this is the fallback when Windows Terminal is missing.
 */
function terminalSpawnArgs(platform, projectPath, cmd, term) {
  if (platform === 'win32') {
    return ['cmd.exe', ['/c', 'start', 'cmd.exe', '/k', cmd],
      { cwd: projectPath, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }];
  }
  if (platform === 'darwin') {
    // Read outside the tell block: inside it, system attribute would run in Terminal's environment.
    return ['osascript', [
      '-e', 'set d to system attribute "CM_DIR"',
      '-e', 'set c to system attribute "CM_CMD"',
      '-e', 'tell application "Terminal" to do script ("cd " & quoted form of d & " && " & c)'
    ], { env: { ...process.env, CM_DIR: projectPath, CM_CMD: cmd } }];
  }
  const args = term === 'gnome-terminal'
    ? ['--', 'bash', '-c', `${cmd}; exec bash`]
    : ['-e', `bash -c "${cmd}; exec bash"`];
  return [term, args, { cwd: projectPath }];
}

function launchTerminal(projectPath, cmd) {
  if (process.env.__CLAUDE_MANAGER_TEST_HOME) return;
  // A missing cwd makes the spawn fail silently, so say so instead of reporting success.
  if (!fs.existsSync(projectPath)) throw new Error('Project folder not found: ' + projectPath);
  const platform = process.platform;
  if (platform === 'win32') {
    const wtArgs = ['-d', projectPath, 'cmd.exe', '/k', cmd];
    const proc = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore' });
    proc.on('error', () => {
      safeSpawn(...terminalSpawnArgs(platform, projectPath, cmd)).unref();
    });
    proc.unref();
  } else if (platform === 'darwin') {
    safeSpawn(...terminalSpawnArgs(platform, projectPath, cmd)).unref();
  } else {
    for (const term of LINUX_TERMINALS) {
      try {
        safeSpawn(...terminalSpawnArgs(platform, projectPath, cmd, term)).unref();
        return;
      } catch (_) { continue; }
    }
    throw new Error('No supported terminal found');
  }
}

module.exports = { launchTerminal, terminalSpawnArgs };

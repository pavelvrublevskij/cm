const { spawn } = require('child_process');

function safeSpawn(cmd, args, opts) {
  const proc = spawn(cmd, args, opts);
  // Without an 'error' listener, an async spawn failure crashes Node.
  proc.on('error', () => { /* swallowed; caller decides what to do */ });
  return proc;
}

/** Open a new OS terminal window in `projectPath` running `cmd`, platform by platform. */
function launchTerminal(projectPath, cmd) {
  if (process.env.__CLAUDE_MANAGER_TEST_HOME) return;
  const platform = process.platform;
  if (platform === 'win32') {
    const wtArgs = ['-d', projectPath, 'cmd.exe', '/k', cmd];
    const proc = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore' });
    proc.on('error', () => {
      safeSpawn('cmd.exe', ['/c', `start "" cmd.exe /k "cd /d ${projectPath} && ${cmd}"`], { shell: true, detached: true, stdio: 'ignore' }).unref();
    });
    proc.unref();
  } else if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd '${projectPath}' && ${cmd}"`;
    const proc = safeSpawn('osascript', ['-e', script]);
    proc.unref();
  } else {
    const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    for (const term of terminals) {
      try {
        const args = term === 'gnome-terminal'
          ? ['--', 'bash', '-c', `cd '${projectPath}' && ${cmd}; exec bash`]
          : ['-e', `bash -c "cd '${projectPath}' && ${cmd}; exec bash"`];
        const proc = safeSpawn(term, args);
        proc.unref();
        return;
      } catch (_) { continue; }
    }
    throw new Error('No supported terminal found');
  }
}

module.exports = { safeSpawn, launchTerminal };

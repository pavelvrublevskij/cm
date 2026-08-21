// Standalone check used by run.sh / run.bat: exits 0 if node-pty can actually spawn a
// process on this machine, 1 otherwise (e.g. arch mismatch or a corrupted native build).
try {
  const pty = require('../node_modules/node-pty');
  const cmd = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
  const term = pty.spawn(cmd, [], { name: 'xterm-256color', cols: 80, rows: 24 });
  term.kill();
  process.exit(0);
} catch (_) {
  process.exit(1);
}

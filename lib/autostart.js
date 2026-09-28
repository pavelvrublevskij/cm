const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_DIR, 'server.js');

function isSupported() {
  return ['win32', 'darwin', 'linux'].includes(process.platform);
}

function startupShortcutPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows',
    'Start Menu', 'Programs', 'Startup', 'Claude Manager.lnk');
}

function launchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claude-manager.autostart.plist');
}

function autostartDesktopPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'claude-manager.desktop');
}

function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Embed a value as a single-quoted PowerShell string literal (escapes embedded quotes by doubling). */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function isEnabled() {
  const platform = process.platform;
  if (platform === 'win32') return fs.existsSync(startupShortcutPath());
  if (platform === 'darwin') return fs.existsSync(launchAgentPath());
  if (platform === 'linux') return fs.existsSync(autostartDesktopPath());
  return false;
}

function enable() {
  const platform = process.platform;
  if (platform === 'win32') {
    // A shortcut in the Startup folder — the standard, inspectable autostart mechanism most
    // Windows apps use (visible in Task Manager's Startup tab / Settings > Login Items). A
    // registry Run key driving a hidden wscript/.vbs launcher was tried first and got silently
    // quarantined by endpoint security, since that combination is a textbook persistence IOC.
    //
    // The shortcut targets a hidden PowerShell one-liner rather than node.exe directly: pointing
    // it straight at node.exe gives node its own console window, and closing that window (even
    // minimized, it's still a real, closable window) kills the process it's attached to. The
    // PowerShell wrapper backgrounds node via Start-Process -WindowStyle Hidden and then exits
    // immediately, leaving node running fully detached with no window to close.
    const lnkPath = startupShortcutPath();
    fs.mkdirSync(path.dirname(lnkPath), { recursive: true });

    const startNode = `Start-Process -FilePath ${psQuote(process.execPath)} `
      + `-ArgumentList @(${psQuote(SERVER_ENTRY)},${psQuote('--autostart-open')}) `
      + `-WorkingDirectory ${psQuote(PROJECT_DIR)} -WindowStyle Hidden`;
    const shortcutArgs = `-NoProfile -WindowStyle Hidden -Command "${startNode}"`;

    const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnkPath)});`
      + `$s.TargetPath = ${psQuote(powershellPath())};`
      + `$s.Arguments = ${psQuote(shortcutArgs)};`
      + `$s.WorkingDirectory = ${psQuote(PROJECT_DIR)};`
      + '$s.WindowStyle = 7;'
      + '$s.Save()';
    cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    return;
  }
  if (platform === 'darwin') {
    const plistPath = launchAgentPath();
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + '<plist version="1.0">\n<dict>\n'
      + '  <key>Label</key><string>com.claude-manager.autostart</string>\n'
      + '  <key>ProgramArguments</key>\n  <array>\n'
      + `    <string>${process.execPath}</string>\n`
      + `    <string>${SERVER_ENTRY}</string>\n`
      + '  </array>\n'
      + `  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>\n`
      + '  <key>EnvironmentVariables</key>\n  <dict><key>CM_AUTOSTART_OPEN</key><string>1</string></dict>\n'
      + '  <key>RunAtLoad</key><true/>\n'
      + '</dict>\n</plist>\n';
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    return;
  }
  if (platform === 'linux') {
    const desktopPath = autostartDesktopPath();
    const desktop = '[Desktop Entry]\n'
      + 'Type=Application\n'
      + 'Name=Claude Manager\n'
      + `Exec=env CM_AUTOSTART_OPEN=1 "${process.execPath}" "${SERVER_ENTRY}"\n`
      + `Path=${PROJECT_DIR}\n`
      + 'X-GNOME-Autostart-enabled=true\n'
      + 'NoDisplay=true\n';
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(desktopPath, desktop);
    return;
  }
  throw new Error('Autostart is not supported on this platform');
}

function disable() {
  const platform = process.platform;
  if (platform === 'win32') {
    try { fs.unlinkSync(startupShortcutPath()); } catch (_) {}
    return;
  }
  if (platform === 'darwin') {
    try { fs.unlinkSync(launchAgentPath()); } catch (_) {}
    return;
  }
  if (platform === 'linux') {
    try { fs.unlinkSync(autostartDesktopPath()); } catch (_) {}
    return;
  }
}

module.exports = { isSupported, isEnabled, enable, disable };

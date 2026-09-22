const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Registry Run key value name (Windows) — also used as the LaunchAgent/desktop entry label root.
const APP_NAME = 'ClaudeManager';
const PROJECT_DIR = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_DIR, 'server.js');

function isSupported() {
  return ['win32', 'darwin', 'linux'].includes(process.platform);
}

function launchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claude-manager.autostart.plist');
}

function autostartDesktopPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'claude-manager.desktop');
}

function winLauncherPath() {
  return path.join(PROJECT_DIR, 'scripts', 'autostart-launcher.vbs');
}

function isEnabled() {
  const platform = process.platform;
  if (platform === 'win32') {
    try {
      cp.execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', APP_NAME
      ], { stdio: 'ignore' });
      return true;
    } catch (_) {
      return false;
    }
  }
  if (platform === 'darwin') return fs.existsSync(launchAgentPath());
  if (platform === 'linux') return fs.existsSync(autostartDesktopPath());
  return false;
}

/**
 * Hides the console window node.exe would otherwise pop on every login — wscript running this
 * .vbs is the standard way to launch a hidden process from a Windows Run key without a build step.
 */
function winLauncherScript() {
  return 'Set WshShell = CreateObject("WScript.Shell")\r\n'
    + `WshShell.CurrentDirectory = "${PROJECT_DIR}"\r\n`
    + 'WshShell.Environment("PROCESS")("CM_AUTOSTART_OPEN") = "1"\r\n'
    + `WshShell.Run """${process.execPath}"" ""${SERVER_ENTRY}""", 0, False\r\n`;
}

function enable() {
  const platform = process.platform;
  if (platform === 'win32') {
    const vbsPath = winLauncherPath();
    fs.mkdirSync(path.dirname(vbsPath), { recursive: true });
    fs.writeFileSync(vbsPath, winLauncherScript());
    cp.execFileSync('reg', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', APP_NAME,
      '/t', 'REG_SZ', '/d', `wscript.exe "${vbsPath}"`, '/f'
    ], { stdio: 'ignore' });
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
    try {
      cp.execFileSync('reg', [
        'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', APP_NAME, '/f'
      ], { stdio: 'ignore' });
    } catch (_) {}
    try { fs.unlinkSync(winLauncherPath()); } catch (_) {}
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

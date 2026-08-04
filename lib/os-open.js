const path = require('path');
const { execFile, spawn } = require('child_process');

/** Open a file or folder with the OS default association (Explorer/Finder/xdg-open). */
function openPath(targetPath) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    execFile('open', [targetPath]);
  } else {
    execFile('xdg-open', [targetPath]);
  }
}

/** Reveal a file in the OS file explorer, selecting it (Linux falls back to opening the containing folder). */
function revealInFileManager(targetPath) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('explorer.exe', ['/select,' + targetPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    execFile('open', ['-R', targetPath]);
  } else {
    execFile('xdg-open', [path.dirname(targetPath)]);
  }
}

module.exports = { openPath, revealInFileManager };

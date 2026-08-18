const { execFile } = require('child_process');

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trimEnd());
    });
  });
}

function parseStatus(porcelain) {
  return porcelain.split(/\r?\n/).filter(Boolean).map(line => {
    if (line.length < 4) return null;
    const xy = line.slice(0, 2);
    let file = line.slice(3);

    // git quotes paths with special chars/spaces — strip quotes and unescape
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
    }

    // For renames take destination path after " -> "
    const arrowIdx = file.indexOf(' -> ');
    if (arrowIdx !== -1) file = file.slice(arrowIdx + 4);

    let label;
    if (xy === '??') label = 'untracked';
    else if (xy[0] === 'D' || xy[1] === 'D') label = 'deleted';
    else if (xy[0] === 'A') label = 'new';
    else label = 'modified';
    return { path: file, xy, label };
  }).filter(Boolean);
}

module.exports = { git, parseStatus };

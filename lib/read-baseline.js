const path = require('path');
const { extractBashWrites } = require('./bash-writes');

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * For files changed by shell commands (no file-history snapshot), recover the "before" text from
 * the session's own Read results: the last complete Read of the file preceding the first shell
 * command that writes to it. Partially-read files are skipped. Returns Map<relPath, text>.
 */
function readBaselines(sessionContent, projectDir) {
  const root = path.resolve(projectDir);
  const reads = new Map();
  const baselines = new Map();
  const frozen = new Set();

  for (const line of sessionContent.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }

    const f = obj.toolUseResult && obj.toolUseResult.file;
    if (f && f.filePath && typeof f.content === 'string') {
      const key = norm(path.resolve(f.filePath));
      if (!frozen.has(key) && f.startLine === 1 && f.numLines === f.totalLines && !obj.toolUseResult.truncatedByTokenCap) {
        reads.set(key, f.content);
      }
      continue;
    }

    const content = obj.type === 'assistant' && obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.input || (block.name !== 'Bash' && block.name !== 'PowerShell')) continue;
      for (const { cwd, target } of extractBashWrites(block.input.command)) {
        const candidates = [path.resolve(root, cwd, target), path.resolve(root, target)];
        const hit = candidates.find(abs => reads.has(norm(abs)));
        const abs = hit || candidates[0];
        const key = norm(abs);
        if (frozen.has(key)) continue;
        frozen.add(key);
        if (!hit) continue;
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..')) baselines.set(rel, reads.get(key));
      }
    }
  }
  return baselines;
}

module.exports = { readBaselines };

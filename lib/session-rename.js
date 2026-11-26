const fs = require('fs');
const path = require('path');
const { safeSlug, backup } = require('./file-helpers');

/**
 * Give a session a custom title the way Claude Code does: a `custom-title` line appended to its
 * JSONL, mirrored into sessions-index.json when there is one. Returns { title } or { status, error }.
 */
function renameSession(slug, sessionId, rawTitle) {
  const dir = safeSlug(slug);
  if (!dir) return { status: 400, error: 'Invalid slug' };
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return { status: 400, error: 'Invalid session ID' };
  }

  const title = (rawTitle || '').trim();
  if (!title) return { status: 400, error: 'Title is required' };
  if (title.length > 500) return { status: 400, error: 'Title too long' };

  const filePath = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return { status: 404, error: 'Session not found' };

  backup(filePath);
  const line = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n';
  const existing = fs.readFileSync(filePath, 'utf-8');
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  fs.appendFileSync(filePath, (needsNewline ? '\n' : '') + line);

  const indexFile = path.join(dir, 'sessions-index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      const entry = (data.entries || []).find(e => e.sessionId === sessionId);
      if (entry) {
        backup(indexFile);
        entry.summary = title;
        fs.writeFileSync(indexFile, JSON.stringify(data, null, 2), 'utf-8');
      }
    } catch (_) { /* malformed index, skip */ }
  }

  return { title };
}

module.exports = { renameSession };

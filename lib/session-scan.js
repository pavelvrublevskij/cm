const fs = require('fs');

// One pass over a session JSONL collecting the list/dashboard metadata, cached by mtime+size so an
// unchanged file is never re-read. Replaces separate full reads for title, branches, bridge flag,
// first prompt and plan detection.
const cache = new Map();

const BRIDGE_MARKER = '"type":"bridge-session"';
const SKIP_HINTS = ['Caveat: The messages below were generated', '/clear'];

function scanText(text) {
  const meta = {
    customTitle: '',
    summaryTitle: '',
    remoteControlled: text.includes(BRIDGE_MARKER),
    userCount: 0,
    firstUserTimestamp: null,
    firstUserBranch: '',
    lastUserTimestamp: null,
    lastUserBranch: '',
    gitBranches: [],
    prompts: []
  };
  const seen = new Set();
  let promptsDone = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const isUser = line.includes('"type":"user"');
    if (!isUser && !line.includes('"type":"custom-title"') && !line.includes('"type":"summary"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (entry.type === 'custom-title' && entry.customTitle) {
      meta.customTitle = entry.customTitle;
    } else if (entry.type === 'summary' && entry.summary) {
      meta.summaryTitle = entry.summary;
    } else if (entry.type === 'user') {
      meta.userCount++;
      if (meta.userCount === 1) {
        meta.firstUserTimestamp = entry.timestamp || null;
        meta.firstUserBranch = entry.gitBranch || '';
      }
      meta.lastUserTimestamp = entry.timestamp || null;
      const b = entry.gitBranch;
      if (b) meta.lastUserBranch = b;
      if (b && !seen.has(b)) { seen.add(b); meta.gitBranches.push(b); }
      if (!promptsDone) {
        const raw = typeof entry.message?.content === 'string' ? entry.message.content : '';
        if (raw) {
          meta.prompts.push(raw);
          if (!SKIP_HINTS.some(h => raw.includes(h))) promptsDone = true;
        }
      }
    }
  }
  return meta;
}

/** Cached metadata for a session file, or null when it can't be read. `planStems` adds `hasPlan`. */
function scanSession(filePath, planStems) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return null; }
  const stemsKey = planStems ? planStems.join('\n') : null;
  let entry = cache.get(filePath);
  const fresh = entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
  let text = null;
  if (!fresh) {
    try { text = fs.readFileSync(filePath, 'utf-8'); } catch (_) { return null; }
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, stat, meta: scanText(text), plan: new Map() };
    cache.set(filePath, entry);
  }
  if (stemsKey !== null && !entry.plan.has(stemsKey)) {
    if (text === null) {
      try { text = fs.readFileSync(filePath, 'utf-8'); } catch (_) { text = ''; }
    }
    entry.plan.clear();
    entry.plan.set(stemsKey, planStems.some(stem => text.includes(stem)));
  }
  const meta = { ...entry.meta, gitBranches: [...entry.meta.gitBranches], stat: entry.stat };
  if (stemsKey !== null) meta.hasPlan = entry.plan.get(stemsKey);
  return meta;
}

/** First prompt that isn't skippable per the caller's rules, or ''. */
function firstMeaningfulPrompt(meta, isSkippable, normalize) {
  const raw = (meta?.prompts || []).find(p => !isSkippable(p));
  return raw ? normalize(raw).slice(0, 200) : '';
}

module.exports = { scanSession, firstMeaningfulPrompt, _clear() { cache.clear(); } };

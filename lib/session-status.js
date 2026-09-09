const terminalServer = require('./terminal-server');
const activeSessions = require('./active-sessions');

// A session can be a real process (browser wins over os) AND separately have read-only viewers —
// those two facts are independent, so both can show up on a card at once (as two dots), unlike
// browser/os which represent the same underlying process and are mutually exclusive.
function getActiveKinds(slug, sessionId, modifiedIso) {
  const kinds = [];
  if (terminalServer.hasActiveTerminal(slug, sessionId)) kinds.push('browser');
  else if (activeSessions.isActive(slug, sessionId, modifiedIso)) kinds.push('os');
  if (activeSessions.hasReadonly(slug, sessionId)) kinds.push('readonly');
  return kinds;
}

function getActiveKind(slug, sessionId, modifiedIso) {
  return getActiveKinds(slug, sessionId, modifiedIso)[0] || null;
}

function stampActive(slug, sessions) {
  if (slug) {
    activeSessions.resolvePendingNew(slug, sessions);
  } else {
    const bySlug = new Map();
    for (const s of sessions) {
      const k = s.slug;
      if (!k) continue;
      if (!bySlug.has(k)) bySlug.set(k, []);
      bySlug.get(k).push(s);
    }
    for (const [s, list] of bySlug) activeSessions.resolvePendingNew(s, list);
  }
  for (const s of sessions) {
    const kinds = getActiveKinds(s.slug || slug, s.sessionId, s.modified);
    s.active = kinds.length > 0;
    s.activeKind = kinds[0] || null;
    s.activeKinds = kinds;
  }
}

function listAllActiveSessions() {
  const seen = new Set();
  const result = [];
  for (const t of terminalServer.getActiveTerminals()) {
    if (!t.sessionId) continue;
    const key = `${t.slug}|${t.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ slug: t.slug, sessionId: t.sessionId, kind: 'browser' });
  }
  for (const e of activeSessions.listActive()) {
    const key = `${e.slug}|${e.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ slug: e.slug, sessionId: e.sessionId, kind: 'os' });
  }
  // Read-only viewer instances are additive, not deduped against os/browser — the same session can
  // be genuinely active (a real process) while also being viewed read-only in one or more tabs.
  for (const e of activeSessions.listReadonly()) {
    result.push({ slug: e.slug, sessionId: e.sessionId, kind: 'readonly', instanceId: e.instanceId });
  }
  return result;
}

module.exports = { getActiveKind, getActiveKinds, stampActive, listAllActiveSessions };

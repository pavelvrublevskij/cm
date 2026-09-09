const fs = require('fs');
const path = require('path');
const { safeSlug } = require('./file-helpers');

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const LAUNCH_GRACE_MS = 30 * 1000;

const registry = new Map();
const pendingNew = new Map();
const ignored = new Map();
const readonlyInstances = new Map();

const IGNORE_TTL_MS = 2 * 60 * 1000;

const keyOf = (slug, sessionId) => `${slug}|${sessionId}`;
const readonlyKeyOf = (slug, sessionId, instanceId) => `${slug}|${sessionId}|${instanceId}`;

function now() { return Date.now(); }

function register(slug, sessionId, via) {
  if (!slug || !sessionId) return;
  const k = keyOf(slug, sessionId);
  const ignoredAt = ignored.get(k);
  if (ignoredAt !== undefined) {
    if (now() - ignoredAt < IGNORE_TTL_MS) return;
    ignored.delete(k);
  }
  registry.set(k, { slug, sessionId, launchedAt: now(), via });
}

function registerPendingNew(slug) {
  if (!slug) return;
  const list = pendingNew.get(slug) || [];
  list.push({ launchedAt: now() });
  pendingNew.set(slug, list);
}

function resolvePendingNew(slug, sessions) {
  const pendings = pendingNew.get(slug);
  if (!pendings || !pendings.length) return;
  const remaining = [];
  for (const p of pendings) {
    const windowEnd = p.launchedAt + LAUNCH_GRACE_MS;
    let matched = false;
    for (const s of sessions) {
      if (!s.created) continue;
      const created = new Date(s.created).getTime();
      if (Number.isNaN(created)) continue;
      if (created >= p.launchedAt && created <= windowEnd) {
        register(slug, s.sessionId, 'os-terminal');
        matched = true;
        break;
      }
    }
    if (!matched && now() - p.launchedAt < LAUNCH_GRACE_MS) {
      remaining.push(p);
    }
  }
  if (remaining.length) pendingNew.set(slug, remaining);
  else pendingNew.delete(slug);
}

function unregister(slug, sessionId) {
  registry.delete(keyOf(slug, sessionId));
}

function deactivate(slug, sessionId) {
  if (!slug || !sessionId) return;
  registry.delete(keyOf(slug, sessionId));
  ignored.set(keyOf(slug, sessionId), now());
}

function isActive(slug, sessionId, modifiedIso) {
  const entry = registry.get(keyOf(slug, sessionId));
  if (!entry) return false;
  const nowMs = now();
  if (nowMs - entry.launchedAt < ACTIVE_THRESHOLD_MS) return true;
  if (!modifiedIso) {
    registry.delete(keyOf(slug, sessionId));
    return false;
  }
  const modified = new Date(modifiedIso).getTime();
  if (Number.isNaN(modified) || nowMs - modified >= ACTIVE_THRESHOLD_MS) {
    registry.delete(keyOf(slug, sessionId));
    return false;
  }
  return true;
}

function isActiveByFile(slug, sessionId) {
  const entry = registry.get(keyOf(slug, sessionId));
  if (!entry) return false;
  const nowMs = now();
  if (nowMs - entry.launchedAt < ACTIVE_THRESHOLD_MS) return true;
  const dir = safeSlug(slug);
  if (!dir) {
    registry.delete(keyOf(slug, sessionId));
    return false;
  }
  try {
    const stat = fs.statSync(path.join(dir, sessionId + '.jsonl'));
    if (nowMs - stat.mtimeMs < ACTIVE_THRESHOLD_MS) return true;
  } catch (_) { /* unreadable */ }
  registry.delete(keyOf(slug, sessionId));
  return false;
}

// Read-only viewer instances have no backing process, so unlike `registry` entries they are not
// keyed by slug|sessionId alone — the same session can be open read-only in several tabs at once,
// each tracked as its own instance and never expired by the activity heuristics above. They only
// go away when the viewer explicitly closes them (or the server restarts).
function registerReadonly(slug, sessionId, instanceId) {
  if (!slug || !sessionId || !instanceId) return;
  readonlyInstances.set(readonlyKeyOf(slug, sessionId, instanceId), { slug, sessionId, instanceId });
}

function deactivateReadonly(slug, sessionId, instanceId) {
  if (!slug || !sessionId || !instanceId) return;
  readonlyInstances.delete(readonlyKeyOf(slug, sessionId, instanceId));
}

function listReadonly() {
  return Array.from(readonlyInstances.values());
}

function hasReadonly(slug, sessionId) {
  for (const e of readonlyInstances.values()) {
    if (e.slug === slug && e.sessionId === sessionId) return true;
  }
  return false;
}

function listActive() {
  const nowMs = now();
  for (const [k, ignoredAt] of ignored) {
    if (nowMs - ignoredAt >= IGNORE_TTL_MS) ignored.delete(k);
  }
  const out = [];
  for (const entry of registry.values()) {
    if (isActiveByFile(entry.slug, entry.sessionId)) {
      out.push({ slug: entry.slug, sessionId: entry.sessionId, via: entry.via });
    }
  }
  return out;
}

function _reset() {
  registry.clear();
  pendingNew.clear();
  ignored.clear();
  readonlyInstances.clear();
}

function _backdate(slug, sessionId, launchedAt) {
  const entry = registry.get(keyOf(slug, sessionId));
  if (entry) entry.launchedAt = launchedAt;
}

function _backdateIgnored(slug, sessionId, ignoredAt) {
  ignored.set(keyOf(slug, sessionId), ignoredAt);
}

function _ignoredSize() { return ignored.size; }

module.exports = {
  register,
  registerPendingNew,
  resolvePendingNew,
  unregister,
  deactivate,
  isActive,
  isActiveByFile,
  listActive,
  registerReadonly,
  deactivateReadonly,
  listReadonly,
  hasReadonly,
  _reset,
  _backdate,
  _backdateIgnored,
  _ignoredSize,
  ACTIVE_THRESHOLD_MS,
  LAUNCH_GRACE_MS,
  IGNORE_TTL_MS
};

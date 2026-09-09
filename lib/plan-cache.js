// Only positive results are cached: a session having a plan never becomes
// untrue, but a session with no plan yet can gain one later (e.g. the
// current, still-active session), so "no plan" must never be cached.
const cache = new Map();

module.exports = {
  get(sessionId) { return cache.get(sessionId); },
  set(sessionId, hasPlan) { if (hasPlan) cache.set(sessionId, true); },
  _clear() { cache.clear(); }
};

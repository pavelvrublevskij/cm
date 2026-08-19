// --- GitApi ---
// The git endpoints in one place, so the footer button and the git panel read the same state the
// same way instead of each spelling out URLs and error fallbacks.
//
// info()/shellInfo() answer null when the request fails, leaving the caller to decide whether that
// means "not a repository" (first load) or "keep what we had" (a refresh).
// commit()/push() let errors through, because the caller shows them.

const GitApi = {
  base(slug) {
    return `/api/projects/${encodeURIComponent(slug)}`;
  },

  async info(slug) {
    try { return await api(`${GitApi.base(slug)}/git/info`); }
    catch (_) { return null; }
  },

  async shellInfo(slug) {
    try { return await api(`${GitApi.base(slug)}/terminal/info?mode=shell`); }
    catch (_) { return null; }
  },

  commit(slug, message, files) {
    return api(`${GitApi.base(slug)}/git/commit`, { method: 'POST', body: { message, files } });
  },

  push(slug) {
    return api(`${GitApi.base(slug)}/git/push`, { method: 'POST' });
  },
};

window.GitApi = GitApi;

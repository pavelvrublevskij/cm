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

  /**
   * Hunks for one file. With a sha, the commit against its parent; without, HEAD against the
   * working tree — what committing it would record.
   */
  diff(slug, filePath, sha) {
    const shaParam = sha ? `&sha=${encodeURIComponent(sha)}` : '';
    return api(`${GitApi.base(slug)}/git/diff?path=${encodeURIComponent(filePath)}${shaParam}`);
  },

  log(slug, limit, offset) {
    return api(`${GitApi.base(slug)}/git/log?limit=${limit}&offset=${offset}`);
  },

  commitDetail(slug, sha) {
    return api(`${GitApi.base(slug)}/git/commit/${encodeURIComponent(sha)}`);
  },

  commit(slug, message, files) {
    return api(`${GitApi.base(slug)}/git/commit`, { method: 'POST', body: { message, files } });
  },

  /** A commit message for the ticked files, written by the user's local claude CLI. */
  commitMessage(slug, files, model, effort) {
    return api(`${GitApi.base(slug)}/git/commit-message`, { method: 'POST', body: { files, model, effort } });
  },

  push(slug) {
    return api(`${GitApi.base(slug)}/git/push`, { method: 'POST' });
  },

  /** Fast-forward only: a pull that would need a merge fails and is left to the shell. */
  pull(slug) {
    return api(`${GitApi.base(slug)}/git/pull`, { method: 'POST' });
  },

  fetch(slug) {
    return api(`${GitApi.base(slug)}/git/fetch`, { method: 'POST' });
  },

  /** { local: [{ name, upstream, current }], remote: [{ name, localName }] } */
  branches(slug) {
    return api(`${GitApi.base(slug)}/git/branches`);
  },

  /** `remote` checks out a remote branch as a new tracking branch; `stash` stashes changes first. */
  checkout(slug, branch, remote, stash) {
    return api(`${GitApi.base(slug)}/git/checkout`, { method: 'POST', body: { branch, remote, stash } });
  },

  createBranch(slug, name) {
    return api(`${GitApi.base(slug)}/git/branch`, { method: 'POST', body: { name } });
  },

  stashes(slug) {
    return api(`${GitApi.base(slug)}/git/stashes`);
  },

  stash(slug, message, untracked) {
    return api(`${GitApi.base(slug)}/git/stash`, { method: 'POST', body: { message, untracked } });
  },

  /** op is 'apply' | 'pop' | 'drop'; ref is a stash@{n} the stash list reported. */
  stashOp(slug, op, ref) {
    return api(`${GitApi.base(slug)}/git/stash/${op}`, { method: 'POST', body: { ref } });
  },
};

window.GitApi = GitApi;

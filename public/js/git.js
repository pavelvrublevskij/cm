const GitActions = {
  _slug: null,
  _info: null,
  _shellRunning: false,

  async init(slug) {
    GitActions._slug = slug;
    GitActions._info = null;
    GitActions._shellRunning = false;
    GitActions._clearContainers();
    await GitActions._fetchInfo();
    GitActions._render();
  },

  async refresh() {
    if (!GitActions._slug) return;
    await GitActions._fetchInfo();
    GitActions._render();
  },

  async _fetchInfo() {
    GitActions._info = await GitApi.info(GitActions._slug) || { available: false };
    if (!GitActions._info.available) { GitActions._shellRunning = false; return; }
    await GitActions._fetchShellState();
  },

  async _fetchShellState() {
    const shell = await GitApi.shellInfo(GitActions._slug);
    GitActions._shellRunning = !!(shell && shell.running);
  },

  /** Re-check whether a shell is alive and repaint the footer dot. */
  async refreshShellState() {
    if (!GitActions._slug || !GitActions._info || !GitActions._info.available) return;
    await GitActions._fetchShellState();
    GitActions._render();
  },

  reset() {
    GitActions._slug = null;
    GitActions._info = null;
    GitActions._shellRunning = false;
    GitActions._clearContainers();
  },

  _clearContainers() {
    const footer = document.getElementById('footer-git');
    if (footer) { footer.innerHTML = ''; footer.style.display = 'none'; }
    GitActions._setTabVisible(false);
  },

  /** The Git tab only exists for projects that are git repositories. */
  _setTabVisible(on) {
    const btn = document.getElementById('git-tab-btn');
    if (btn) btn.style.display = on ? '' : 'none';
  },

  _syncHtml() {
    const info = GitActions._info || {};
    const parts = [];
    if (info.ahead) parts.push(`↑${info.ahead}`);
    if (info.behind) parts.push(`↓${info.behind}`);
    if (!parts.length) return '';
    const title = `${info.ahead || 0} ahead / ${info.behind || 0} behind ${escapeHtml(info.upstream || 'upstream')}`;
    return `<span class="git-sync-label" title="${title}">${parts.join(' ')}</span>`;
  },

  _buttonHtml(branch) {
    const info = GitActions._info;
    const count = (info.files || []).length;
    const countBadge = count > 0 ? `<span class="git-count-badge">${count}</span>` : '';
    const shellDot = GitActions._shellRunning
      ? '<span class="git-shell-dot" title="A shell is running for this project">&#9679;</span>'
      : '';
    const branchLabel = branch
      ? (info.detached
        ? `<span class="git-detached-label" title="Detached HEAD">detached @ ${escapeHtml(branch)}</span>`
        : `<span>${escapeHtml(branch)}</span>`)
      : '';
    const icon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:inline-block;vertical-align:middle"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/></svg>`;
    return `<button class="btn btn-sm git-icon-btn" title="Open git: changes, recipes and a shell"
        onclick="event.stopPropagation(); GitActions.openGitPanel()">${icon}${branchLabel}${shellDot}${GitActions._syncHtml()}${countBadge}</button>`;
  },

  _render() {
    if (!GitActions._info || !GitActions._info.available) return;
    GitActions._setTabVisible(true);
    const branch = GitActions._info.branch;
    const footer = document.getElementById('footer-git');
    if (footer) {
      footer.innerHTML = GitActions._buttonHtml(branch);
      footer.style.display = 'flex';
    }
  },

  /** Every git action lives in the panel, so the footer button opens it rather than duplicating
   *  commit and push in a dropdown. In the project view the Git tab is right there, so use it;
   *  anywhere else (a session) the same panel opens in a modal, leaving the session in place. */
  openGitPanel() {
    if (!GitActions._info || !GitActions._info.available) {
      toast('Git not available in this project', 'error');
      return;
    }

    const tabBtn = document.getElementById('git-tab-btn');
    if (typeof App !== 'undefined' && App.currentView === 'project-detail' && tabBtn) {
      ProjectTabs.switch('git', tabBtn);
      return;
    }

    openModal({
      title: 'Git',
      cls: 'git-panel-modal',
      cancelLabel: 'Close',
      resizable: { minWidth: 900, minHeight: 460 },
      body: '<div id="git-panel-modal-host"></div>',
      buttons: [
        { label: 'Open in new tab ↗', onClick: () => GitActions.openGitPanelInNewTab() }
      ],
      onClose: () => GitPanel.unmount()
    });
    GitPanel.mount('git-panel-modal-host', GitActions._slug);
  },

  /** Same panel, opened as its own page in a new tab — nothing else from the app around it. */
  openGitPanelInNewTab() {
    if (!GitActions._slug) return;
    window.open('/git-window.html?slug=' + encodeURIComponent(GitActions._slug), '_blank');
  },

  /** Commit (and optionally push), then repaint every view that shows git state. */
  async runCommit(message, files, andPush) {
    const committed = await GitActions._call(() => GitApi.commit(GitActions._slug, message, files), 'Committed');
    if (committed && andPush) await GitActions._call(() => GitApi.push(GitActions._slug), 'Pushed');
    await GitActions._repaint();
  },

  push() {
    return GitActions._remote(() => GitApi.push(GitActions._slug), 'Pushed');
  },

  pull() {
    return GitActions._remote(() => GitApi.pull(GitActions._slug), 'Pulled');
  },

  fetch() {
    return GitActions._remote(() => GitApi.fetch(GitActions._slug), 'Fetched');
  },

  /** Run one git call and report it. Returns false when git refused, so a chain can stop. */
  async _call(call, okMessage) {
    try {
      const result = await call();
      toast(result.output || okMessage);
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  },

  async _remote(call, okMessage) {
    await GitActions._call(call, okMessage);
    await GitActions._repaint();
  },

  /** Every view showing git state, repainted once per user action. */
  async _repaint() {
    await GitActions.refresh();
    if (typeof GitPanel !== 'undefined') await GitPanel.refreshIfMounted();
  }
};

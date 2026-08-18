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
    try {
      GitActions._info = await api(`/api/projects/${encodeURIComponent(GitActions._slug)}/git/info`);
    } catch (_) {
      GitActions._info = { available: false };
    }
    if (!GitActions._info.available) { GitActions._shellRunning = false; return; }
    await GitActions._fetchShellState();
  },

  async _fetchShellState() {
    try {
      const shell = await api(`/api/projects/${encodeURIComponent(GitActions._slug)}/terminal/info?mode=shell`);
      GitActions._shellRunning = !!shell.running;
    } catch (_) {
      GitActions._shellRunning = false;
    }
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

  _menuHtml(branch) {
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
    return `<div class="action-menu">
        <button class="btn btn-sm git-icon-btn" title="Git actions" onclick="event.stopPropagation(); GitActions.toggleMenu(this)">${icon}${branchLabel}${shellDot}${GitActions._syncHtml()}${countBadge}</button>
        <div class="action-menu-panel">
          <button class="action-menu-item" onclick="event.stopPropagation(); GitActions.openGitPanel()">Shell &amp; recipes</button>
          <button class="action-menu-item" onclick="event.stopPropagation(); GitActions.openCommitModal(false)">Commit</button>
          <button class="action-menu-item" onclick="event.stopPropagation(); GitActions.push()">Push</button>
          <button class="action-menu-item" onclick="event.stopPropagation(); GitActions.openCommitModal(true)">Commit and Push</button>
        </div>
      </div>`;
  },

  _render() {
    if (!GitActions._info || !GitActions._info.available) return;
    GitActions._setTabVisible(true);
    const branch = GitActions._info.branch;
    const menu = GitActions._menuHtml(branch);
    const footer = document.getElementById('footer-git');
    if (footer) {
      footer.innerHTML = menu;
      footer.style.display = 'flex';
    }
  },

  /** In the project view the Git tab is right there, so use it; anywhere else (a session) the same
   *  panel opens in a modal so the user never has to leave what they were doing. */
  openGitPanel() {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
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
      body: '<div id="git-panel-modal-host"></div>',
      onClose: () => GitPanel.unmount()
    });
    GitPanel.mount('git-panel-modal-host', GitActions._slug);
  },

  toggleMenu(btn) {
    const panel = btn.nextElementSibling;
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    if (!isOpen) panel.classList.add('open');
  },

  async openCommitModal(andPush) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));

    try {
      GitActions._info = await api(`/api/projects/${encodeURIComponent(GitActions._slug)}/git/info`);
    } catch (_) {}
    GitActions._render();

    const info = GitActions._info;
    if (!info || !info.available) { toast('Git not available in this project', 'error'); return; }

    const files = info.files || [];
    const branchHtml = info.branch
      ? `<div style="margin-bottom:12px;font-size:13px;color:var(--text-muted)">${info.detached ? 'Detached HEAD' : 'Branch'}: <strong>${escapeHtml(info.branch)}</strong></div>`
      : '';

    let filesHtml;
    if (files.length === 0) {
      filesHtml = `<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No changed files.</div>`;
    } else {
      const badgeClass = { new: 'ctx-file-badge-new', modified: 'ctx-file-badge-edited', deleted: 'ctx-file-badge-deleted', untracked: 'ctx-file-badge-new' };
      const rows = files.map(f => `
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:13px;text-transform:none;letter-spacing:normal;font-weight:normal;color:var(--text-primary);margin-bottom:0">
          <input type="checkbox" class="git-file-cb" value="${escapeHtml(f.path)}" checked>
          <span class="ctx-file-badge git-file-badge ${escapeHtml(badgeClass[f.label] || 'ctx-file-badge-edited')}">${escapeHtml(f.label)}</span>
          <span style="word-break:break-all">${escapeHtml(f.path)}</span>
        </label>`).join('');
      filesHtml = `<div style="max-height:240px;overflow-y:auto;margin-bottom:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px">${rows}</div>`;
    }

    const msgHtml = formGroup('Commit message',
      '<textarea id="git-commit-msg" rows="4" style="width:100%;resize:vertical" placeholder="Enter commit message…"></textarea>');

    const title = andPush ? 'Commit and Push' : 'Commit';
    openModal({
      title,
      width: 640,
      body: branchHtml + filesHtml + msgHtml,
      buttons: [
        { label: title, primary: true, onClick: () => GitActions._executeCommit(andPush) }
      ]
    });

    setTimeout(() => { document.getElementById('git-commit-msg')?.focus(); }, 50);
  },

  _executeCommit(andPush) {
    const msg = (document.getElementById('git-commit-msg')?.value || '').trim();
    if (!msg) { toast('Commit message is required', 'error'); return false; }
    const files = Array.from(document.querySelectorAll('.git-file-cb:checked')).map(cb => cb.value);
    if (!files.length) { toast('No files selected', 'error'); return false; }
    GitActions._doCommit(msg, files, andPush);
  },

  async _doCommit(message, files, andPush) {
    try {
      const result = await api(`/api/projects/${encodeURIComponent(GitActions._slug)}/git/commit`, {
        method: 'POST',
        body: { message, files }
      });
      toast(result.output || 'Committed');
      if (andPush) await GitActions._doPush();
      GitActions.init(GitActions._slug);
    } catch (e) {
      toast(e.message, 'error');
    }
  },

  async push() {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    await GitActions._doPush();
    GitActions.init(GitActions._slug);
  },

  async _doPush() {
    try {
      const result = await api(`/api/projects/${encodeURIComponent(GitActions._slug)}/git/push`, { method: 'POST' });
      toast(result.output || 'Pushed');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
};

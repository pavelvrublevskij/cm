const Artifacts = {
  _projectCache: { slug: null, data: null },

  /** Toggle the sidebar nav item on/off depending on whether any artifact exists anywhere. */
  async checkGlobalVisibility() {
    const nav = document.getElementById('nav-artifacts');
    if (!nav) return;
    try {
      const summary = await api('/api/artifacts/summary');
      nav.style.display = summary.total > 0 ? '' : 'none';
      const badge = document.getElementById('nav-artifacts-count');
      if (badge) badge.textContent = summary.total > 0 ? summary.total : '';
    } catch (_) {
      nav.style.display = 'none';
    }
  },

  async load() {
    const list = document.getElementById('artifacts-list');
    if (!list) return;
    showLoading(list);
    let artifacts;
    try {
      artifacts = await api('/api/artifacts');
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><p>Could not load artifacts: ${escapeHtml(e.message)}</p></div>`;
      return;
    }
    if (!artifacts.length) {
      list.innerHTML = '<div class="empty-state"><p>No artifacts published yet</p></div>';
      return;
    }
    list.innerHTML = `<div class="card-grid">${artifacts.map(a => Artifacts._cardHtml(a, { showProject: true })).join('')}</div>`;
  },

  /** Called once when a project is opened: fetches its artifacts and shows/hides the project tab. */
  async initProject(slug) {
    const btn = document.getElementById('artifacts-tab-btn');
    if (!btn) return;
    btn.style.display = 'none';
    btn.textContent = 'Artifacts';
    Artifacts._projectCache = { slug: null, data: null };

    let data;
    try { data = await api(`/api/projects/${slug}/artifacts`); }
    catch (_) { return; }

    Artifacts._projectCache = { slug, data };
    if (data.total > 0) {
      btn.style.display = '';
      btn.textContent = `Artifacts (${data.total})`;
    }
  },

  async renderProjectTab(slug) {
    const container = document.getElementById('proj-artifacts-content');
    if (!container) return;

    let data = Artifacts._projectCache.slug === slug ? Artifacts._projectCache.data : null;
    if (!data) {
      showLoading(container);
      try { data = await api(`/api/projects/${slug}/artifacts`); }
      catch (e) { container.innerHTML = `<div class="empty-state"><p>Could not load artifacts: ${escapeHtml(e.message)}</p></div>`; return; }
      Artifacts._projectCache = { slug, data };
    }

    if (!data.groups.length) {
      container.innerHTML = '<div class="empty-state"><p>No artifacts published from this project yet</p></div>';
      return;
    }

    container.innerHTML = data.groups.map(g => `
      <div class="artifact-group">
        <div class="artifact-group-title">${g.ticket ? escapeHtml(g.ticket) : 'No ticket'}</div>
        <div class="card-grid">${g.artifacts.map(a => Artifacts._cardHtml(a)).join('')}</div>
      </div>
    `).join('');
  },

  _cardHtml(a, opts = {}) {
    const favicon = a.favicon ? escapeHtml(a.favicon) : '📎';
    const ticketBadge = a.ticket ? `<span class="badge artifact-ticket-badge">${escapeHtml(a.ticket)}</span>` : '';
    const projectLabel = opts.showProject ? `<span class="artifact-project-label">${escapeHtml(decodeName(a.slug))}</span>` : '';
    const desc = a.description ? `<div class="artifact-card-desc">${escapeHtml(a.description)}</div>` : '';
    const sessionAction = opts.hideSessionAction ? '' :
      `<button class="btn btn-sm" onclick="Artifacts.jumpToSession('${a.slug}','${a.sessionId}')">View session</button>`;
    return `
      <div class="card artifact-card">
        <div class="artifact-card-header">
          <span class="artifact-card-icon">${favicon}</span>
          <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener" class="artifact-card-title">${escapeHtml(a.title || 'Untitled artifact')}</a>
        </div>
        ${desc}
        <div class="artifact-card-meta">
          ${projectLabel}
          ${ticketBadge}
          <span class="artifact-card-time" title="${escapeAttr(a.updatedAt || '')}">${timeAgo(a.updatedAt)}</span>
        </div>
        <div class="artifact-card-actions">
          <a class="btn btn-sm" href="${escapeAttr(a.url)}" target="_blank" rel="noopener">Open</a>
          ${sessionAction}
        </div>
      </div>
    `;
  },

  jumpToSession(slug, sessionId) {
    App.navigate('session-detail', { slug, sessionId, sessionInfo: null });
  }
};

// --- Session-detail Artifacts tab: same show/hide-until-populated pattern as the Scratchpad tab ---

Object.assign(Sessions, {
  _artifactsLoaded: false,

  async checkArtifacts() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    try {
      const artifacts = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/artifacts`);
      if (Sessions.detailState.slug !== slug || Sessions.detailState.sessionId !== sessionId) return;
      Sessions._updateArtifactsTabVisibility(artifacts.length > 0);
    } catch (_) {}
  },

  _updateArtifactsTabVisibility(hasArtifacts) {
    const btn = document.getElementById('tab-btn-artifacts');
    if (!btn) return;
    btn.style.display = hasArtifacts ? '' : 'none';
    if (!hasArtifacts && btn.classList.contains('active')) Sessions.switchTab('file-changes');
  },

  async loadArtifactsTab() {
    const el = document.getElementById('session-artifacts');
    if (!el) return;
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;

    Sessions._artifactsLoaded = true;
    showLoading(el);

    try {
      const artifacts = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/artifacts`);
      if (Sessions.detailState.slug !== slug || Sessions.detailState.sessionId !== sessionId) return;
      if (!artifacts.length) {
        el.innerHTML = '<div class="empty-state"><p>No artifacts published in this session.</p></div>';
        return;
      }
      el.innerHTML = `<div class="card-grid">${artifacts.map(a => Artifacts._cardHtml(a, { hideSessionAction: true })).join('')}</div>`;
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
});

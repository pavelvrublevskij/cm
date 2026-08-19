const ActiveSessionsBar = {
  POLL_MS: 15000,
  _timer: null,
  _sessions: [],
  _lastSidebarKey: null,
  _projectBranches: {},

  start() {
    ActiveSessionsBar.poll();
    ActiveSessionsBar._timer = setInterval(ActiveSessionsBar.poll, ActiveSessionsBar.POLL_MS);
    document.addEventListener('click', () => {
      const p = document.getElementById('asb-new-panel');
      if (p) p.remove();
    });
  },

  _showNewPanel(btn, slug) {
    const existing = document.getElementById('asb-new-panel');
    if (existing) {
      existing.remove();
      if (existing.dataset.slug === slug) return;
    }
    const rect = btn.getBoundingClientRect();
    const panel = document.createElement('div');
    panel.id = 'asb-new-panel';
    panel.className = 'action-menu-panel open';
    panel.dataset.slug = slug;
    const panelWidth = 150;
    const hPos = rect.right >= panelWidth
      ? `right:${window.innerWidth - rect.right}px`
      : `left:${Math.max(0, rect.left)}px`;
    panel.style.cssText = `position:fixed;top:auto;${hPos};bottom:${window.innerHeight - rect.top + 4}px;z-index:1000;width:max-content;`;
    panel.innerHTML = `<button class="action-menu-item" data-action="os">In OS terminal</button><button class="action-menu-item" data-action="browser">In browser terminal</button>`;
    panel.querySelectorAll('.action-menu-item').forEach(item => {
      item.addEventListener('click', e => {
        e.stopPropagation();
        panel.remove();
        if (typeof Sessions === 'undefined') return;
        if (item.dataset.action === 'os') Sessions.newSessionOS(slug);
        else Sessions.newSessionBrowser(slug);
      });
    });
    document.body.appendChild(panel);
  },

  async poll() {
    try {
      const sessions = await api('/api/projects/active');
      ActiveSessionsBar._sessions = sessions || [];
      await ActiveSessionsBar._fetchProjectBranches();
      ActiveSessionsBar._render();
      ActiveSessionsBar._renderSidebar();
    } catch (_) {}
  },

  async _fetchProjectBranches() {
    const slugs = [...new Set(ActiveSessionsBar._sessions.map(s => s.slug))];
    await Promise.all(slugs.map(async slug => {
      try {
        const info = await api(`/api/projects/${encodeURIComponent(slug)}/git/info`);
        ActiveSessionsBar._projectBranches[slug] = info.available ? (info.branch || '') : '';
      } catch (_) {
        ActiveSessionsBar._projectBranches[slug] = '';
      }
    }));
  },

  _hasBranchMismatch(s) {
    const projectBranch = ActiveSessionsBar._projectBranches[s.slug];
    return !!(s.lastGitBranch && projectBranch && s.lastGitBranch !== projectBranch);
  },

  _archiveIconSvg: '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="vertical-align:-1px"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v1.5C0 5.216.784 6 1.75 6v6.25c0 .966.784 1.75 1.75 1.75h9c.966 0 1.75-.784 1.75-1.75V6A1.75 1.75 0 0 0 16 4.25v-1.5A1.75 1.75 0 0 0 14.25 1ZM6.5 9.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>',

  _render() {
    const bar = document.getElementById('active-sessions-bar');
    if (!bar) return;
    const sessions = ActiveSessionsBar._sessions;

    const container = document.getElementById('asb-groups');
    if (!container) return;

    if (!sessions.length) {
      bar.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    bar.style.display = 'flex';

    const inSession = typeof App !== 'undefined' && App.currentView === 'session-detail';
    const currentSessionId = inSession && typeof Sessions !== 'undefined' ? Sessions.detailState.sessionId : null;

    const slugOrder = [];
    const bySlug = {};
    for (const s of sessions) {
      if (!bySlug[s.slug]) { bySlug[s.slug] = []; slugOrder.push(s.slug); }
      bySlug[s.slug].push(s);
    }

    const groupsHtml = slugOrder.map(slug => {
      const group = bySlug[slug];
      const pills = group.map(s => {
        const label = s.title || s.sessionId.slice(0, 12);
        const isCurrent = s.sessionId === currentSessionId;
        const warn = ActiveSessionsBar._hasBranchMismatch(s);
        const warnIcon = warn ? `<span class="asb-branch-warn-icon" title="Branch mismatch: session on &quot;${escapeHtml(s.lastGitBranch)}&quot;, project on &quot;${escapeHtml(ActiveSessionsBar._projectBranches[s.slug])}&quot;">&#9888;</span>` : '';
        const archiveIcon = s.archived ? `<span class="asb-archive-icon" title="Session is archived">${ActiveSessionsBar._archiveIconSvg}</span>` : '';
        return `<div class="asb-pill${isCurrent ? ' asb-pill--current' : ''}${warn ? ' asb-pill--branch-warn' : ''}" data-asb-session="${escapeHtml(s.sessionId)}" data-asb-slug="${escapeHtml(s.slug)}" title="${escapeHtml(s.title || s.sessionId)}">
          <span class="session-active-dot session-active-dot--${s.kind}"></span>
          ${warnIcon}${archiveIcon}
          <span class="asb-session">${escapeHtml(label)}</span>
          <button class="asb-close" data-asb-close-session="${escapeHtml(s.sessionId)}" data-asb-close-slug="${escapeHtml(s.slug)}" title="Close session" aria-label="Close">&#215;</button>
        </div>`;
      }).join('');
      return `<div class="asb-group">
        <div class="asb-group-header">
          <span class="asb-group-name">${escapeHtml(decodeName(slug))}</span>
          <button class="asb-new-btn" onclick="event.stopPropagation(); ActiveSessionsBar._showNewPanel(this, '${slug}')" title="New session">+</button>
        </div>
        <div class="asb-group-sessions">${pills}</div>
      </div>`;
    }).join('');

    container.innerHTML = groupsHtml;

    container.querySelectorAll('.asb-pill').forEach(el => {
      el.addEventListener('click', () => ActiveSessionsBar.open(el.dataset.asbSlug, el.dataset.asbSession));
    });
    container.querySelectorAll('[data-asb-close-session]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        ActiveSessionsBar.close(btn.dataset.asbCloseSlug, btn.dataset.asbCloseSession);
      });
    });
  },

  _renderSidebar() {
    const inSession = typeof App !== 'undefined' && App.currentView === 'session-detail';
    const currentSessionId = inSession && typeof Sessions !== 'undefined' ? Sessions.detailState.sessionId : null;
    const key = ActiveSessionsBar._sessions.map(s => s.slug + '|' + s.sessionId + '|' + ActiveSessionsBar._hasBranchMismatch(s) + '|' + !!s.archived).join(',') + '|' + currentSessionId;
    if (key === ActiveSessionsBar._lastSidebarKey) return;
    ActiveSessionsBar._lastSidebarKey = key;

    document.querySelectorAll('.project-active-sub').forEach(el => el.remove());

    const bySlug = {};
    for (const s of ActiveSessionsBar._sessions) {
      if (!bySlug[s.slug]) bySlug[s.slug] = [];
      bySlug[s.slug].push(s);
    }

    for (const [slug, sessions] of Object.entries(bySlug)) {
      const navItem = document.querySelector(`.project-list .nav-item[data-slug="${slug}"]`);
      if (!navItem) continue;
      let anchor = navItem;
      for (const s of sessions) {
        const label = (s.title || s.sessionId.slice(0, 16)).slice(0, 28);
        const isCurrent = s.sessionId === currentSessionId;
        const div = document.createElement('div');
        div.className = 'nav-item project-active-sub' + (isCurrent ? ' active' : '');
        div.title = s.title || s.sessionId;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'asb-close asb-close--sidebar';
        closeBtn.title = 'Close session';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '&#215;';
        closeBtn.addEventListener('click', (function(slug, sessionId) {
          return e => { e.stopPropagation(); ActiveSessionsBar.close(slug, sessionId); };
        }(s.slug, s.sessionId)));
        const warn = ActiveSessionsBar._hasBranchMismatch(s);
        const warnIcon = warn ? `<span class="asb-branch-warn-icon" title="Branch mismatch: session on &quot;${escapeHtml(s.lastGitBranch)}&quot;, project on &quot;${escapeHtml(ActiveSessionsBar._projectBranches[s.slug])}&quot;">&#9888;</span>` : '';
        const archiveIcon = s.archived ? `<span class="asb-archive-icon" title="Session is archived">${ActiveSessionsBar._archiveIconSvg}</span>` : '';
        div.innerHTML = `<span class="session-active-dot session-active-dot--${s.kind}"></span>${warnIcon}${archiveIcon}<span class="nav-label">${escapeHtml(label)}</span>`;
        div.appendChild(closeBtn);
        div.addEventListener('click', (function(slug, sessionId) {
          return () => ActiveSessionsBar.open(slug, sessionId);
        }(s.slug, s.sessionId)));
        anchor.insertAdjacentElement('afterend', div);
        anchor = div;
      }

      const newDiv = document.createElement('div');
      newDiv.className = 'nav-item project-active-sub project-active-sub--new';
      newDiv.title = 'New session';

      const newBtn = document.createElement('button');
      newBtn.className = 'asb-sidebar-new-btn';
      newBtn.innerHTML = `<span class="asb-new-sidebar-icon">+</span><span class="nav-label">New session</span>`;

      newBtn.addEventListener('click', e => {
        e.stopPropagation();
        ActiveSessionsBar._showNewPanel(newBtn, slug);
      });

      newDiv.appendChild(newBtn);
      anchor.insertAdjacentElement('afterend', newDiv);
    }
  },

  async close(slug, sessionId) {
    try {
      await api(`/api/projects/${slug}/sessions/${sessionId}/deactivate`, { method: 'POST' });
    } catch (_) {}
    ActiveSessionsBar._sessions = ActiveSessionsBar._sessions.filter(
      s => !(s.slug === slug && s.sessionId === sessionId)
    );
    ActiveSessionsBar._render();
    ActiveSessionsBar._renderSidebar();
    if (typeof ActiveCount !== 'undefined') ActiveCount.refresh();
    ActiveSessionsBar._clearActiveState(slug, sessionId);
  },

  // A closed session must stop looking active everywhere, not just in the bar: drop the cached
  // active flags, strip rendered dots, and leave the session view it was closed from.
  _clearActiveState(slug, sessionId) {
    if (typeof Sessions !== 'undefined' && Sessions.cache && Sessions.cache[slug]) {
      const cached = Sessions.cache[slug].find(s => s.sessionId === sessionId);
      if (cached) { cached.active = false; cached.activeKind = null; }
    }

    if (typeof Dashboard !== 'undefined') {
      (Dashboard._sessions || []).forEach(s => {
        if (s.slug === slug && s.sessionId === sessionId) { s.active = false; s.activeKind = null; }
      });
      if (Dashboard._activeSessions) {
        Dashboard._activeSessions = Dashboard._activeSessions.filter(
          s => !(s.slug === slug && s.sessionId === sessionId)
        );
        Dashboard.renderActiveSessions(Dashboard._activeSessions);
      }
    }

    document.querySelectorAll(`.session-card[data-session-id="${sessionId}"] .session-active-dot`)
      .forEach(dot => dot.remove());

    const inSession = typeof App !== 'undefined' && App.currentView === 'session-detail'
      && typeof Sessions !== 'undefined'
      && Sessions.detailState.slug === slug && Sessions.detailState.sessionId === sessionId;
    if (!inSession) return;

    Sessions.stopAutoRefresh();
    if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()
      && TerminalPanel.state.slug === slug && TerminalPanel.state.sessionId === sessionId) {
      TerminalPanel.close();
    }
    App.navigate('project-detail', { slug });
  },

  open(slug, sessionId) {
    if (typeof Sessions !== 'undefined') Sessions.stopAutoRefresh();
    if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()) TerminalPanel.close();
    const cached = (typeof Sessions !== 'undefined' && Sessions.cache[slug]) || [];
    const info = cached.find(s => s.sessionId === sessionId) || null;
    App.navigate('session-detail', { slug, sessionId, sessionInfo: info });
  }
};

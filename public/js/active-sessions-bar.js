const ActiveSessionsBar = {
  POLL_MS: 15000,
  POSITION_KEY: 'claude-manager-asb-position',
  _timer: null,
  _sessions: [],
  _lastSidebarKey: null,
  _projectBranches: {},

  start() {
    ActiveSessionsBar._applyPosition(localStorage.getItem(ActiveSessionsBar.POSITION_KEY) || 'bottom');
    const toggle = document.getElementById('asb-position-toggle');
    if (toggle) toggle.addEventListener('click', e => { e.stopPropagation(); ActiveSessionsBar._togglePosition(); });
    ActiveSessionsBar.poll();
    ActiveSessionsBar._timer = setInterval(ActiveSessionsBar.poll, ActiveSessionsBar.POLL_MS);
    document.addEventListener('click', () => {
      const p = document.getElementById('asb-new-panel');
      if (p) p.remove();
    });
  },

  _applyPosition(position) {
    const bar = document.getElementById('active-sessions-bar');
    const toggle = document.getElementById('asb-position-toggle');
    if (!bar) return;
    bar.classList.toggle('asb-position-top', position === 'top');
    if (toggle) {
      toggle.innerHTML = position === 'top' ? '&#8595;' : '&#8593;';
      toggle.title = position === 'top' ? 'Move to bottom' : 'Move to top';
    }
  },

  _togglePosition() {
    const current = localStorage.getItem(ActiveSessionsBar.POSITION_KEY) || 'bottom';
    const next = current === 'top' ? 'bottom' : 'top';
    localStorage.setItem(ActiveSessionsBar.POSITION_KEY, next);
    ActiveSessionsBar._applyPosition(next);
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

    const { currentSessionId, currentReadOnly, currentInstanceId } = ActiveSessionsBar._currentSelector();

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
        const isCurrent = ActiveSessionsBar._isCurrent(s, currentSessionId, currentReadOnly, currentInstanceId);
        const warn = ActiveSessionsBar._hasBranchMismatch(s);
        const warnIcon = warn ? `<span class="asb-branch-warn-icon" title="Branch mismatch: session on &quot;${escapeHtml(s.lastGitBranch)}&quot;, project on &quot;${escapeHtml(ActiveSessionsBar._projectBranches[s.slug])}&quot;">&#9888;</span>` : '';
        const archiveIcon = s.archived ? `<span class="asb-archive-icon" title="Session is archived">${ActiveSessionsBar._archiveIconSvg}</span>` : '';
        const roTitle = s.kind === 'readonly' ? ' (read-only)' : '';
        const instanceAttr = s.instanceId ? ` data-asb-instance="${escapeHtml(s.instanceId)}"` : '';
        return `<div class="asb-pill${isCurrent ? ' asb-pill--current' : ''}${warn ? ' asb-pill--branch-warn' : ''}" data-asb-session="${escapeHtml(s.sessionId)}" data-asb-slug="${escapeHtml(s.slug)}" data-asb-kind="${escapeHtml(s.kind)}"${instanceAttr} title="${escapeHtml(s.title || s.sessionId)}${roTitle}">
          <span class="session-active-dot session-active-dot--${s.kind}"></span>
          ${warnIcon}${archiveIcon}
          <span class="asb-session">${escapeHtml(label)}</span>
          <button class="asb-close" data-asb-close-session="${escapeHtml(s.sessionId)}" data-asb-close-slug="${escapeHtml(s.slug)}"${instanceAttr} title="Close session" aria-label="Close">&#215;</button>
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
      el.addEventListener('click', () => ActiveSessionsBar.open(el.dataset.asbSlug, el.dataset.asbSession, el.dataset.asbKind === 'readonly'));
    });
    container.querySelectorAll('[data-asb-close-session]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.dataset.asbInstance) {
          ActiveSessionsBar.closeReadonly(btn.dataset.asbCloseSlug, btn.dataset.asbCloseSession, btn.dataset.asbInstance);
        } else {
          ActiveSessionsBar.close(btn.dataset.asbCloseSlug, btn.dataset.asbCloseSession);
        }
      });
    });
  },

  // Which session (and, for read-only, which of possibly several tab instances) counts as "the one
  // I'm currently looking at" — used to highlight the matching pill/sub-item.
  _currentSelector() {
    const inSession = typeof App !== 'undefined' && App.currentView === 'session-detail';
    const detail = inSession && typeof Sessions !== 'undefined' ? Sessions.detailState : null;
    return {
      currentSessionId: detail ? detail.sessionId : null,
      currentReadOnly: !!(detail && detail.readOnly),
      currentInstanceId: detail ? detail.readOnlyInstanceId : null
    };
  },

  _isCurrent(s, currentSessionId, currentReadOnly, currentInstanceId) {
    if (s.sessionId !== currentSessionId) return false;
    if (s.kind === 'readonly') return currentReadOnly && s.instanceId === currentInstanceId;
    return !currentReadOnly;
  },

  _renderSidebar() {
    const { currentSessionId, currentReadOnly, currentInstanceId } = ActiveSessionsBar._currentSelector();
    const key = ActiveSessionsBar._sessions.map(s => s.slug + '|' + s.sessionId + '|' + (s.instanceId || '') + '|' + ActiveSessionsBar._hasBranchMismatch(s) + '|' + !!s.archived).join(',') + '|' + currentSessionId + '|' + currentReadOnly + '|' + currentInstanceId;
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
      // A project grouped with its worktrees sits at its own depth in the sidebar tree. Session rows
      // have to follow that depth rather than use a fixed indent, or a nested project's sessions
      // render further left than the project they belong to. Read --tree-indent rather than the
      // computed padding: while the sidebar is collapsed the padding is flattened to 0, but the
      // custom property still carries the row's real depth.
      const ownIndent = parseFloat(getComputedStyle(navItem).getPropertyValue('--tree-indent')) || TREE_INDENT_ROOT;
      const indent = ownIndent + TREE_INDENT_STEP;
      let anchor = navItem;
      for (const s of sessions) {
        const label = (s.title || s.sessionId.slice(0, 16)).slice(0, 28);
        const isCurrent = ActiveSessionsBar._isCurrent(s, currentSessionId, currentReadOnly, currentInstanceId);
        const div = document.createElement('div');
        div.className = 'nav-item project-active-sub' + (isCurrent ? ' active' : '');
        div.style.setProperty('--tree-indent', indent + 'px');
        div.title = (s.title || s.sessionId) + (s.kind === 'readonly' ? ' (read-only)' : '');
        const closeBtn = document.createElement('button');
        closeBtn.className = 'asb-close asb-close--sidebar';
        closeBtn.title = 'Close session';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '&#215;';
        closeBtn.addEventListener('click', (function(slug, sessionId, instanceId) {
          return e => {
            e.stopPropagation();
            if (instanceId) ActiveSessionsBar.closeReadonly(slug, sessionId, instanceId);
            else ActiveSessionsBar.close(slug, sessionId);
          };
        }(s.slug, s.sessionId, s.instanceId)));
        const warn = ActiveSessionsBar._hasBranchMismatch(s);
        const warnIcon = warn ? `<span class="asb-branch-warn-icon" title="Branch mismatch: session on &quot;${escapeHtml(s.lastGitBranch)}&quot;, project on &quot;${escapeHtml(ActiveSessionsBar._projectBranches[s.slug])}&quot;">&#9888;</span>` : '';
        const archiveIcon = s.archived ? `<span class="asb-archive-icon" title="Session is archived">${ActiveSessionsBar._archiveIconSvg}</span>` : '';
        div.innerHTML = `<span class="session-active-dot session-active-dot--${s.kind}"></span>${warnIcon}${archiveIcon}<span class="nav-label">${escapeHtml(label)}</span>`;
        div.appendChild(closeBtn);
        div.addEventListener('click', (function(slug, sessionId, kind) {
          return () => ActiveSessionsBar.open(slug, sessionId, kind === 'readonly');
        }(s.slug, s.sessionId, s.kind)));
        anchor.insertAdjacentElement('afterend', div);
        anchor = div;
      }

      const newDiv = document.createElement('div');
      newDiv.className = 'nav-item project-active-sub project-active-sub--new';
      newDiv.style.setProperty('--tree-indent', indent + 'px');
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

  // Shared tail for close()/closeReadonly(): drop matching entries from the local list and
  // refresh every view that shows it.
  _removeFromBar(predicate) {
    ActiveSessionsBar._sessions = ActiveSessionsBar._sessions.filter(s => !predicate(s));
    ActiveSessionsBar._render();
    ActiveSessionsBar._renderSidebar();
    if (typeof ActiveCount !== 'undefined') ActiveCount.refresh();
  },

  async close(slug, sessionId) {
    try {
      await api(`/api/projects/${slug}/sessions/${sessionId}/deactivate`, { method: 'POST' });
    } catch (_) {}
    ActiveSessionsBar._removeFromBar(s => s.slug === slug && s.sessionId === sessionId);
    ActiveSessionsBar._clearActiveState(slug, sessionId);
  },

  // Read-only pills are per-instance (the same session can have several), so closing one must not
  // touch other tabs' pills for that same session — match on instanceId, not just slug|sessionId.
  async closeReadonly(slug, sessionId, instanceId) {
    try {
      await api(`/api/projects/${slug}/sessions/${sessionId}/close-readonly`, { method: 'POST', body: { instanceId } });
    } catch (_) {}
    ActiveSessionsBar._removeFromBar(s => s.slug === slug && s.sessionId === sessionId && s.instanceId === instanceId);

    const inThisInstance = typeof App !== 'undefined' && App.currentView === 'session-detail'
      && typeof Sessions !== 'undefined' && Sessions.detailState.readOnly
      && Sessions.detailState.slug === slug && Sessions.detailState.sessionId === sessionId
      && Sessions.detailState.readOnlyInstanceId === instanceId;
    if (inThisInstance) App.navigate('project-detail', { slug });
  },

  // Closing here only tears down the real process (os/browser) — a read-only viewer on the same
  // session is a separate, unrelated fact and must survive: drop just the real-process kind from
  // cached activeKinds and keep the session listed/dotted if 'readonly' remains.
  _dropRealKinds(kinds) {
    return (kinds || []).filter(k => k !== 'browser' && k !== 'os');
  },

  // A closed session must stop looking active everywhere, not just in the bar: drop the cached
  // active flags, strip rendered dots, and leave the session view it was closed from.
  _clearActiveState(slug, sessionId) {
    if (typeof Sessions !== 'undefined' && Sessions.cache && Sessions.cache[slug]) {
      const cached = Sessions.cache[slug].find(s => s.sessionId === sessionId);
      if (cached) {
        cached.activeKinds = ActiveSessionsBar._dropRealKinds(cached.activeKinds);
        cached.active = cached.activeKinds.length > 0;
        cached.activeKind = cached.activeKinds[0] || null;
      }
    }

    if (typeof Dashboard !== 'undefined') {
      (Dashboard._sessions || []).forEach(s => {
        if (s.slug !== slug || s.sessionId !== sessionId) return;
        s.activeKinds = ActiveSessionsBar._dropRealKinds(s.activeKinds);
        s.active = s.activeKinds.length > 0;
        s.activeKind = s.activeKinds[0] || null;
      });
      if (Dashboard._activeSessions) {
        // Note: built via .map()/.filter() chained directly off the existing array (not a fresh []
        // literal) so the result stays a same-realm array — this file can run inside a vm sandbox
        // in tests, where a literal [] created in that context is a foreign-realm object and fails
        // assert.deepStrictEqual against a plain array despite matching content.
        Dashboard._activeSessions = Dashboard._activeSessions
          .map(s => {
            if (s.slug !== slug || s.sessionId !== sessionId) return s;
            const activeKinds = ActiveSessionsBar._dropRealKinds(s.activeKinds);
            return Object.assign({}, s, { activeKinds, active: activeKinds.length > 0, activeKind: activeKinds[0] || null });
          })
          .filter(s => !(s.slug === slug && s.sessionId === sessionId) || s.active);
        Dashboard.renderActiveSessions(Dashboard._activeSessions);
      }
    }

    document.querySelectorAll(
      `.session-card[data-session-id="${sessionId}"] .session-active-dot--browser, .session-card[data-session-id="${sessionId}"] .session-active-dot--os`
    ).forEach(dot => dot.remove());

    const inSession = typeof App !== 'undefined' && App.currentView === 'session-detail'
      && typeof Sessions !== 'undefined' && !Sessions.detailState.readOnly
      && Sessions.detailState.slug === slug && Sessions.detailState.sessionId === sessionId;
    if (!inSession) return;

    Sessions.stopAutoRefresh();
    if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()
      && TerminalPanel.state.slug === slug && TerminalPanel.state.sessionId === sessionId) {
      TerminalPanel.close();
    }
    App.navigate('project-detail', { slug });
  },

  open(slug, sessionId, readOnly) {
    if (typeof Sessions !== 'undefined') Sessions.stopAutoRefresh();
    if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()) TerminalPanel.close();
    const cached = (typeof Sessions !== 'undefined' && Sessions.cache[slug]) || [];
    const info = cached.find(s => s.sessionId === sessionId) || null;
    App.navigate('session-detail', { slug, sessionId, sessionInfo: info, readOnly: !!readOnly });
  }
};

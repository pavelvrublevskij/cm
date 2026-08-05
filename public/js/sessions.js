// --- Sessions ---

const Sessions = {
  cache: {},
  _searchSlug: null,
  _planFilter: false,
  _planSessionIds: null,
  _renderedGroups: [],
  _showArchived: false,
  GROUP_COLLAPSED_KEY: 'claude-manager-collapsed-groups',
  _searchKey(slug) { return `claude-manager-search-history-${slug}`; },
  _detailSearchKey(slug) { return `claude-manager-detail-search-history-${slug}`; },

  _getCollapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(Sessions.GROUP_COLLAPSED_KEY) || '[]')); }
    catch (_) { return new Set(); }
  },

  _saveCollapsed(set) {
    localStorage.setItem(Sessions.GROUP_COLLAPSED_KEY, JSON.stringify([...set]));
  },

  groupSessions(sessions) {
    const TICKET_RE = /\b[A-Z]{2,10}-\d+\b/g;
    const SKIP = new Set(['main', 'master', 'HEAD', 'develop', 'dev']);
    const TEMP_MS = 30 * 60 * 1000;

    function tickets(s) {
      return [...new Set(((s.firstPrompt || '') + ' ' + (s.summary || '')).match(TICKET_RE) || [])];
    }
    function featureBranch(s) {
      const b = s.lastGitBranch || s.gitBranch;
      return b && !SKIP.has(b) ? b : null;
    }
    function anyBranch(s) { return s.lastGitBranch || s.gitBranch || null; }

    const chron = [...sessions].sort((a, b) => new Date(a.created || 0) - new Date(b.created || 0));
    const groups = [];
    const ticketMap = {};
    const branchMap = {};

    for (const s of chron) {
      const tt = tickets(s);
      const fb = featureBranch(s);
      const ab = anyBranch(s);
      let matched = null;

      for (const t of tt) { if (ticketMap[t]) { matched = ticketMap[t]; break; } }
      if (!matched && fb && branchMap[fb]) matched = branchMap[fb];

      if (!matched && ab) {
        for (let i = groups.length - 1; i >= 0; i--) {
          const g = groups[i];
          const last = g.sessions[g.sessions.length - 1];
          const gap = new Date(s.created || 0) - new Date(last.modified || last.created || 0);
          if (gap >= 0 && gap <= TEMP_MS && anyBranch(last) === ab) { matched = g; break; }
        }
      }

      if (matched) {
        matched.sessions.push(s);
        for (const t of tt) if (!ticketMap[t]) ticketMap[t] = matched;
        if (fb && !branchMap[fb]) branchMap[fb] = matched;
      } else {
        const label = tt[0] || fb;
        const type = tt.length ? 'ticket' : fb ? 'branch' : 'temporal';
        const group = { key: (label || 'tmp') + ':' + groups.length, label: label || ab || 'session', type, sessions: [s] };
        groups.push(group);
        for (const t of tt) ticketMap[t] = group;
        if (fb) branchMap[fb] = group;
      }
    }

    const real = groups.filter(g => g.sessions.length > 1);
    const singles = groups.filter(g => g.sessions.length === 1).map(g => g.sessions[0]);
    real.sort((a, b) => new Date(b.sessions[b.sessions.length - 1].modified || 0) - new Date(a.sessions[a.sessions.length - 1].modified || 0));
    return {
      groups: real,
      ungrouped: singles.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0))
    };
  },

  _formatGap(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m gap`;
    const h = Math.round(ms / 3600000);
    if (h < 24) return `${h}h gap`;
    const d = Math.round(ms / 86400000);
    return `${d} day${d !== 1 ? 's' : ''} gap`;
  },

  _groupDateRange(sessions) {
    const first = sessions[0]?.created;
    const last = (sessions[sessions.length - 1]?.modified) || sessions[sessions.length - 1]?.created;
    if (!first) return '';
    const d1 = new Date(first), d2 = new Date(last);
    const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d1.toDateString() === d2.toDateString() ? fmt(d1) : `${fmt(d1)} – ${fmt(d2)}`;
  },

  renderGapRow(gapMs) {
    return `<div class="session-gap"><span>${Sessions._formatGap(gapMs)}</span></div>`;
  },

  renderGroup(slug, group, collapsed, idx) {
    const isCollapsed = collapsed.has(group.key);
    const allSessions = Sessions.cache[slug] || [];
    const hasPlanIds = Sessions._planSessionIds;

    const desc = [...group.sessions].reverse();
    let bodyHtml = '';
    desc.forEach((s, i) => {
      if (i > 0) {
        const gapMs = new Date(desc[i - 1].created || 0) - new Date(s.modified || s.created || 0);
        if (gapMs > 1800000) bodyHtml += Sessions.renderGapRow(gapMs);
      }
      const ci = allSessions.findIndex(x => x.sessionId === s.sessionId);
      const hasPlan = !!(hasPlanIds && hasPlanIds.has(s.sessionId));
      bodyHtml += renderSessionCard(s, {
        onclick: `Sessions.open('${slug}', '${s.sessionId}', ${ci >= 0 ? ci : i})`,
        slug, dates: true, sidechain: true, hasPlan, archived: Sessions._showArchived
      });
    });

    const dateRange = Sessions._groupDateRange(group.sessions);
    const arrow = isCollapsed ? '&#9654;' : '&#9660;';
    const typeClass = `session-group-type-${group.type}`;

    return `<div class="session-group ${typeClass}" data-group-idx="${idx}">
      <div class="session-group-header" onclick="Sessions.toggleGroup(${idx})">
        <span class="session-group-arrow">${arrow}</span>
        <span class="session-group-label">${escapeHtml(group.label)}</span>
        <span class="session-group-count">${group.sessions.length}</span>
        ${dateRange ? `<span class="session-group-date">${escapeHtml(dateRange)}</span>` : ''}
      </div>
      <div class="session-group-body${isCollapsed ? ' collapsed' : ''}">${bodyHtml}</div>
    </div>`;
  },

  toggleGroup(idx) {
    const group = Sessions._renderedGroups[idx];
    if (!group) return;
    const collapsed = Sessions._getCollapsed();
    if (collapsed.has(group.key)) collapsed.delete(group.key);
    else collapsed.add(group.key);
    Sessions._saveCollapsed(collapsed);
    const el = document.querySelector(`.session-group[data-group-idx="${idx}"]`);
    if (!el) return;
    el.querySelector('.session-group-body').classList.toggle('collapsed', collapsed.has(group.key));
    el.querySelector('.session-group-arrow').innerHTML = collapsed.has(group.key) ? '&#9654;' : '&#9660;';
  },

  async load(slug) {
    if (Sessions._searchSlug !== slug) {
      Sessions._planFilter = false;
      Sessions._showArchived = false;
      const cb = document.getElementById('filter-plan-only');
      if (cb) cb.checked = false;
    }
    Sessions._planSessionIds = null;
    Sessions._searchSlug = slug;
    const container = document.getElementById('sessions-list');
    showLoading(container, 'Loading sessions...');

    try {
      const url = Sessions._showArchived
        ? `/api/projects/${slug}/sessions?archived=true`
        : `/api/projects/${slug}/sessions`;
      const sessions = await api(url);
      Sessions.cache[slug] = sessions;
      Sessions.renderList(slug, Sessions.applyFilters(sessions));
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Could not load sessions</p></div>`;
    }

    Settings.ensureLoaded().then(() => Sessions.renderCleanupWarning());
  },

  renderCleanupWarning() {
    const el = document.getElementById('sessions-cleanup-warning');
    if (!el) return;
    if (Settings.data && Settings.data.cleanupPeriodDays === undefined) {
      el.style.display = '';
      el.innerHTML = '&#9888; <code>cleanupPeriodDays</code> is not set &mdash; Claude Code deletes local session transcripts after 30 days by default, which may be why older sessions are missing. Click to choose how many days to keep them.';
    } else {
      el.style.display = 'none';
    }
  },

  filterByDateRange(sessions) {
    const pu = (typeof ProjectUsage !== 'undefined') ? ProjectUsage : {};
    const { fromDate, toDate, fromTime, toTime } = pu;
    if (!fromDate && !toDate) return sessions;
    const fromMs = fromDate ? new Date(fromDate + 'T' + (fromTime || '00:00') + ':00').getTime() : null;
    const toMs = toDate ? new Date(toDate + 'T' + (toTime || '23:59') + ':59').getTime() : null;
    return sessions.filter(s => {
      const t = s.modified ? new Date(s.modified).getTime() : 0;
      if (fromMs && t < fromMs) return false;
      if (toMs && t > toMs) return false;
      return true;
    });
  },

  applyFilters(sessions) {
    let result = Sessions.filterByDateRange(sessions);
    if (Sessions._planFilter && Sessions._planSessionIds) {
      result = result.filter(s => Sessions._planSessionIds.has(s.sessionId));
    }
    return result;
  },

  rerenderWithFilter() {
    const slug = Sessions._searchSlug;
    if (!slug || !Sessions.cache[slug]) return;
    Sessions.renderList(slug, Sessions.applyFilters(Sessions.cache[slug]));
  },

  setPlanFilter(checked) {
    Sessions._planFilter = checked;
    Sessions._lastQuery = '';
    const cb = document.getElementById('filter-plan-only');
    if (cb) cb.checked = checked;
    Sessions.rerenderWithFilter();
  },

  toggleArchived(slug) {
    Sessions._showArchived = !Sessions._showArchived;
    Sessions._lastQuery = '';
    Sessions.load(slug);
  },

  archiveAction(slug, sessionId) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    openModal({
      title: 'Archive session',
      body: '<p>This session will be hidden from the session list and excluded from search. Token usage will still be counted in statistics.</p><p>Are you sure you want to archive this session?</p>',
      buttons: [{
        label: 'Archive',
        primary: true,
        onClick: async () => {
          try {
            await api(`/api/projects/${slug}/sessions/${sessionId}/archive`, { method: 'POST' });
            Sessions.cache[slug] = (Sessions.cache[slug] || []).filter(s => s.sessionId !== sessionId);
            Sessions.renderList(slug, Sessions.applyFilters(Sessions.cache[slug]));
          } catch (e) {
            toast(`Archive failed: ${e.message}`, 'error');
            return false;
          }
        }
      }]
    });
  },

  async unarchiveAction(slug, sessionId) {
    try {
      await api(`/api/projects/${slug}/sessions/${sessionId}/unarchive`, { method: 'POST' });
      Sessions.cache[slug] = (Sessions.cache[slug] || []).filter(s => s.sessionId !== sessionId);
      Sessions.renderList(slug, Sessions.applyFilters(Sessions.cache[slug]));
    } catch (e) {
      toast('Failed to unarchive session', 'error');
    }
  },

  _archiveIconSvg: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:5px"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v1.5C0 5.216.784 6 1.75 6v6.25c0 .966.784 1.75 1.75 1.75h9c.966 0 1.75-.784 1.75-1.75V6A1.75 1.75 0 0 0 16 4.25v-1.5A1.75 1.75 0 0 0 14.25 1ZM6.5 9.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>',

  _setDetailArchivedUI(isActive) {
    const archiveBtn = document.getElementById('session-detail-archive-btn');
    const unarchiveBtn = document.getElementById('session-detail-unarchive-btn');
    const warning = document.getElementById('session-archived-warning');
    if (archiveBtn) archiveBtn.style.display = 'none';
    if (unarchiveBtn) unarchiveBtn.style.display = isActive ? '' : 'none';
    if (warning) {
      warning.innerHTML = Sessions._archiveIconSvg + (isActive
        ? 'Session marked as archive and will not be visible later after session close. Is possible to unmark during this session.'
        : 'Session is archived and will not be visible in the sessions list.');
      warning.style.display = 'block';
    }
  },

  _clearDetailArchivedUI() {
    const archiveBtn = document.getElementById('session-detail-archive-btn');
    const unarchiveBtn = document.getElementById('session-detail-unarchive-btn');
    const warning = document.getElementById('session-archived-warning');
    if (archiveBtn) archiveBtn.style.display = '';
    if (unarchiveBtn) unarchiveBtn.style.display = 'none';
    if (warning) warning.style.display = 'none';
  },

  archiveDetail() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    openModal({
      title: 'Archive session',
      body: '<p>This session will be hidden from the session list and excluded from search. Token usage will still be counted in statistics.</p><p>Are you sure you want to archive this session?</p>',
      buttons: [{
        label: 'Archive',
        primary: true,
        onClick: async () => {
          try {
            const cachedSession = (Sessions.cache[slug] || []).find(s => s.sessionId === sessionId);
            const isActive = !!(Sessions._detailInfo && Sessions._detailInfo.active) || !!(cachedSession && cachedSession.active);
            await api(`/api/projects/${slug}/sessions/${sessionId}/archive`, { method: 'POST' });
            if (Sessions.cache[slug]) {
              Sessions.cache[slug] = Sessions.cache[slug].filter(s => s.sessionId !== sessionId);
            }
            Sessions._setDetailArchivedUI(isActive);
          } catch (e) {
            toast(`Archive failed: ${e.message}`, 'error');
            return false;
          }
        }
      }]
    });
  },

  async unarchiveDetail() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    try {
      await api(`/api/projects/${slug}/sessions/${sessionId}/unarchive`, { method: 'POST' });
      Sessions._clearDetailArchivedUI();
    } catch (e) {
      toast('Failed to unarchive session', 'error');
    }
  },

  renderSearchBar(slug) {
    const archivedBtnClass = Sessions._showArchived ? 'btn btn-sm btn-secondary btn-active' : 'btn btn-sm btn-secondary';
    const archivedBtnTitle = Sessions._showArchived ? 'Showing archived sessions — click to show active' : 'Show archived sessions';
    return `<div class="session-search-wrap">
      <div class="session-search-container" onmouseenter="Sessions._cancelHideHistoryDropdown()" onmouseleave="Sessions._hideHistoryDropdownDelayed()">
        <input type="text" class="session-search" id="session-search-input"
          placeholder="Search sessions..."
          oninput="Sessions._hideHistoryDropdown(); Sessions.onSearch('${slug}', this.value)"
          onfocus="Sessions.showHistory('${slug}')"
          onblur="Sessions._hideHistoryDropdownDelayed()">
        <div class="search-history-dropdown" id="search-history-dropdown" style="display:none"></div>
      </div>
      <button class="${archivedBtnClass}" title="${archivedBtnTitle}" onclick="Sessions.toggleArchived('${slug}')">Archive</button>
      <div class="action-menu">
        <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)">New Session &#9662;</button>
        <div class="action-menu-panel">
          <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.newSessionOS('${slug}')">In OS terminal</button>
          <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.newSessionBrowser('${slug}')">In browser terminal</button>
        </div>
      </div>
    </div>`;
  },

  _getHistory(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); }
    catch (_) { return []; }
  },

  _saveToHistory(q, key) {
    let h = Sessions._getHistory(key).filter(e => e.q !== q);
    h.unshift({ q, ts: Date.now() });
    if (h.length > 50) h = h.slice(0, 50);
    localStorage.setItem(key, JSON.stringify(h));
  },

  _saveToHistoryDebounced: debounce(function(q, key) {
    Sessions._saveToHistory(q, key);
  }, 1500),

  _removeFromHistory(q) {
    const key = Sessions._searchKey(Sessions._historySlug);
    const h = Sessions._getHistory(key).filter(e => e.q !== q);
    localStorage.setItem(key, JSON.stringify(h));
    Sessions._renderHistoryDropdown(Sessions._historySlug);
  },

  _clearHistory() {
    localStorage.removeItem(Sessions._searchKey(Sessions._historySlug));
    Sessions._hideHistoryDropdown();
  },

  _removeFromDetailHistory(q) {
    const key = Sessions._detailSearchKey(Sessions.detailState.slug);
    const h = Sessions._getHistory(key).filter(e => e.q !== q);
    localStorage.setItem(key, JSON.stringify(h));
    Sessions._renderDetailHistoryDropdown();
  },

  _clearDetailHistory() {
    localStorage.removeItem(Sessions._detailSearchKey(Sessions.detailState.slug));
    Sessions._hideDetailHistoryDropdown();
  },

  _historySlug: null,

  showHistory(slug) {
    Sessions._historySlug = slug;
    Sessions._renderHistoryDropdown(slug);
  },

  showDetailHistory() {
    Sessions._renderDetailHistoryDropdown();
  },

  _relTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(diff / 3600000);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(diff / 86400000);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  },

  _renderHistoryInto(dropdownId, storageKey, applyHandler, removeHandler, clearHandler) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const h = Sessions._getHistory(storageKey);
    if (!h.length) { dropdown.style.display = 'none'; return; }

    const now = Date.now();
    const DAY = 86400000;
    const groups = [
      { label: 'Today',     items: h.filter(e => now - e.ts < DAY) },
      { label: 'Yesterday', items: h.filter(e => now - e.ts >= DAY && now - e.ts < 2 * DAY) },
      { label: 'This week', items: h.filter(e => now - e.ts >= 2 * DAY && now - e.ts < 7 * DAY) },
      { label: 'Older',     items: h.filter(e => now - e.ts >= 7 * DAY) },
    ].filter(g => g.items.length);

    let html = '';
    for (const g of groups) {
      html += `<div class="search-history-group">${escapeHtml(g.label)}</div>`;
      for (const e of g.items) {
        html += `<div class="search-history-item" data-query="${escapeHtml(e.q)}" onmousedown="${applyHandler}">
          <span class="search-history-icon">&#128269;</span>
          <span class="search-history-query">${escapeHtml(e.q)}</span>
          <span class="search-history-time">${escapeHtml(Sessions._relTime(e.ts))}</span>
          <button class="search-history-remove" data-query="${escapeHtml(e.q)}" onmousedown="event.stopPropagation(); ${removeHandler}(this.dataset.query)" title="Remove">&#10005;</button>
        </div>`;
      }
    }
    html += `<div class="search-history-clear"><button onmousedown="event.stopPropagation(); ${clearHandler}()">Clear history</button></div>`;

    dropdown.innerHTML = html;
    dropdown.style.display = 'block';
  },

  _renderHistoryDropdown(slug) {
    Sessions._renderHistoryInto(
      'search-history-dropdown',
      Sessions._searchKey(slug),
      `Sessions._applyHistory(event, '${slug}', this)`,
      'Sessions._removeFromHistory',
      'Sessions._clearHistory'
    );
  },

  _renderDetailHistoryDropdown() {
    Sessions._renderHistoryInto(
      'detail-search-history-dropdown',
      Sessions._detailSearchKey(Sessions.detailState.slug),
      'Sessions._applyDetailHistory(event, this)',
      'Sessions._removeFromDetailHistory',
      'Sessions._clearDetailHistory'
    );
  },

  _applyHistory(event, slug, el) {
    event.preventDefault();
    const q = el.dataset.query;
    const input = document.getElementById('session-search-input');
    if (input) { input.value = q; input.blur(); }
    Sessions._hideHistoryDropdown();
    Sessions.onSearch(slug, q);
  },

  _applyDetailHistory(event, el) {
    event.preventDefault();
    const q = el.dataset.query;
    const input = document.getElementById('session-detail-search-input');
    if (input) { input.value = q; input.blur(); }
    Sessions._hideDetailHistoryDropdown();
    Sessions.onDetailSearch(q);
  },

  _hideHistoryDropdown() {
    const dropdown = document.getElementById('search-history-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  },

  _hideDetailHistoryDropdown() {
    const dropdown = document.getElementById('detail-search-history-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  },

  _hideHistoryDropdownDelayed() {
    clearTimeout(Sessions._hideHistoryTimer);
    Sessions._hideHistoryTimer = setTimeout(() => Sessions._hideHistoryDropdown(), 150);
  },

  _cancelHideHistoryDropdown() {
    clearTimeout(Sessions._hideHistoryTimer);
  },

  _hideDetailHistoryDropdownDelayed() {
    clearTimeout(Sessions._hideDetailHistoryTimer);
    Sessions._hideDetailHistoryTimer = setTimeout(() => Sessions._hideDetailHistoryDropdown(), 150);
  },

  _cancelHideDetailHistoryDropdown() {
    clearTimeout(Sessions._hideDetailHistoryTimer);
  },

  renderList(slug, sessions) {
    const btn = document.getElementById('sessions-tab-btn');
    if (btn) {
      const total = (Sessions.cache[slug] || []).length;
      const count = sessions.length;
      btn.textContent = (total !== count)
        ? `Sessions (${count}/${total})`
        : count > 0 ? `Sessions (${count})` : 'Sessions';
    }
    const container = document.getElementById('sessions-list');
    if (sessions.length === 0) {
      container.innerHTML = Sessions.renderSearchBar(slug) +
        '<div class="empty-state"><p>No sessions found</p></div>';
      return;
    }

    const { groups, ungrouped } = Sessions.groupSessions(sessions);
    Sessions._renderedGroups = groups;
    const collapsed = Sessions._getCollapsed();
    const allSessions = Sessions.cache[slug] || sessions;

    const items = [
      ...groups.map((g, idx) => ({ isGroup: true, g, idx, date: new Date(g.sessions[g.sessions.length - 1].modified || 0) })),
      ...ungrouped.map(s => ({ isGroup: false, s, date: new Date(s.modified || 0) }))
    ].sort((a, b) => b.date - a.date);

    let html = Sessions.renderSearchBar(slug);
    items.forEach((item, i) => {
      if (item.isGroup) {
        html += Sessions.renderGroup(slug, item.g, collapsed, item.idx);
      } else {
        const ci = allSessions.findIndex(x => x.sessionId === item.s.sessionId);
        html += Sessions.renderCard(slug, item.s, ci >= 0 ? ci : i);
      }
    });

    container.innerHTML = html;
    if (Sessions._planSessionIds === null) {
      Sessions.annotatePlans(Sessions.cache[slug] || sessions);
    }
  },

  renderCard(slug, s, i) {
    const snippetsHtml = (s.snippets || []).map(sn => {
      const label = sn.label ? `<span class="snippet-label">${escapeHtml(sn.label)}</span> ` : '';
      const roleTag = sn.role === 'user' ? 'You' : sn.role === 'assistant' ? 'Claude' : '';
      const roleHtml = roleTag ? `<span class="snippet-role snippet-role-${sn.role}">${roleTag}</span> ` : '';
      return `<div class="session-snippet snippet-${sn.role}">${roleHtml}${label}${Sessions.highlightMatch(sn.text, Sessions._lastQuery)}</div>`;
    }).join('');
    const cached = Sessions.cache[slug] || [];
    const correctIndex = cached.findIndex(x => x.sessionId === s.sessionId);
    const hasPlan = !!(Sessions._planSessionIds && Sessions._planSessionIds.has(s.sessionId));
    return renderSessionCard(s, {
      onclick: `Sessions.open('${slug}', '${s.sessionId}', ${correctIndex >= 0 ? correctIndex : i})`,
      slug,
      dates: true,
      sidechain: true,
      snippets: snippetsHtml,
      hasPlan,
      archived: Sessions._showArchived
    });
  },

  _lastQuery: '',

  highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const qEscaped = escapeHtml(query);
    const re = new RegExp('(' + qEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  },

  onSearch: debounce(async function(slug, value) {
    const q = value.trim();
    Sessions._lastQuery = q;
    if (q.length >= 2) Sessions._saveToHistoryDebounced(q, Sessions._searchKey(slug));

    if (q.length < 2) {
      if (Sessions.cache[slug]) {
        const searchInput = document.getElementById('session-search-input');
        const cursorPos = searchInput?.selectionStart;
        Sessions.rerenderWithFilter();
        const newInput = document.getElementById('session-search-input');
        if (newInput) { newInput.value = value; newInput.focus(); newInput.selectionStart = newInput.selectionEnd = cursorPos; }
      }
      return;
    }

    try {
      let results = await api(`/api/projects/${slug}/sessions/search?q=${encodeURIComponent(q)}`);
      if (Sessions._lastQuery !== q) return;
      results = Sessions.filterByDateRange(results);
      if (Sessions._planFilter && Sessions._planSessionIds) {
        results = results.filter(s => Sessions._planSessionIds.has(s.sessionId));
      }
      const container = document.getElementById('sessions-list');
      const searchInput = document.getElementById('session-search-input');
      const cursorPos = searchInput?.selectionStart;
      if (results.length === 0) {
        container.innerHTML = Sessions.renderSearchBar(slug) +
          '<div class="empty-state"><p>No sessions match your search</p></div>';
      } else {
        container.innerHTML = Sessions.renderSearchBar(slug) +
          results.map((s, i) => Sessions.renderCard(slug, s, i)).join('');
        Sessions.annotatePlans(results);
      }
      const newInput = document.getElementById('session-search-input');
      if (newInput) { newInput.value = value; newInput.focus(); newInput.selectionStart = newInput.selectionEnd = cursorPos; }
    } catch (e) {
      toast('Search failed', 'error');
    }
  }, 500),

  open(slug, sessionId, index) {
    Sessions.stopAutoRefresh();
    if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()) TerminalPanel.close();
    const sessions = Sessions.cache[slug] || [];
    App.navigate('session-detail', { slug, sessionId, sessionInfo: sessions[index] });
  },

  goBack() {
    Sessions.stopAutoRefresh();
    const slug = App.currentProject;
    App.navigate('project-detail', { slug });
  },

  detailState: { slug: null, sessionId: null, offset: 0, loading: false, hasMore: false, total: 0 },
  _detailHasPlan: false,
  REFRESH_INTERVAL_KEY: 'claude-manager-conversation-refresh-ms',
  REFRESH_INTERVAL_DEFAULT_MS: 5000,
  REFRESH_INTERVAL_MIN_MS: 1000,
  CONVERSATION_HIDDEN_KEY: 'claude-manager-conversation-hidden',
  SHOW_TOOL_DETAILS_KEY: 'claude-manager-show-tool-details',
  _refreshTimer: null,

  refreshIntervalMs() {
    const raw = parseInt(localStorage.getItem(Sessions.REFRESH_INTERVAL_KEY), 10);
    if (Number.isFinite(raw) && raw >= Sessions.REFRESH_INTERVAL_MIN_MS) return raw;
    return Sessions.REFRESH_INTERVAL_DEFAULT_MS;
  },

  setRefreshIntervalMs(ms) {
    if (!Number.isFinite(ms) || ms < Sessions.REFRESH_INTERVAL_MIN_MS) return false;
    localStorage.setItem(Sessions.REFRESH_INTERVAL_KEY, String(ms));
    if (Sessions._refreshTimer && !Sessions.isConversationHidden()) Sessions.startAutoRefresh();
    if (Sessions._ctxTimer) Sessions.startCtxPolling();
    return true;
  },

  isConversationHidden() {
    return localStorage.getItem(Sessions.CONVERSATION_HIDDEN_KEY) === '1';
  },

  applyConversationHiddenState() {
    const body = document.getElementById('session-detail-body');
    if (body) body.classList.toggle('conversation-hidden', Sessions.isConversationHidden());
  },

  showToolDetails() {
    return localStorage.getItem(Sessions.SHOW_TOOL_DETAILS_KEY) === '1';
  },

  applyToolDetailsState() {
    const container = document.getElementById('session-messages');
    if (container) container.classList.toggle('tools-hidden', !Sessions.showToolDetails());
    const checkbox = document.getElementById('session-detail-show-tools');
    if (checkbox) checkbox.checked = Sessions.showToolDetails();
  },

  setShowToolDetails(checked) {
    localStorage.setItem(Sessions.SHOW_TOOL_DETAILS_KEY, checked ? '1' : '0');
    Sessions.applyToolDetailsState();
    Sessions.updateMessageCount();
    if (Sessions._detailSearchQuery) Sessions.applyDetailFilter(Sessions._detailSearchQuery);
  },

  updateMessageCount() {
    const countEl = document.getElementById('session-count');
    if (!countEl) return;
    const state = Sessions.detailState;
    if (!state.total) { countEl.textContent = ''; return; }
    const container = document.getElementById('session-messages');
    const showTools = Sessions.showToolDetails();
    const toolOnly = container ? container.querySelectorAll('.chat-msg-tools-only').length : 0;
    if (!showTools && toolOnly) {
      const visible = state.offset - toolOnly;
      countEl.textContent = `Showing ${visible} of ${state.total} messages (${state.offset} with tool details)`;
    } else {
      countEl.textContent = `Showing ${state.offset} of ${state.total} messages`;
    }
  },

  renderDetailMeta(stats) {
    const meta = document.getElementById('session-detail-meta');
    if (!meta) return;
    const info = Sessions._detailInfo || {};
    const merged = Object.assign({}, info, stats || {});
    if (stats) Sessions._detailInfo = merged;

    // Fill title from stats when navigated without info (e.g. from dashboard)
    const title = document.getElementById('session-detail-title');
    if (title && title.textContent === 'Session' && (merged.summary || merged.firstPrompt)) {
      const titleText = merged.summary || merged.firstPrompt.slice(0, 80);
      title.textContent = titleText;
      title.title = titleText;
    }

    const slug = Sessions.detailState.slug;
    const projectHtml = slug
      ? `<span class="session-project-chip" onclick="Sessions.goBack()" title="Go to project">${escapeHtml(decodeName(slug))}</span>`
      : '';
    const createdHtml = merged.created
      ? `<div class="meta-item">Created <span class="meta-value">${new Date(merged.created).toLocaleString()}</span></div>`
      : '';
    const planBadge = Sessions._detailHasPlan
      ? '<span class="session-plan-badge" title="Plans were active during this session">plan</span>'
      : '';
    const remoteIconEl = document.getElementById('session-detail-remote-icon');
    if (remoteIconEl) {
      remoteIconEl.innerHTML = merged.remoteControlled
        ? `<span class="session-remote-icon" title="Remote-controlled session">
            <svg viewBox="0 0 16 16" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 5.5a5 5 0 0 1 9 0"/><path d="M5.5 7.5a2.5 2.5 0 0 1 5 0"/>
              <circle cx="8" cy="9.5" r="0.9" fill="currentColor" stroke="none"/>
            </svg>
          </span>`
        : '';
    }
    meta.innerHTML = projectHtml + planBadge + createdHtml + renderSessionBadges(merged, { sidechain: true, modelPricing: true, skipBranches: true });

    Sessions.renderDetailBranches(merged);
    if (merged.lastGitBranch) Sessions.detailState.lastGitBranch = merged.lastGitBranch;
    Sessions.updateBranchWarning(Sessions.detailState.lastGitBranch || merged.lastGitBranch);

    if (stats && typeof stats.archived !== 'undefined' && stats.archived) {
      Sessions._setDetailArchivedUI(stats.active);
    }
  },

  updateBranchWarning(lastGitBranch) {
    const el = document.getElementById('session-branch-warning');
    if (!el) return;
    if (typeof GitActions === 'undefined' || !GitActions._info || !GitActions._info.available) {
      el.style.display = 'none';
      return;
    }
    const projectBranch = GitActions._info.branch;
    if (lastGitBranch && projectBranch && lastGitBranch !== projectBranch) {
      el.innerHTML = `<span class="branch-warn-icon">&#9888;</span> <strong>WARNING!!!</strong> This session was on branch <code>${escapeHtml(lastGitBranch)}</code> but the project is currently on <code>${escapeHtml(projectBranch)}</code>. Switch to the correct branch before continuing, or you may be working in the wrong context.`;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  },

  renderDetailBranches(s) {
    const el = document.getElementById('session-detail-branches');
    if (!el) return;
    let branches = Array.isArray(s.gitBranches) ? s.gitBranches.filter(Boolean) : [];
    if (!branches.length) {
      branches = Array.from(new Set([s.gitBranch, s.lastGitBranch].filter(Boolean)));
    }
    const wrap = document.getElementById('session-detail-branches-wrap');
    if (!branches.length) {
      el.innerHTML = '';
      if (wrap) wrap.style.display = 'none';
      return;
    }
    const parts = [];
    branches.forEach((b, i) => {
      if (i > 0) parts.push('<span class="session-branch-arrow">&#8594;</span>');
      parts.push(`<span class="session-branch">${escapeHtml(b)}</span>`);
    });
    el.innerHTML = parts.join('');
    if (wrap) wrap.style.display = 'flex';
  },

  async loadDetail(slug, sessionId, info) {
    const title = document.getElementById('session-detail-title');
    const container = document.getElementById('session-messages');

    const titleText = info?.summary || info?.firstPrompt?.slice(0, 80) || 'Session';
    title.textContent = titleText;
    title.title = titleText;
    Sessions._detailInfo = info || {};
    Sessions._detailHasPlan = false;
    Sessions.detailState = { slug, sessionId, offset: 0, loading: false, hasMore: false, total: 0 };
    Sessions.renderDetailMeta(null);

    const idValue = document.getElementById('session-detail-id-value');
    if (idValue) {
      idValue.textContent = sessionId || '';
      idValue.style.display = sessionId ? 'inline-block' : 'none';
    }

    Sessions._pendingFlash = undefined;
    Sessions._ctx = null;
    Sessions._ctxCollapsed = new Set();
    Sessions._clearDetailArchivedUI();
    Sessions._activityLoaded = false;
    Sessions._activityItems = [];
    Sessions._activityFilter = null;
    Sessions._scratchpadLoaded = false;
    if (typeof SessionFiles !== 'undefined') SessionFiles.reset(slug);
    container.innerHTML = '';

    // Reset search
    Sessions._detailSearchQuery = '';
    const searchInput = document.getElementById('session-detail-search-input');
    if (searchInput) searchInput.value = '';
    const countEl = document.getElementById('session-detail-search-count');
    if (countEl) countEl.textContent = '';

    if (!sessionId) {
      Sessions.switchTab('conversation');
      container.innerHTML = '<div class="empty-state"><p>Waiting for session to start...</p></div>';
      const ctxEl = document.getElementById('sf-changed');
      if (ctxEl) ctxEl.innerHTML = '';
      const spEl = document.getElementById('session-scratchpad');
      if (spEl) spEl.innerHTML = '';
      if (typeof TerminalPanel !== 'undefined') {
        if (TerminalPanel.isOpen()) TerminalPanel.close();
        TerminalPanel.open(slug, null);
      }
      Sessions.applyConversationHiddenState();
      Sessions.applyToolDetailsState();
      Sessions._startDiscovery(slug);
      return;
    }

    // Start on the Files tab; loadContext will switch to Conversation if nothing changed
    Sessions.switchTab('file-changes');
    const ctxEl = document.getElementById('sf-changed');
    if (ctxEl) { ctxEl.innerHTML = ''; }
    const spEl = document.getElementById('session-scratchpad');
    if (spEl) { spEl.innerHTML = ''; }
    Sessions.loadContext(sessionId, info);

    await Sessions.loadMore();
    Sessions.setupScroll();

    if (typeof TerminalPanel !== 'undefined' && TerminalPanel.shouldAutoOpen() && !TerminalPanel.isOpen()) {
      TerminalPanel.open(slug, sessionId);
    }

    Sessions.applyConversationHiddenState();
    Sessions.applyToolDetailsState();
    if (!Sessions.isConversationHidden()) Sessions.startAutoRefresh();
    Sessions.startCtxPolling();
  },

  startAutoRefresh() {
    Sessions.stopConversationRefresh();
    if (Sessions.isConversationHidden()) return;
    Sessions._refreshTimer = setInterval(() => Sessions.pollNewMessages(), Sessions.refreshIntervalMs());
    if (typeof setFooterStatus === 'function') {
      const sec = Math.round(Sessions.refreshIntervalMs() / 1000);
      setFooterStatus(`Live · refresh ${sec}s`, true);
    }
  },

  startCtxPolling() {
    Sessions.stopCtxPolling();
    Sessions._ctxTimer = setInterval(() => {
      const { slug, sessionId } = Sessions.detailState;
      if (!slug || !sessionId) return;
      Sessions.pollContext(slug, sessionId);
      Sessions.pollScratchpad();
    }, Sessions.refreshIntervalMs());
  },

  stopConversationRefresh() {
    if (Sessions._refreshTimer) { clearInterval(Sessions._refreshTimer); Sessions._refreshTimer = null; }
    if (typeof setFooterStatus === 'function') setFooterStatus('Idle', false);
  },

  stopCtxPolling() {
    if (Sessions._ctxTimer) { clearInterval(Sessions._ctxTimer); Sessions._ctxTimer = null; }
  },

  stopAutoRefresh() {
    Sessions._stopDiscovery();
    Sessions.stopConversationRefresh();
    Sessions.stopCtxPolling();
  },

  _startDiscovery(slug) {
    Sessions._stopDiscovery();
    Sessions._discoverTimer = setInterval(async () => {
      try {
        const sessions = await api(`/api/projects/${slug}/sessions`);
        const state = Sessions.detailState;
        if (!state.slug || state.sessionId) { Sessions._stopDiscovery(); return; }
        const found = (sessions || []).find(s => !Sessions._knownSessionIds.has(s.sessionId));
        if (found) {
          Sessions._stopDiscovery();
          Sessions._onSessionDiscovered(found);
        }
      } catch (_) {}
    }, 3000);
  },

  _stopDiscovery() {
    if (Sessions._discoverTimer) { clearInterval(Sessions._discoverTimer); Sessions._discoverTimer = null; }
  },

  _onSessionDiscovered(session) {
    const state = Sessions.detailState;
    state.sessionId = session.sessionId;
    if (typeof TerminalPanel !== 'undefined') TerminalPanel.notifySessionId(session.sessionId);
    const idValue = document.getElementById('session-detail-id-value');
    if (idValue) { idValue.textContent = session.sessionId; idValue.style.display = 'inline-block'; }
    App.setHash('session-detail', { slug: state.slug, sessionId: session.sessionId });
    const container = document.getElementById('session-messages');
    if (container) container.innerHTML = '';
    Sessions.loadContext(session.sessionId, session);
    Sessions.loadMore().then(() => {
      Sessions.setupScroll();
      if (!Sessions.isConversationHidden()) Sessions.startAutoRefresh();
      Sessions.startCtxPolling();
    });
  },

  async pollNewMessages() {
    const state = Sessions.detailState;
    if (!state.slug || !state.sessionId) return;
    if (state.loading) return;
    if (Sessions.isConversationHidden()) return;
    if (Sessions._detailSearchQuery) return; // don't disturb active filter
    const slugAtStart = state.slug;
    const sessionAtStart = state.sessionId;

    try {
      const data = await api(`/api/projects/${slugAtStart}/sessions/${sessionAtStart}?offset=0&limit=20`);
      if (state.slug !== slugAtStart || state.sessionId !== sessionAtStart) return;

      if (data.stats) {
        Sessions.renderDetailMeta(data.stats);
        Sessions.annotateDetailPlan(data.stats);
      }

      if (typeof GitActions !== 'undefined') GitActions.refresh().then(() => {
        const state2 = Sessions.detailState;
        if (state2.slug === slugAtStart && state2.sessionId === sessionAtStart) {
          Sessions.updateBranchWarning((data.stats || {}).lastGitBranch);
        }
      }).catch(() => {});

      if (typeof data.total === 'number' && data.total > state.total) {
        Sessions.refreshActivity();
      }
      if (typeof data.total !== 'number' || data.total <= state.total) return;

      const added = data.total - state.total;
      const newMessages = data.messages.slice(0, added);
      const html = newMessages.map(m => Sessions.renderMessage(m)).join('');

      const container = document.getElementById('session-messages');
      if (!container) return;
      container.insertAdjacentHTML('afterbegin', html);
      addCodeCopyButtons(container);

      state.total = data.total;
      state.offset += added;

      Sessions.updateMessageCount();
    } catch (_) { /* silent — transient network error */ }
  },

  scrollContainer() {
    return document.getElementById('session-messages-pane')
      || document.querySelector('#view-session-detail .view-body');
  },

  setupScroll() {
    const scroller = Sessions.scrollContainer();
    if (!scroller) return;
    if (Sessions._scrollHandler && Sessions._scrollTarget) {
      Sessions._scrollTarget.removeEventListener('scroll', Sessions._scrollHandler);
    }
    const topBtn = document.getElementById('scroll-to-top-btn');
    if (topBtn) topBtn.classList.remove('visible');
    Sessions._scrollHandler = () => {
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      if (topBtn) topBtn.classList.toggle('visible', scrollTop > 400);
      if (Sessions.detailState.loading || !Sessions.detailState.hasMore) return;
      if (scrollTop + clientHeight >= scrollHeight - 300) {
        Sessions.loadMore();
      }
    };
    Sessions._scrollTarget = scroller;
    scroller.addEventListener('scroll', Sessions._scrollHandler);
  },

  scrollToTop() {
    const scroller = Sessions.scrollContainer();
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  },

  async loadMore() {
    const state = Sessions.detailState;
    if (state.loading) return;
    state.loading = true;

    const container = document.getElementById('session-messages');

    // Show loader at bottom
    let loader = document.getElementById('session-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'session-loader';
      loader.className = 'loading';
      loader.innerHTML = '<div class="spinner"></div> Loading...';
    }
    container.appendChild(loader);

    try {
      const data = await api(`/api/projects/${state.slug}/sessions/${state.sessionId}?offset=${state.offset}&limit=20`);
      loader.remove();

      if (Sessions.detailState !== state) return;

      if (data.total === 0 && state.offset === 0) {
        container.innerHTML = '<div class="empty-state"><p>No messages in this session</p></div>';
        return;
      }

      state.total = data.total;
      state.hasMore = data.hasMore;
      state.offset += data.messages.length;

      if (data.stats) {
        Sessions.renderDetailMeta(data.stats);
        Sessions.annotateDetailPlan(data.stats);
      }

      const html = data.messages.map(m => Sessions.renderMessage(m)).join('');
      container.insertAdjacentHTML('beforeend', html);
      addCodeCopyButtons(container);

      Sessions.updateMessageCount();

      // Remove old load-more button
      const oldBtn = document.getElementById('load-more-btn');
      if (oldBtn) oldBtn.remove();

      if (data.hasMore) {
        const btn = document.createElement('button');
        btn.id = 'load-more-btn';
        btn.className = 'btn';
        btn.style.cssText = 'width:100%;margin-top:12px';
        btn.textContent = `Load more (${state.total - state.offset} remaining)`;
        btn.onclick = () => Sessions.loadMore();
        container.appendChild(btn);
      }

      // Re-apply active search to newly loaded messages
      if (Sessions._detailSearchQuery) {
        Sessions.applyDetailFilter(Sessions._detailSearchQuery);
      }
    } catch (e) {
      loader.textContent = 'Failed to load messages';
    } finally {
      state.loading = false;
    }
  },

  async checkPricing() {
    try {
      await api('/api/pricing/fetch', { method: 'POST' });
    } catch (_) {
      toast('Pricing check failed — using cached data', 'error');
    }
  },

  async newSessionOS(slug) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    try {
      await Sessions.checkPricing();
      await api(`/api/projects/${slug}/sessions/new`, { method: 'POST' });
      toast('New session opened');
      if (typeof ActiveSessionsBar !== 'undefined') ActiveSessionsBar.poll();
    } catch (e) {
      toast('Failed to open terminal: ' + e.message, 'error');
    }
  },

  async newSessionBrowser(slug) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    try { await Sessions.checkPricing(); } catch (_) { /* non-fatal */ }
    if (typeof TerminalPanel === 'undefined') {
      toast('Terminal libraries not loaded', 'error');
      return;
    }
    try {
      const existing = await api(`/api/projects/${slug}/sessions`);
      Sessions._knownSessionIds = new Set((existing || []).map(s => s.sessionId));
    } catch (_) {
      Sessions._knownSessionIds = new Set();
    }
    TerminalPanel.setAutoOpen(true);
    App.navigate('session-detail', { slug, sessionId: null });
  },

  async resumeOS(slug, sessionId) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    try {
      await Sessions.checkPricing();
      await api(`/api/projects/${slug}/sessions/${sessionId}/resume`, { method: 'POST' });
      if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()) {
        TerminalPanel.setAutoOpen(false);
        TerminalPanel.close();
      }
      toast('Terminal opened with session');
      if (typeof ActiveSessionsBar !== 'undefined') ActiveSessionsBar.poll();
    } catch (e) {
      toast('Failed to open terminal: ' + e.message, 'error');
    }
  },

  async resumeBrowser(slug, sessionId) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    try {
      await Sessions.checkPricing();
    } catch (_) { /* non-fatal */ }
    if (typeof TerminalPanel !== 'undefined') TerminalPanel.setAutoOpen(true);
    const cached = Sessions.cache[slug] || [];
    const info = cached.find(s => s.sessionId === sessionId);
    App.navigate('session-detail', { slug, sessionId, sessionInfo: info });
  },

  resumeFromMenu() {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    Sessions.resumeOS(slug, sessionId);
  },

  toggleActionMenu(btn) {
    const panel = btn.nextElementSibling;
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    if (!isOpen) panel.classList.add('open');
  },

  renameAction(btn) {
    Sessions.openRenameModal(btn.dataset.slug, btn.dataset.session, btn.dataset.title || '');
  },

  copyIdAction(sessionId) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    if (!sessionId) { toast('No session ID', 'error'); return; }
    copyToClipboard(sessionId, 'Session ID copied');
  },

  copyIdDetail() {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    const id = Sessions.detailState.sessionId;
    if (!id) { toast('No session ID', 'error'); return; }
    copyToClipboard(id, 'Session ID copied');
  },

  renameDetail() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    const current = document.getElementById('session-detail-title')?.textContent || '';
    Sessions.openRenameModal(slug, sessionId, current === 'Session' ? '' : current);
  },

  openRenameModal(slug, sessionId, currentTitle) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    openModal({
      title: 'Rename session',
      body: formGroup('Title', `<input type="text" id="rename-session-title" maxlength="500" value="${escapeHtml(currentTitle)}" style="width:100%">`),
      buttons: [{
        label: 'Save',
        primary: true,
        onClick: async () => {
          const title = document.getElementById('rename-session-title').value.trim();
          if (!title) { toast('Title is required', 'error'); return false; }
          try {
            await api(`/api/projects/${slug}/sessions/${sessionId}/rename`, {
              method: 'POST',
              body: { title }
            });
            toast('Session renamed');
            Sessions.applyRename(slug, sessionId, title);
          } catch (e) {
            toast('Rename failed: ' + e.message, 'error');
            return false;
          }
        }
      }]
    });
    setTimeout(() => document.getElementById('rename-session-title')?.focus(), 0);
  },

  applyRename(slug, sessionId, title) {
    const cached = Sessions.cache[slug];
    if (cached) {
      const s = cached.find(x => x.sessionId === sessionId);
      if (s) s.summary = title;
    }
    if (Sessions.detailState.slug === slug && Sessions.detailState.sessionId === sessionId) {
      const el = document.getElementById('session-detail-title');
      if (el) { el.textContent = title; el.title = title; }
    }
    document.querySelectorAll(`.session-card[data-session-id="${sessionId}"] .session-summary`).forEach(el => {
      el.textContent = title;
    });
    document.querySelectorAll(`.session-card[data-session-id="${sessionId}"] .action-menu-item[data-session="${sessionId}"]`).forEach(btn => {
      btn.dataset.title = title;
    });
  },

  switchTab(tab) {
    const ctx = document.getElementById('session-context');
    const msgs = document.getElementById('session-messages-wrap');
    const act = document.getElementById('session-activity');
    const sp = document.getElementById('session-scratchpad');
    const fcBtn = document.getElementById('tab-btn-file-changes');
    const cvBtn = document.getElementById('tab-btn-conversation');
    const acBtn = document.getElementById('tab-btn-activity');
    const spBtn = document.getElementById('tab-btn-scratchpad');
    if (!ctx || !msgs || !fcBtn || !cvBtn) return;
    const isFC = tab === 'file-changes';
    const isAct = tab === 'activity';
    const isSP = tab === 'scratchpad';
    ctx.style.display = isFC ? 'flex' : 'none';
    msgs.style.display = isAct || isFC || isSP ? 'none' : '';
    if (act) act.style.display = isAct ? 'flex' : 'none';
    if (sp) sp.style.display = isSP ? 'flex' : 'none';
    fcBtn.classList.toggle('active', isFC);
    cvBtn.classList.toggle('active', !isFC && !isAct && !isSP);
    if (acBtn) acBtn.classList.toggle('active', isAct);
    if (spBtn) spBtn.classList.toggle('active', isSP);
    if (isFC && Sessions._pendingFlash !== undefined) {
      const pending = Sessions._pendingFlash;
      Sessions._pendingFlash = undefined;
      Sessions._flashItems(ctx, pending);
    }
    if (isFC && typeof SessionFiles !== 'undefined') {
      if (!SessionFiles.treeLoaded) SessionFiles.loadTree();
      if (SessionFiles.editor) SessionFiles.editor.refresh();
    }
    if (isAct && !Sessions._activityLoaded) Sessions.loadActivity();
    if (isSP && !Sessions._scratchpadLoaded) Sessions.loadScratchpad();
  },

  _rerenderPlans() {
    const slug = Sessions._searchSlug;
    const projectView = document.getElementById('view-project-detail');
    if (slug && Sessions.cache[slug] && projectView && projectView.classList.contains('active') && !Sessions._lastQuery) {
      Sessions.rerenderWithFilter();
      return;
    }
    const ids = Sessions._planSessionIds;
    if (!ids || !ids.size) return;
    for (const sessionId of ids) {
      const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
      if (!card || card.querySelector('.session-plan-badge')) continue;
      const meta = card.querySelector('.session-meta');
      if (meta) meta.insertAdjacentHTML('afterbegin', '<span class="session-plan-badge" title="Plans were active during this session">plan</span>');
    }
  },

};

document.addEventListener('click', () => {
  document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
});

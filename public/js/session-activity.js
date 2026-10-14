Object.assign(Sessions, {
  _activityItems: [],
  _activityFilter: null,
  _activityLoaded: false,

  async loadActivity() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;

    const panel = document.getElementById('session-activity');
    if (!panel) return;
    panel.innerHTML = '<div class="loading"><div class="spinner"></div> Loading activity...</div>';
    Sessions._activityLoaded = false;

    try {
      const data = await api(`/api/projects/${slug}/sessions/${sessionId}/activity`);
      Sessions._activityItems = (data.items || []).reverse();
      Sessions._activityFilter = null;
      Sessions._activityLoaded = true;
      Sessions._renderActivity(data);
    } catch (_) {
      panel.innerHTML = '<div class="empty-state"><p>Could not load activity</p></div>';
    }
  },

  async refreshActivity() {
    const panel = document.getElementById('session-activity');
    if (!panel || panel.style.display === 'none') return;
    if (!Sessions._activityLoaded) return;
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    try {
      const data = await api(`/api/projects/${slug}/sessions/${sessionId}/activity`);
      Sessions._activityItems = (data.items || []).reverse();
      const prevFilter = Sessions._activityFilter;
      Sessions._renderActivity(data);
      if (prevFilter) Sessions._applyActivityFilter(prevFilter);
    } catch (_) {}
  },

  _renderActivity(data) {
    const panel = document.getElementById('session-activity');
    if (!panel) return;
    const items = data.items || [];
    const stats = data.stats || {};

    if (items.length === 0) {
      panel.innerHTML = '<div class="empty-state"><p>No tool calls recorded in this session</p></div>';
      return;
    }

    const cats = [
      { key: '', label: 'All', count: stats.total || 0 },
      { key: 'agent', label: 'Agents', count: stats.byCategory?.agent || 0 },
      { key: 'web', label: 'Web', count: stats.byCategory?.web || 0 },
      { key: 'shell', label: 'Shell', count: stats.byCategory?.shell || 0 },
      { key: 'file', label: 'Files', count: stats.byCategory?.file || 0 },
      { key: 'other', label: 'Other', count: stats.byCategory?.other || 0 }
    ].filter(c => c.key === '' || c.count > 0);

    const filterBar = cats.map(c =>
      `<button class="activity-filter-btn${(!Sessions._activityFilter && !c.key) || Sessions._activityFilter === c.key ? ' active' : ''}"
        data-cat="${escapeHtml(c.key)}"
        onclick="Sessions._applyActivityFilter(this.dataset.cat)">
        ${escapeHtml(c.label)} <span class="activity-filter-count">${c.count}</span>
      </button>`
    ).join('');

    panel.innerHTML = `
      <div class="activity-filter-bar">
        ${filterBar}
        <div class="activity-filter-spacer"></div>
        <button class="activity-toggle-btn" onclick="Sessions._setAllAgentGroups(false)" title="Collapse all agent groups">&#9654;&#9654;</button>
        <button class="activity-toggle-btn" onclick="Sessions._setAllAgentGroups(true)" title="Expand all agent groups">&#9660;&#9660;</button>
      </div>
      <div class="activity-list" id="activity-list"></div>
    `;
    Sessions._renderActivityList(Sessions._activityItems);
  },

  _applyActivityFilter(cat) {
    Sessions._activityFilter = cat || null;
    document.querySelectorAll('.activity-filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === (cat || ''));
    });
    const filtered = cat
      ? Sessions._activityItems.filter(item => item.category === cat)
      : Sessions._activityItems;
    Sessions._renderActivityList(filtered);
  },

  _renderActivityList(items) {
    const list = document.getElementById('activity-list');
    if (!list) return;
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No items in this category</p></div>';
      return;
    }

    // Separate main-session items from sub-agent items
    const mainItems = items.filter(i => !i.agentId);
    const subItems = items.filter(i => i.agentId);

    // Group sub-agent items by agentId, preserving first-appearance order
    const agentOrder = [];
    const agentGroups = {};
    for (const item of subItems) {
      if (!agentGroups[item.agentId]) {
        agentGroups[item.agentId] = { label: item.agentLabel || item.agentId, items: [] };
        agentOrder.push(item.agentId);
      }
      agentGroups[item.agentId].items.push(item);
    }

    let html = '';
    let idx = 0;

    // Main session items (no grouping, newest first)
    for (const item of mainItems) {
      html += Sessions._renderActivityItem(item, idx++);
    }

    // Sub-agent groups
    if (agentOrder.length > 0) {
      html += `<div class="activity-agents-heading">Sub-agents (${agentOrder.length})</div>`;
    }
    const autoExpand = agentOrder.length === 1;
    for (const agentId of agentOrder) {
      const group = agentGroups[agentId];
      const groupId = 'ag-' + agentId.slice(0, 12);
      const shortLabel = group.label.slice(0, 80) + (group.label.length > 80 ? '…' : '');
      const count = group.items.length;
      html += `
        <div class="activity-agent-group">
          <div class="activity-agent-header" data-group-id="${escapeHtml(groupId)}" onclick="Sessions._toggleAgentGroup(this.dataset.groupId)">
            <span class="activity-agent-arrow" id="${escapeHtml(groupId)}-arrow">${autoExpand ? '&#9660;' : '&#9654;'}</span>
            <span class="activity-agent-label" title="${escapeHtml(group.label)}">${escapeHtml(shortLabel)}</span>
            <span class="activity-filter-count">${count}</span>
          </div>
          <div class="activity-agent-body${autoExpand ? '' : ' collapsed'}" id="${escapeHtml(groupId)}">
            ${group.items.map(item => Sessions._renderActivityItem(item, idx++)).join('')}
          </div>
        </div>`;
    }

    list.innerHTML = html;
  },

  _toggleAgentGroup(groupId) {
    const body = document.getElementById(groupId);
    const arrow = document.getElementById(groupId + '-arrow');
    if (!body) return;
    const collapsed = body.classList.toggle('collapsed');
    if (arrow) arrow.innerHTML = collapsed ? '&#9654;' : '&#9660;';
  },

  _setAllAgentGroups(expanded) {
    document.querySelectorAll('.activity-agent-body').forEach(body => {
      body.classList.toggle('collapsed', !expanded);
      const arrow = document.getElementById(body.id + '-arrow');
      if (arrow) arrow.innerHTML = expanded ? '&#9660;' : '&#9654;';
    });
  },

  _renderActivityItem(item, i) {
    const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '';
    const label = item.label || '';
    let shortLabel = label;

    if (item.category === 'file') {
      shortLabel = label.split(/[/\\]/).pop() || label;
    } else if (item.tool === 'WebFetch') {
      try {
        const u = new URL(label);
        const p = u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname;
        shortLabel = u.hostname + p;
      } catch (_) {
        shortLabel = label.slice(0, 80);
      }
    } else {
      shortLabel = label.slice(0, 90) + (label.length > 90 ? '…' : '');
    }

    const isWebFetch = item.tool === 'WebFetch';
    const needsDetail = label.length > shortLabel.length || item.category === 'file';
    const detailContent = item.category === 'file'
      ? `<div class="activity-detail-path">${escapeHtml(label)}</div>`
      : `<pre class="tool-code">${escapeHtml(label)}</pre>`;
    const itemId = 'act-' + i;

    const labelHtml = isWebFetch
      ? `<a class="activity-item-label activity-item-link" href="${escapeHtml(label)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}" onclick="event.stopPropagation()">${escapeHtml(shortLabel)}</a>`
      : `<span class="activity-item-label" title="${escapeHtml(label)}">${escapeHtml(shortLabel)}</span>`;

    return `
      <div class="activity-item${needsDetail ? ' activity-item-expandable' : ''}" ${needsDetail ? `onclick="document.getElementById('${itemId}').classList.toggle('open')"` : ''}>
        <div class="activity-item-main">
          <span class="activity-tool-badge activity-cat-${escapeHtml(item.category)}">${escapeHtml(item.tool)}</span>
          ${labelHtml}
          ${item.category === 'shell' ? `<button class="icon-btn activity-copy-btn" title="Copy command" aria-label="Copy command" data-copy="${escapeHtml(label)}" onclick="event.stopPropagation(); copyToClipboard(this.dataset.copy, 'Command copied')">&#128203;</button>` : ''}
          <span class="activity-item-time">${time}</span>
        </div>
        ${needsDetail ? `<div class="activity-item-detail" id="${itemId}">${detailContent}</div>` : ''}
      </div>`;
  }
});

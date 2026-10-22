// --- Health Check ---
// Read-only checks of the Claude Code setup: invalid JSON, MCP servers that cannot start, skills
// that will not trigger well, oversized CLAUDE.md files, and stale or duplicate memories.

const Health = {
  AREAS: [
    { key: 'json', title: 'Settings files', hint: 'settings.json, .claude.json, .mcp.json and keybindings parse as JSON' },
    { key: 'mcp', title: 'MCP servers', hint: 'config only: each server’s command exists or its URL is valid — use Test connections for live status' },
    { key: 'skills', title: 'Skills', hint: 'every skill has SKILL.md and a description Claude can trigger on' },
    { key: 'claude-md', title: 'CLAUDE.md size', hint: 'no CLAUDE.md over 40k characters, which is sent with every request' },
    { key: 'memory', title: 'Memories', hint: 'MEMORY.md has no stale entries, every memory is indexed, no duplicates' }
  ],
  ICONS: { error: '✕', warn: '⚠', info: 'ℹ', ok: '✓' },
  live: null,
  liveRunning: false,

  async load() {
    const el = document.getElementById('health-body');
    if (!el) return;
    showLoading(el, 'Checking your setup...');
    try {
      const data = await api('/api/health');
      Health.data = data;
      el.innerHTML = Health.html(data, Health.live);
    } catch (e) {
      el.innerHTML = '';
      toast('Health check failed: ' + e.message, 'error');
    }
  },

  /** Where to fix a finding: the matching page, or the project for project-level items. */
  link(f) {
    if (f.slug) return '#project-detail/' + f.slug;
    if (f.area === 'mcp') return '#mcp-servers';
    if (f.area === 'skills') return '#skills';
    if (f.area === 'claude-md') return '#global-claude-md';
    if (f.area === 'json' && /settings(\.local)?\.json$/.test(f.location || '')) return '#settings';
    if (f.area === 'json' && /keybindings\.json$/.test(f.location || '')) return '#keybindings';
    return '';
  },

  rowHtml(f) {
    const link = Health.link(f);
    const scopeCls = f.scope === 'Global' ? 'mark-tip-scope mark-tip-global' : 'mark-tip-scope';
    return `<div class="health-row health-${escapeHtml(f.severity)}">
        <span class="health-icon" aria-label="${escapeHtml(f.severity)}">${Health.ICONS[f.severity] || ''}</span>
        <div class="health-main">
          <div class="health-title">${escapeHtml(f.title)} <span class="${scopeCls}">${escapeHtml(f.scope || '')}</span></div>
          <div class="health-detail">${escapeHtml(f.detail || '')}</div>
          ${f.location ? `<div class="health-location">${escapeHtml(f.location)}</div>` : ''}
        </div>
        ${link ? `<a class="btn btn-sm" href="${escapeHtml(link)}">Open</a>` : ''}
      </div>`;
  },

  /**
   * Live MCP status via `claude mcp list`: connects to each user, claude.ai and home-folder server
   * (starting them, as a Claude session would) — so it runs only when asked.
   */
  async testMcp() {
    if (Health.liveRunning) return;
    Health.liveRunning = true;
    Health.render();
    try {
      Health.live = await api('/api/health/mcp-live', { method: 'POST' });
    } catch (e) {
      Health.live = { error: e.message };
      toast('Connection test failed: ' + e.message, 'error');
    } finally {
      Health.liveRunning = false;
      Health.render();
    }
  },

  render() {
    const el = document.getElementById('health-body');
    if (el && Health.data) el.innerHTML = Health.html(Health.data, Health.live, Health.liveRunning);
  },

  /** The live connection results under the MCP section: every server with its status. */
  liveHtml(live, running) {
    if (running) {
      return '<div class="health-live"><div class="loading"><div class="spinner"></div>Connecting to each server with claude mcp list… this can take a minute.</div></div>';
    }
    if (!live) {
      return '<div class="health-live health-live-hint">The checks above only read your config. <strong>Test connections</strong> runs <code>claude mcp list</code>, which starts each user, claude.ai and home-folder server and reports whether it connects — the same as your <code>/mcp</code> screen. No AI is used.</div>';
    }
    if (live.error) return `<div class="health-live"><div class="health-detail">${escapeHtml(live.error)}</div></div>`;
    const rows = (live.servers || []).map(s => `<div class="health-live-row health-${escapeHtml(s.level)}">
        <span class="health-icon">${Health.ICONS[s.level] || ''}</span>
        <span class="health-live-name">${escapeHtml(s.name)}</span>
        <span class="health-live-status">${escapeHtml(s.status)}</span>
      </div>`).join('');
    return `<div class="health-live">
        <div class="health-live-head">Live status · ${escapeHtml(new Date(live.checkedAt).toLocaleString())}</div>
        ${rows || '<div class="health-ok">No servers reported.</div>'}
      </div>`;
  },

  /** Summary line plus one section per area, each saying "no issues" when clean. Pure, for tests. */
  html(data, live, liveRunning) {
    const c = Object.assign({}, data.counts || { error: 0, warn: 0, info: 0 });
    const liveFindings = (live && live.findings) || [];
    for (const f of liveFindings) c[f.severity] = (c[f.severity] || 0) + 1;
    const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
    const summary = `<div class="health-summary">
        <span class="health-count health-error">${Health.ICONS.error} ${plural(c.error, 'error')}</span>
        <span class="health-count health-warn">${Health.ICONS.warn} ${plural(c.warn, 'warning')}</span>
        <span class="health-count health-info">${Health.ICONS.info} ${c.info} info</span>
        <span class="health-meta">${plural(data.projectCount || 0, 'project')} checked · ${escapeHtml(new Date(data.checkedAt).toLocaleString())}</span>
      </div>`;
    const sections = Health.AREAS.map(area => {
      const items = (data.findings || []).concat(area.key === 'mcp' ? liveFindings : []).filter(f => f.area === area.key);
      const extra = area.key === 'mcp' ? Health.liveHtml(live, liveRunning) : '';
      const action = area.key === 'mcp'
        ? `<button class="btn btn-sm health-section-action" onclick="Health.testMcp()"${liveRunning ? ' disabled' : ''}>Test connections</button>`
        : '';
      const body = items.length
        ? items.map(Health.rowHtml).join('')
        : '<div class="health-ok">✓ No issues</div>';
      return `<section class="health-section">
          <div class="health-section-head">
            <h3>${escapeHtml(area.title)}</h3>
            ${items.length ? `<span class="git-count-badge">${items.length}</span>` : ''}
            <span class="health-hint">${escapeHtml(area.hint)}</span>
            ${action}
          </div>
          ${body}
          ${extra}
        </section>`;
    }).join('');
    return summary + sections;
  }
};

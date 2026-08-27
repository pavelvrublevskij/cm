// --- Git Window ---
// Standalone page: just the git panel for one project, nothing else from the app around it.
// Opened from the git modal's "Open in new tab" button so it can stay visible in its own tab.

const GitWindow = {
  // Same key/defaults as Sessions' "Live refresh rate" setting (manager-settings.js) — one setting
  // for how often anything in the app polls, rather than a second one just for this page.
  REFRESH_INTERVAL_KEY: 'claude-manager-conversation-refresh-ms',
  REFRESH_INTERVAL_DEFAULT_MS: 5000,
  REFRESH_INTERVAL_MIN_MS: 1000,
  _refreshTimer: null,

  async init() {
    const slug = new URLSearchParams(location.search).get('slug');
    if (!slug) {
      document.getElementById('git-window-host').innerHTML = '<div class="empty-state"><p>No project specified.</p></div>';
      return;
    }

    const name = decodeName(slug);
    document.title = `CM ${name} Git`;
    document.getElementById('git-window-title').textContent = name;

    GitWindow._loadFooterInfo();

    await GitActions.init(slug);
    GitPanel.mount('git-window-host', slug);
    GitWindow._startAutoRefresh();
  },

  _loadFooterInfo() {
    const hostEl = document.getElementById('footer-host');
    if (hostEl) hostEl.textContent = location.host;
    api('/api/version').then(data => {
      const v = document.getElementById('footer-version');
      if (v) v.textContent = 'v' + data.version;
    }).catch(() => {});
  },

  refreshIntervalMs() {
    const raw = parseInt(localStorage.getItem(GitWindow.REFRESH_INTERVAL_KEY), 10);
    if (Number.isFinite(raw) && raw >= GitWindow.REFRESH_INTERVAL_MIN_MS) return raw;
    return GitWindow.REFRESH_INTERVAL_DEFAULT_MS;
  },

  _startAutoRefresh() {
    if (GitWindow._refreshTimer) clearInterval(GitWindow._refreshTimer);
    const ms = GitWindow.refreshIntervalMs();
    GitWindow._refreshTimer = setInterval(GitWindow._refresh, ms);
    setFooterStatus(`Live · refresh ${Math.round(ms / 1000)}s`, true);
  },

  async _refresh() {
    await GitActions.refresh();
    await GitPanel.refreshIfMounted();
  }
};

/** Mirrors window.setFooterStatus from app.js — that file isn't loaded here. */
function setFooterStatus(text, live) {
  const el = document.getElementById('footer-status');
  if (!el) return;
  el.textContent = text || 'Idle';
  el.classList.toggle('live', !!live);
}

document.addEventListener('DOMContentLoaded', GitWindow.init);

// --- Navigation & App Shell ---

const SIDEBAR_COLLAPSED_KEY = 'claude-manager-sidebar-collapsed';

const App = {
  currentView: 'usage',
  currentProject: null,

  init() {
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        App.navigate(item.dataset.view);
      });
    });

    // Restore sidebar collapsed state
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
      document.querySelector('.app').classList.add('sidebar-collapsed');
      const btn = document.getElementById('sidebar-toggle');
      if (btn) btn.textContent = '›';
    }

    // Immediately switch view container to prevent dashboard flash during Projects.load()
    const _hash = window.location.hash.slice(1);
    if (_hash) {
      const _viewName = _hash.split('/')[0];
      const _viewEl = document.getElementById('view-' + _viewName);
      if (_viewEl) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        _viewEl.classList.add('active');
      }
    }

    // Load projects first (needed for sidebar nav and routing)
    Projects.load().then(() => {
      // Restore route from hash or default to settings
      App.restoreRoute();
    });

    // Listen for back/forward
    window.addEventListener('hashchange', () => App.restoreRoute());

    // Intercept keyboard refresh shortcuts — handle in-app instead of reloading
    window.addEventListener('keydown', e => {
      const isRefresh = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r');
      if (isRefresh) {
        e.preventDefault();
        App.restoreRoute();
      }
    });

    if (typeof ActiveCount !== 'undefined') ActiveCount.start();
    if (typeof ActiveSessionsBar !== 'undefined') ActiveSessionsBar.start();
  },

  toggleSidebar() {
    const app = document.querySelector('.app');
    const btn = document.getElementById('sidebar-toggle');
    const collapsed = app.classList.toggle('sidebar-collapsed');
    btn.textContent = collapsed ? '›' : '‹';
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    if (!collapsed && typeof ActiveSessionsBar !== 'undefined') {
      ActiveSessionsBar._lastSidebarKey = null;
      ActiveSessionsBar._renderSidebar();
    }
  },

  // Build hash from current state
  setHash(view, opts = {}) {
    let hash = '#' + view;
    if (opts.slug) hash += '/' + opts.slug;
    if (opts.sessionId) hash += '/' + opts.sessionId;
    if (window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  },

  restoreRoute() {
    const hash = window.location.hash.slice(1); // remove #
    if (!hash) {
      App.navigate('usage');
      return;
    }
    const parts = hash.split('/');
    const view = parts[0];
    const slug = parts[1] || null;
    const sessionId = parts[2] || null;

    if (view === 'session-detail' && slug && sessionId) {
      const sessions = Sessions.cache[slug] || [];
      const info = sessions.find(s => s.sessionId === sessionId);
      if (info) {
        App.navigate('session-detail', { slug, sessionId, sessionInfo: info }, true);
      } else {
        Sessions.load(slug).then(() => {
          const loaded = (Sessions.cache[slug] || []).find(s => s.sessionId === sessionId);
          App.navigate('session-detail', { slug, sessionId, sessionInfo: loaded }, true);
        });
      }
    } else if (view === 'project-detail' && slug) {
      App.navigate(view, { slug }, true);
    } else {
      App.navigate(view, {}, true);
    }
  },

  navigate(view, opts = {}, fromHash = false) {
    const previousView = App.currentView;
    const previousProject = App.currentProject;
    const previousSessionId = (typeof Sessions !== 'undefined' && Sessions.detailState) ? Sessions.detailState.sessionId : null;

    // Gate navigation away from session-detail when a browser terminal pty is attached.
    // confirmLeave handles all decision paths (no pty, no-sessionId-yet, prompt the user); it only
    // proceeds when the user confirms — Cancel short-circuits and leaves the view unchanged.
    // Switching directly from one session's detail to another's (e.g. resuming a different
    // session while one is already open) counts as leaving too — otherwise the terminal pane
    // stays attached to the old session while the UI shows the new one.
    const switchingSession = previousView === 'session-detail' && view === 'session-detail'
      && (opts.slug !== previousProject || opts.sessionId !== previousSessionId);
    const leavingSession = (previousView === 'session-detail' && view !== 'session-detail') || switchingSession;
    if (leavingSession && !opts._terminalConfirmed && typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen() && TerminalPanel.hasAttachedPty()) {
      TerminalPanel.confirmLeave(() => {
        App.navigate(view, Object.assign({}, opts, { _terminalConfirmed: true }), fromHash);
      });
      return;
    }

    // Stop auto-refresh + close in-page terminal when leaving session-detail
    if (leavingSession) {
      if (typeof Sessions !== 'undefined') Sessions.stopAutoRefresh();
      if (typeof TerminalPanel !== 'undefined' && TerminalPanel.isOpen()) TerminalPanel.close();
      // Invalidate session-list cache for the project we came from so green dots refresh on return.
      if (previousProject && typeof Sessions !== 'undefined' && Sessions.cache) {
        delete Sessions.cache[previousProject];
      }
      if (typeof ActiveSessionsBar !== 'undefined') { ActiveSessionsBar._render(); ActiveSessionsBar._renderSidebar(); }
    }

    // Deactivate all nav items
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

    // Activate clicked nav item
    const navItem = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navItem) navItem.classList.add('active');

    // Hide all views, show target
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    App.currentView = view;

    // Simple views with direct ID mapping
    const simpleViews = {
      'dashboard': () => Dashboard.load(),
      'usage': () => Usage.load(),
      'settings': () => Settings.load(),
      'global-claude-md': () => ClaudeMd.loadGlobal(),
      'projects': () => Projects.load(),
      'mcp-servers': () => McpServers.load(),
      'keybindings': () => Keybindings.load(),
      'skills': () => Skills.load(),
      'output-styles': () => OutputStyles.load(),
      'plugins': () => Plugins.load(),
      'manager-settings': () => ManagerSettings.load(),
      'changelog': () => Changelog.load()
    };

    if (simpleViews[view]) {
      document.getElementById('view-' + view).classList.add('active');
      if (typeof GitActions !== 'undefined') GitActions.reset();
      if (typeof GitPanel !== 'undefined') GitPanel.unmount();
      simpleViews[view]();
    } else if (view === 'project-detail') {
      document.getElementById('view-project-detail').classList.add('active');
      App.currentProject = opts.slug;
      const _proj = Projects.data.find(p => p.slug === opts.slug);
      const _titleEl = document.getElementById('project-detail-title');
      if (_titleEl) _titleEl.textContent = decodeName(opts.slug);
      const _pathEl = document.getElementById('project-detail-path');
      if (_pathEl && _proj) {
        _pathEl.textContent = _proj.path;
        _pathEl.classList.add('clickable-path');
        _pathEl.title = 'Open folder in file explorer';
        _pathEl.onclick = () => Projects.openFolder(opts.slug);
      }
      ProjectNav.expand();
      document.querySelectorAll('.project-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-sessions').classList.add('active');
      document.querySelectorAll('#view-project-detail .tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('sessions-tab-btn').classList.add('active');
      Sessions.load(opts.slug);
      // Show counts on tabs
      const project = Projects.data.find(p => p.slug === opts.slug);
      const memoryTabBtn = document.getElementById('memory-tab-btn');
      if (memoryTabBtn) {
        const count = project ? project.memoryCount : 0;
        memoryTabBtn.textContent = count > 0 ? `Memory (${count})` : 'Memory';
      }
      const sessionsTabBtn = document.getElementById('sessions-tab-btn');
      if (sessionsTabBtn) {
        const count = project ? project.sessionCount : 0;
        sessionsTabBtn.style.display = count > 0 ? '' : 'none';
        sessionsTabBtn.textContent = count > 0 ? `Sessions (${count})` : 'Sessions';
      }
      const skillsTabBtn = document.getElementById('skills-tab-btn');
      if (skillsTabBtn) {
        const count = project ? project.skillsCount : 0;
        skillsTabBtn.textContent = count > 0 ? `Skills (${count})` : 'Skills';
      }
      const stylesTabBtn = document.getElementById('output-styles-tab-btn');
      if (stylesTabBtn) {
        const count = project ? project.outputStylesCount : 0;
        stylesTabBtn.textContent = count > 0 ? `Output Styles (${count})` : 'Output Styles';
      }
      // Load per-project token usage in header
      ProjectUsage.load(opts.slug);
      if (typeof GitActions !== 'undefined') GitActions.init(opts.slug);
      // Highlight in sidebar
      document.querySelectorAll('.project-list .nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.slug === opts.slug);
      });
    } else if (view === 'session-detail') {
      document.getElementById('view-session-detail').classList.add('active');
      App.currentProject = opts.slug;
      Sessions.loadDetail(opts.slug, opts.sessionId, opts.sessionInfo);
      if (typeof GitActions !== 'undefined') GitActions.init(opts.slug).then(() => {
        if (typeof Sessions !== 'undefined' && App.currentView === 'session-detail') {
          Sessions.updateBranchWarning(Sessions.detailState.lastGitBranch || '');
        }
      });
      if (typeof ActiveSessionsBar !== 'undefined') { ActiveSessionsBar._render(); ActiveSessionsBar._renderSidebar(); }
    }

    // Update URL hash
    if (!fromHash) {
      App.setHash(view, opts);
    }
  },

  _promptTerminalLeave(onChoice) {
    openModal({
      title: 'Leave session?',
      body: '<p>This session has a running browser terminal with an active Claude agent. What would you like to do?</p>',
      buttons: [
        { label: 'Run in background', primary: true, onClick: () => onChoice('background') },
        { label: 'Close session', danger: true, onClick: () => onChoice('close') }
      ]
    });
  },

  async updateFromZip(e) {
    e.preventDefault();
    const banner = document.getElementById('update-banner');
    banner.innerHTML = 'Downloading and applying update&hellip;';
    try {
      await api('/api/update/zip', { method: 'POST' });
      banner.innerHTML = 'Restarting server&hellip;';
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try { await fetch('/api/version'); location.reload(); return; } catch (_) {}
      }
      banner.innerHTML = 'Server did not come back up — please restart manually.';
    } catch (err) {
      banner.innerHTML = `Update failed: ${escapeHtml(err.message)} &nbsp;&bull;&nbsp; <a href="#" onclick="location.reload()">Retry</a>`;
    }
  }
};

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  App.init();
  const hostEl = document.getElementById('footer-host');
  if (hostEl) hostEl.textContent = location.host;
  api('/api/version').then(data => {
    const av = document.getElementById('app-version');
    if (av) av.textContent = 'v' + data.version;
    const fv = document.getElementById('footer-version');
    if (fv) fv.textContent = 'v' + data.version;
    const minor = parseInt((data.version || '0.0.0').split('.')[1], 10);
    if (typeof Tour !== 'undefined' && Tour.shouldShow(minor)) setTimeout(() => Tour.start(minor), 400);
    if (data.updateAvailable) {
      const banner = document.getElementById('update-banner');
      banner.innerHTML = `New version <strong>v${escapeHtml(data.latest)}</strong> available! &nbsp;
        <a href="#" id="update-now-link" onclick="App.updateFromZip(event)">Update now</a> &nbsp;&bull;&nbsp;
        <a href="https://github.com/pavelvrublevskij/cm" target="_blank">View on GitHub</a> &nbsp;&bull;&nbsp;
        <a href="https://github.com/pavelvrublevskij/cm/blob/main/CHANGELOG.md" target="_blank">Changelog</a>`;
      banner.style.display = 'block';
    }
  }).catch(() => {});
});

window.setFooterStatus = function(text, live) {
  const el = document.getElementById('footer-status');
  if (!el) return;
  el.textContent = text || 'Idle';
  el.classList.toggle('live', !!live);
};

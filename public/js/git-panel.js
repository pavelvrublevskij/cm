// --- GitPanel ---
// Project shell (xterm.js over the terminal WebSocket bridge with ?mode=shell) beside a panel of
// git recipes. Mounted into whichever host is asking: the project-detail Git tab, or the modal the
// footer git button opens from a session view. One shell per project, so only one mount holds it.
//
// Recipes are typed into the shell without a trailing newline — nothing runs until the user hits
// Enter. Closing the panel detaches: the pty keeps running and reattaches with its scrollback.

const GitPanel = {
  _slug: null,
  _hostId: null,
  _info: null,
  _shellInfo: null,
  _term: null,
  _fit: null,
  _ws: null,
  _ro: null,
  _dataDisposable: null,
  _openCategories: null,

  /** Render into `hostId` for `slug`, reattaching to a shell that is already running. */
  async mount(hostId, slug) {
    if (GitPanel._term && (GitPanel._hostId !== hostId || GitPanel._slug !== slug)) {
      GitPanel._disposeView();
    }
    GitPanel._hostId = hostId;
    GitPanel._slug = slug;
    if (GitPanel._openCategories === null) {
      GitPanel._openCategories = new Set([GitRecipes.CATEGORIES[0].name]);
    }

    try {
      GitPanel._info = await api(`/api/projects/${encodeURIComponent(slug)}/git/info`);
    } catch (_) {
      GitPanel._info = { available: false };
    }
    try {
      GitPanel._shellInfo = await api(`/api/projects/${encodeURIComponent(slug)}/terminal/info?mode=shell`);
    } catch (_) {
      GitPanel._shellInfo = { available: false, running: false };
    }

    GitPanel._render();
    if (GitPanel._info.available && GitPanel._shellInfo.running && !GitPanel._term) GitPanel.openShell();
  },

  /** Leave the pty running and drop only this view of it. */
  unmount() {
    GitPanel._disposeView();
    GitPanel._hostId = null;
  },

  _render() {
    const el = document.getElementById(GitPanel._hostId);
    if (!el) return;

    if (!GitPanel._info || !GitPanel._info.available) {
      el.innerHTML = '<div class="empty-state">This project is not a git repository.</div>';
      return;
    }

    const ptyMissing = GitPanel._shellInfo && GitPanel._shellInfo.available === false;
    const idleBody = ptyMissing
      ? '<div class="git-shell-hint">A shell is unavailable: node-pty is not installed on the server.</div>'
      : `<button class="btn btn-primary" onclick="GitPanel.openShell()">Open Shell</button>
         <div class="git-shell-hint">Runs in the project directory. Clicked recipes are typed here, not executed.</div>`;

    el.innerHTML = `
      <div class="git-panel-layout">
        <div class="git-recipes" id="git-recipes"></div>
        <div class="git-shell">
          <div class="git-shell-header">
            <span class="git-shell-title">Shell</span>
            <span class="git-shell-cwd">${escapeHtml(GitPanel._branchLabel())}</span>
            <span class="terminal-pane-status" id="git-shell-status">disconnected</span>
            <div class="git-shell-actions">
              <button class="icon-btn" onclick="GitPanel.reconnect()" title="Restart shell" aria-label="Restart shell">&#x21bb;</button>
              <button class="icon-btn" onclick="GitPanel.killShell()" title="End this shell" aria-label="End this shell">&#x2715;</button>
            </div>
          </div>
          <div class="git-shell-idle" id="git-shell-idle">${idleBody}</div>
          <div class="git-shell-host" id="git-shell-host"></div>
        </div>
      </div>`;

    GitPanel._renderRecipes();
    GitPanel._showShell(!!GitPanel._term);
  },

  _branchLabel() {
    const info = GitPanel._info || {};
    if (!info.branch) return '';
    return info.detached ? `detached @ ${info.branch}` : info.branch;
  },

  _renderRecipes() {
    const host = document.getElementById('git-recipes');
    if (!host) return;
    host.innerHTML = GitRecipes.CATEGORIES.map(cat => {
      const open = GitPanel._openCategories.has(cat.name);
      const items = cat.items.map(item => {
        const cmd = GitRecipes.substitute(item.cmd, GitPanel._info);
        return `<button class="git-recipe${item.danger ? ' git-recipe-danger' : ''}"
            onclick="GitPanel.useRecipe(this)" data-cmd="${escapeHtml(cmd)}" title="Type into the shell">
            <code>${escapeHtml(cmd)}</code>
            <span class="git-recipe-explain">${escapeHtml(item.explain)}</span>
          </button>`;
      }).join('');
      return `<div class="git-recipe-cat${open ? ' open' : ''}">
          <button class="git-recipe-cat-header" onclick="GitPanel.toggleCategory('${escapeHtml(cat.name)}')">
            <span class="git-recipe-cat-caret">${open ? '&#9662;' : '&#9656;'}</span>${escapeHtml(cat.name)}
          </button>
          <div class="git-recipe-items">${items}</div>
        </div>`;
    }).join('');
  },

  toggleCategory(name) {
    if (GitPanel._openCategories.has(name)) GitPanel._openCategories.delete(name);
    else GitPanel._openCategories.add(name);
    GitPanel._renderRecipes();
  },

  /** Type a recipe into the shell without a newline — the user reviews it and presses Enter. */
  useRecipe(btn) {
    const cmd = btn.getAttribute('data-cmd');
    if (!cmd) return;
    if (!GitPanel._isConnected()) {
      toast('Open the shell first', 'error');
      return;
    }
    GitPanel._send({ t: 'i', d: cmd });
    if (GitPanel._term) GitPanel._term.focus();
  },

  _isConnected() {
    return !!(GitPanel._ws && GitPanel._ws.readyState === WebSocket.OPEN);
  },

  _send(payload) {
    if (!GitPanel._isConnected()) return false;
    try { GitPanel._ws.send(JSON.stringify(payload)); return true; }
    catch (_) { return false; }
  },

  openShell() {
    const XtermCls = window.Terminal;
    const FitCls = window.FitAddon && window.FitAddon.FitAddon;
    if (typeof XtermCls !== 'function' || typeof FitCls !== 'function') {
      toast('Terminal libraries failed to load', 'error');
      return;
    }
    const host = document.getElementById('git-shell-host');
    if (!host || GitPanel._term) return;

    host.innerHTML = '';
    const term = new XtermCls({
      cursorBlink: true,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 12,
      theme: { background: '#000000', foreground: '#e6edf3' },
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitCls();
    term.loadAddon(fit);
    term.open(host);
    GitPanel._term = term;
    GitPanel._fit = fit;
    GitPanel._showShell(true);
    setTimeout(() => { try { fit.fit(); } catch (_) {} }, 0);

    GitPanel._connect();
    GitPanel._observeResize();
  },

  _connect() {
    const term = GitPanel._term;
    if (!term) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/api/projects/${encodeURIComponent(GitPanel._slug)}/terminal?mode=shell`;
    GitPanel._setStatus('connecting...', '');

    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) {
      GitPanel._setStatus('connection failed', 'error');
      term.write(`\r\n\x1b[31mFailed to open WebSocket: ${e.message}\x1b[0m\r\n`);
      return;
    }
    GitPanel._ws = ws;

    ws.onopen = () => {
      GitPanel._setStatus('connected', 'connected');
      GitPanel._sendResize();
      if (typeof GitActions !== 'undefined') GitActions.refreshShellState();
    };
    ws.onmessage = ev => { term.write(typeof ev.data === 'string' ? ev.data : ''); };
    ws.onclose = () => { GitPanel._setStatus('disconnected', 'error'); };
    ws.onerror = () => { GitPanel._setStatus('error', 'error'); };

    if (GitPanel._dataDisposable) { try { GitPanel._dataDisposable.dispose(); } catch (_) {} }
    GitPanel._dataDisposable = term.onData(d => { GitPanel._send({ t: 'i', d }); });

    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return true;
      if (ev.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).then(() => toast('Copied')).catch(() => {});
        return false;
      }
      if (ev.key === 'v') return false;
      return true;
    });
  },

  reconnect() {
    if (!GitPanel._term) { GitPanel.openShell(); return; }
    if (GitPanel._ws) { try { GitPanel._ws.close(); } catch (_) {} }
    GitPanel._term.write('\r\n\x1b[33m[reconnecting]\x1b[0m\r\n');
    GitPanel._connect();
  },

  /** End the pty for good, unlike unmount() which only drops this view of it. */
  killShell() {
    GitPanel._send({ t: 'close' });
    GitPanel._disposeView();
    GitPanel._showShell(false);
    GitPanel._setStatus('disconnected', '');
    if (typeof GitActions !== 'undefined') GitActions.refreshShellState();
  },

  _disposeView() {
    if (GitPanel._ro) { try { GitPanel._ro.disconnect(); } catch (_) {} GitPanel._ro = null; }
    if (GitPanel._dataDisposable) { try { GitPanel._dataDisposable.dispose(); } catch (_) {} GitPanel._dataDisposable = null; }
    if (GitPanel._ws) { try { GitPanel._ws.close(); } catch (_) {} GitPanel._ws = null; }
    if (GitPanel._term) { try { GitPanel._term.dispose(); } catch (_) {} GitPanel._term = null; }
    GitPanel._fit = null;
  },

  _showShell(on) {
    const idle = document.getElementById('git-shell-idle');
    const host = document.getElementById('git-shell-host');
    if (idle) idle.style.display = on ? 'none' : '';
    if (host) host.style.display = on ? '' : 'none';
  },

  _setStatus(text, cls) {
    const el = document.getElementById('git-shell-status');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('connected', 'error');
    if (cls) el.classList.add(cls);
  },

  _sendResize() {
    const term = GitPanel._term;
    if (!term || !GitPanel._fit || !GitPanel._isConnected()) return;
    try { GitPanel._fit.fit(); } catch (_) {}
    if (term.cols > 0 && term.rows > 0) GitPanel._send({ t: 'r', c: term.cols, r: term.rows });
  },

  _observeResize() {
    const host = document.getElementById('git-shell-host');
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => GitPanel._sendResize());
    ro.observe(host);
    GitPanel._ro = ro;
  }
};

window.GitPanel = GitPanel;

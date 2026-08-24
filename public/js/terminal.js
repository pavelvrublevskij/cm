// --- TerminalPanel ---
// In-page terminal panel for a session: a TermView (shared with the git panel's shell) plus the
// session-specific parts — the split-pane drag, the leave prompt and the auto-open preference.
// Named TerminalPanel (not Terminal) because xterm.js owns window.Terminal.

const TerminalPanel = {
  WIDTH_KEY: 'claude-manager-terminal-width',
  AUTOOPEN_KEY: 'claude-manager-terminal-autoopen',
  MIN_WIDTH_PCT: 25,
  MAX_WIDTH_PCT: 80,
  DEFAULT_WIDTH_PCT: 35,        // 35% terminal / 40% source / 25% file structure
  COLLAPSE_THRESHOLD_PCT: 92,
  CLICK_THRESHOLD_PX: 3,

  shouldAutoOpen() {
    try { return localStorage.getItem(this.AUTOOPEN_KEY) === '1'; }
    catch (_) { return false; }
  },

  setAutoOpen(on) {
    try { localStorage.setItem(this.AUTOOPEN_KEY, on ? '1' : '0'); }
    catch (_) {}
  },

  state: {
    open: false,
    slug: null,
    sessionId: null,
    view: null,
  },

  isOpen() { return this.state.open; },

  openFromSession() {
    const detail = (typeof Sessions !== 'undefined') ? Sessions.detailState : null;
    if (!detail || !detail.slug) {
      toast('No active session', 'error');
      return;
    }
    if (this.state.open) return;
    this.setAutoOpen(true);
    this.open(detail.slug, detail.sessionId);
  },

  closeFromUser() {
    this.confirmLeave(() => {
      this.setAutoOpen(false);
      this.close();
    });
  },

  hasAttachedPty() {
    const view = this.state && this.state.view;
    return !!(view && view.isConnected());
  },

  // Decide whether to prompt, kill silently, or just continue when the user wants to leave the
  // session view. Fires `onProceed(choice)` after the decision (choice: 'background' | 'close' |
  // 'none'). Cancel from the modal short-circuits — no callback fires.
  confirmLeave(onProceed) {
    const done = (choice) => {
      onProceed && onProceed(choice);
      if (typeof ActiveCount !== 'undefined') setTimeout(() => ActiveCount.refresh(), 300);
      if (typeof ActiveSessionsBar !== 'undefined') setTimeout(() => ActiveSessionsBar.poll(), 300);
    };
    if (!this.hasAttachedPty()) { done('none'); return; }
    if (!this.state.sessionId) {
      // New-session pty with no ID yet — nothing to keep, close without asking.
      this.killSession();
      done('close');
      return;
    }
    App._promptTerminalLeave(choice => {
      if (choice === 'close') this.killSession();
      done(choice);
    });
  },

  killSession()       { this._sendWs({ t: 'close' }); },
  notifySessionId(id) {
    if (!id) return;
    this._sendWs({ t: 'session', id });
    if (this.state) this.state.sessionId = id;
  },

  _sendWs(payload) {
    const view = this.state && this.state.view;
    return !!view && view.send(payload);
  },

  open(slug, sessionId) {
    if (!TermView.librariesLoaded()) {
      toast('Terminal libraries failed to load', 'error');
      return;
    }

    const pane = document.getElementById('terminal-pane');
    const body = document.getElementById('session-detail-body');
    if (!pane || !body) return;

    this._hideFixBanner();
    const savedWidth = parseFloat(localStorage.getItem(this.WIDTH_KEY)) || this.DEFAULT_WIDTH_PCT;
    body.style.setProperty('--terminal-width', savedWidth + '%');
    pane.classList.add('connected');

    const view = TermView.create({
      hostId: 'terminal-host',
      url: this._wsUrl(slug, sessionId),
      onStatus: (text, cls) => this._setStatus(text, cls),
      onOpen: () => {
        this._hideFixBanner();
        if (typeof ActiveCount !== 'undefined') ActiveCount.refresh();
        if (typeof ActiveSessionsBar !== 'undefined') ActiveSessionsBar.poll();
      },
      onSpawnError: (message, control) => this._showFixBanner(message, control && control.hint),
    });
    if (!view) return;

    this.state = { open: true, slug, sessionId: sessionId || null, view };
  },

  _showFixBanner(message, hint) {
    const banner = document.getElementById('terminal-fix-banner');
    const text = document.getElementById('terminal-fix-text');
    const btn = document.getElementById('terminal-fix-btn');
    let full = message ? `Terminal failed to start: ${message}` : 'Terminal failed to start.';
    if (hint) full += ' ' + hint;
    if (text) text.textContent = full;
    if (btn) { btn.disabled = false; btn.textContent = 'Fix & Restart App'; }
    if (banner) banner.style.display = 'flex';
  },

  _hideFixBanner() {
    const banner = document.getElementById('terminal-fix-banner');
    if (banner) banner.style.display = 'none';
  },

  runFix() {
    const btn = document.getElementById('terminal-fix-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; }
    TerminalRepair.trigger((status, failed) => {
      const text = document.getElementById('terminal-fix-text');
      if (text) text.textContent = status;
      if (failed && btn) { btn.disabled = false; btn.textContent = 'Fix & Restart App'; }
    });
  },

  _wsUrl(slug, sessionId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return `${proto}//${location.host}/api/projects/${encodeURIComponent(slug)}/terminal${qs}`;
  },

  reconnect() {
    if (!this.state.view) return;
    this.state.view.reconnect('[restarting]');
  },

  _setStatus(text, cls) {
    const el = document.getElementById('terminal-status');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('connected', 'error');
    if (cls) el.classList.add(cls);
  },

  _sendResize() {
    if (this.state.view) this.state.view.resize();
  },

  close() {
    if (this.state.view) this.state.view.dispose();

    const pane = document.getElementById('terminal-pane');
    if (pane) pane.classList.remove('connected');
    this._setStatus('disconnected', '');
    this._hideFixBanner();

    this.state = { open: false, slug: null, sessionId: null, view: null };
  },

  _setConversationHidden(hidden, instantPoll) {
    if (typeof Sessions === 'undefined') {
      const body = document.getElementById('session-detail-body');
      if (body) body.classList.toggle('conversation-hidden', !!hidden);
      return;
    }
    localStorage.setItem(Sessions.CONVERSATION_HIDDEN_KEY, hidden ? '1' : '0');
    Sessions.applyConversationHiddenState();
    if (hidden) {
      Sessions.stopConversationRefresh();
    } else {
      if (instantPoll) Sessions.pollNewMessages();
      Sessions.startAutoRefresh();
    }
  },

  startDrag(ev) {
    ev.preventDefault();
    const body = document.getElementById('session-detail-body');
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const startX = ev.clientX;
    const wasHidden = body.classList.contains('conversation-hidden');
    let dragMode = false;

    const enterDragMode = () => {
      dragMode = true;
      if (wasHidden) body.classList.remove('conversation-hidden');
    };

    const onMove = e => {
      if (!dragMode && Math.abs(e.clientX - startX) > this.CLICK_THRESHOLD_PX) enterDragMode();
      if (!dragMode) return;
      const x = e.clientX - rect.left;
      let pct = 100 - (x / rect.width) * 100;
      if (pct < this.MIN_WIDTH_PCT) pct = this.MIN_WIDTH_PCT;
      if (pct > 100) pct = 100;
      body.style.setProperty('--terminal-width', pct + '%');
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';

      if (!dragMode) {
        // Pure click — toggle hidden state
        this._setConversationHidden(!wasHidden, /*instantPoll=*/ wasHidden);
        this._sendResize();
        return;
      }

      const finalPct = parseFloat(body.style.getPropertyValue('--terminal-width'));
      const collapse = !isNaN(finalPct) && finalPct >= this.COLLAPSE_THRESHOLD_PCT;

      if (collapse) {
        this._setConversationHidden(true);
      } else {
        const saved = isNaN(finalPct) ? this.DEFAULT_WIDTH_PCT : Math.max(this.MIN_WIDTH_PCT, Math.min(this.MAX_WIDTH_PCT, finalPct));
        body.style.setProperty('--terminal-width', saved + '%');
        localStorage.setItem(this.WIDTH_KEY, String(saved));
        if (wasHidden) this._setConversationHidden(false, true);
      }
      this._sendResize();
    };

    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  },
};

window.TerminalPanel = TerminalPanel;

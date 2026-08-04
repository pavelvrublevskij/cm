// --- TerminalPanel ---
// In-page terminal panel for a session, backed by xterm.js + WebSocket bridge.
// Named TerminalPanel (not Terminal) because xterm.js owns window.Terminal.

const TerminalPanel = {
  WIDTH_KEY: 'claude-manager-terminal-width',
  AUTOOPEN_KEY: 'claude-manager-terminal-autoopen',
  MIN_WIDTH_PCT: 25,
  MAX_WIDTH_PCT: 80,
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
    term: null,
    fitAddon: null,
    ws: null,
    resizeObserver: null,
    dataDisposable: null,
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
    const ws = this.state && this.state.ws;
    return !!(ws && ws.readyState === WebSocket.OPEN);
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
    const ws = this.state && this.state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(payload)); return true; }
    catch (_) { return false; }
  },

  open(slug, sessionId) {
    const XtermCls = window.Terminal;
    const FitCls = window.FitAddon && window.FitAddon.FitAddon;
    if (typeof XtermCls !== 'function' || typeof FitCls !== 'function') {
      toast('Terminal libraries failed to load', 'error');
      return;
    }

    const pane = document.getElementById('terminal-pane');
    const body = document.getElementById('session-detail-body');
    const host = document.getElementById('terminal-host');
    if (!pane || !host || !body) return;

    const savedWidth = parseFloat(localStorage.getItem(this.WIDTH_KEY)) || 50;
    body.style.setProperty('--terminal-width', savedWidth + '%');

    pane.classList.add('connected');

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
    setTimeout(() => { try { fit.fit(); } catch (_) {} }, 0);

    this.state = {
      open: true,
      slug,
      sessionId: sessionId || null,
      term,
      fitAddon: fit,
      ws: null,
      resizeObserver: null,
      dataDisposable: null,
    };

    this._connect();
    this._observeResize();
  },

  _connect() {
    const { slug, sessionId, term } = this.state;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const wsUrl = `${proto}//${location.host}/api/projects/${encodeURIComponent(slug)}/terminal${qs}`;
    this._setStatus('connecting...', '');

    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) {
      this._setStatus('connection failed', 'error');
      term.write(`\r\n\x1b[31mFailed to open WebSocket: ${e.message}\x1b[0m\r\n`);
      return;
    }
    this.state.ws = ws;

    ws.onopen = () => {
      this._setStatus('connected', 'connected');
      this._sendResize();
      if (typeof ActiveCount !== 'undefined') ActiveCount.refresh();
      if (typeof ActiveSessionsBar !== 'undefined') ActiveSessionsBar.poll();
    };
    ws.onmessage = ev => { term.write(typeof ev.data === 'string' ? ev.data : ''); };
    ws.onclose = () => { this._setStatus('disconnected', 'error'); };
    ws.onerror = () => { this._setStatus('error', 'error'); };

    if (this.state.dataDisposable) { try { this.state.dataDisposable.dispose(); } catch (_) {} }
    this.state.dataDisposable = term.onData(d => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }));
    });

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
    if (!this.state.term) return;
    if (this.state.ws) { try { this.state.ws.close(); } catch (_) {} }
    this.state.term.write('\r\n\x1b[33m[restarting]\x1b[0m\r\n');
    this._connect();
  },

  _setStatus(text, cls) {
    const el = document.getElementById('terminal-status');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('connected', 'error');
    if (cls) el.classList.add(cls);
  },

  _sendResize() {
    const { ws, term, fitAddon } = this.state;
    if (!ws || ws.readyState !== WebSocket.OPEN || !term || !fitAddon) return;
    try { fitAddon.fit(); } catch (_) {}
    const cols = term.cols, rows = term.rows;
    if (cols > 0 && rows > 0) ws.send(JSON.stringify({ t: 'r', c: cols, r: rows }));
  },

  _observeResize() {
    const host = document.getElementById('terminal-host');
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => this._sendResize());
    ro.observe(host);
    this.state.resizeObserver = ro;
  },

  close() {
    if (this.state.resizeObserver) { try { this.state.resizeObserver.disconnect(); } catch (_) {} }
    if (this.state.dataDisposable) { try { this.state.dataDisposable.dispose(); } catch (_) {} }
    if (this.state.ws) { try { this.state.ws.close(); } catch (_) {} }
    if (this.state.term) { try { this.state.term.dispose(); } catch (_) {} }

    const pane = document.getElementById('terminal-pane');
    if (pane) pane.classList.remove('connected');
    this._setStatus('disconnected', '');

    this.state = { open: false, slug: null, sessionId: null, term: null, fitAddon: null, ws: null, resizeObserver: null, dataDisposable: null };
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
        const saved = isNaN(finalPct) ? 50 : Math.max(this.MIN_WIDTH_PCT, Math.min(this.MAX_WIDTH_PCT, finalPct));
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

// --- TermView ---
// One xterm.js terminal wired to a terminal-bridge WebSocket. The session terminal panel and the
// git panel's project shell both need the same lifecycle — mount, connect, pass input through,
// keep the pty's size in step with the DOM, dispose — and differ only in which URL they open and
// what they do when the status changes. That lifecycle lives here once.

const TermView = {
  FONT_FAMILY: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
  FONT_SIZE: 12,
  SCROLLBACK: 5000,

  /** True when the xterm.js CDN scripts are present. */
  librariesLoaded() {
    return typeof window.Terminal === 'function'
      && !!(window.FitAddon && typeof window.FitAddon.FitAddon === 'function');
  },

  /**
   * Mount a terminal in `hostId` and connect it to `url`.
   * @param {Object} opts
   * @param {string} opts.hostId - element to mount the terminal in
   * @param {string} opts.url - WebSocket URL of the terminal bridge
   * @param {Function} [opts.onStatus] - (text, cls) as the connection state changes
   * @param {Function} [opts.onOpen] - called once the socket is open
   * @returns {Object|null} the view, or null when the libraries or host are missing
   */
  create(opts) {
    if (!TermView.librariesLoaded()) return null;
    const host = document.getElementById(opts.hostId);
    if (!host) return null;

    host.innerHTML = '';
    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: TermView.FONT_FAMILY,
      fontSize: TermView.FONT_SIZE,
      theme: { background: '#000000', foreground: '#e6edf3' },
      scrollback: TermView.SCROLLBACK,
      convertEol: false,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const view = {
      term,
      hostId: opts.hostId,
      url: opts.url,
      _fit: fit,
      _ws: null,
      _ro: null,
      _dataDisposable: null,

      isConnected() {
        return !!(view._ws && view._ws.readyState === WebSocket.OPEN);
      },

      send(payload) {
        if (!view.isConnected()) return false;
        try { view._ws.send(JSON.stringify(payload)); return true; }
        catch (_) { return false; }
      },

      write(text) { term.write(text); },

      focus() { term.focus(); },

      /** Refit to the DOM and tell the pty its new size. */
      resize() {
        if (!view.isConnected()) return;
        try { fit.fit(); } catch (_) {}
        if (term.cols > 0 && term.rows > 0) view.send({ t: 'r', c: term.cols, r: term.rows });
      },

      connect() {
        TermView._setStatus(opts, 'connecting...', '');
        let ws;
        try { ws = new WebSocket(view.url); }
        catch (e) {
          TermView._setStatus(opts, 'connection failed', 'error');
          term.write(`\r\n\x1b[31mFailed to open WebSocket: ${e.message}\x1b[0m\r\n`);
          return;
        }
        view._ws = ws;

        ws.onopen = () => {
          TermView._setStatus(opts, 'connected', 'connected');
          view.resize();
          if (opts.onOpen) opts.onOpen();
        };
        ws.onmessage = ev => { term.write(typeof ev.data === 'string' ? ev.data : ''); };
        ws.onclose = () => { TermView._setStatus(opts, 'disconnected', 'error'); };
        ws.onerror = () => { TermView._setStatus(opts, 'error', 'error'); };

        if (view._dataDisposable) { try { view._dataDisposable.dispose(); } catch (_) {} }
        view._dataDisposable = term.onData(d => view.send({ t: 'i', d }));

        term.attachCustomKeyEventHandler(ev => {
          if (ev.type !== 'keydown' || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return true;
          if (ev.key === 'c' && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).then(() => toast('Copied')).catch(() => {});
            return false;
          }
          if (ev.key === 'v') return false;   // let the browser paste
          return true;
        });
      },

      /** Drop the socket and open a new one, keeping the terminal and its scrollback. */
      reconnect(banner) {
        if (view._ws) { try { view._ws.close(); } catch (_) {} }
        if (banner) term.write(`\r\n\x1b[33m${banner}\x1b[0m\r\n`);
        view.connect();
      },

      observeResize() {
        const el = document.getElementById(view.hostId);
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => view.resize());
        ro.observe(el);
        view._ro = ro;
      },

      dispose() {
        if (view._ro) { try { view._ro.disconnect(); } catch (_) {} view._ro = null; }
        if (view._dataDisposable) { try { view._dataDisposable.dispose(); } catch (_) {} view._dataDisposable = null; }
        if (view._ws) { try { view._ws.close(); } catch (_) {} view._ws = null; }
        try { term.dispose(); } catch (_) {}
      },
    };

    setTimeout(() => { try { fit.fit(); } catch (_) {} }, 0);
    view.connect();
    view.observeResize();
    return view;
  },

  _setStatus(opts, text, cls) {
    if (opts.onStatus) opts.onStatus(text, cls);
  },
};

window.TermView = TermView;

// --- Scratchpad tab: same split layout as the Files tab, read-only pane ---

Object.assign(Sessions, {
  _scratchpadData: null,
  _spOpen: null,
  _spEditor: null,

  async loadScratchpad() {
    const el = document.getElementById('session-scratchpad');
    if (!el) return;
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;

    Sessions._scratchpadLoaded = true;
    Sessions._spOpen = null;
    Sessions._spEditor = null;
    el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

    try {
      const data = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad`);
      if (Sessions.detailState.slug !== slug || Sessions.detailState.sessionId !== sessionId) return;
      Sessions._scratchpadData = data;
      Sessions.renderScratchpad(el, data);
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    }
  },

  renderScratchpad(el, data) {
    if (!data.exists || !data.files.length) {
      el.innerHTML = `<div class="scratchpad-empty">
        <p>No scratchpad files for this session.</p>
        <p class="scratchpad-hint">This shows files Claude created in its temporary working directory during this session.</p>
      </div>`;
      return;
    }

    el.innerHTML = `<div class="sf-structure" id="sp-structure">
        <div class="sf-tree-header">
          <span id="sp-count">Scratchpad (${data.files.length})</span>
          <button class="icon-btn" onclick="Sessions.openScratchpadFolder()" title="Open folder" aria-label="Open folder">&#128193;</button>
        </div>
        <div id="sp-list">${Sessions._renderScratchpadList()}</div>
      </div>
      <div class="sf-splitter" title="Drag to resize, click to show/hide" onmousedown="CodeView.startDrag(event)"></div>
      <div class="sf-pane" id="sp-pane"></div>`;
    CodeView.applyState();
    Sessions._renderScratchpadPane();
  },

  _renderScratchpadList() {
    const files = (Sessions._scratchpadData && Sessions._scratchpadData.files) || [];
    return files.map((f, i) => {
      const lastSlash = f.path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? f.path.slice(0, lastSlash + 1) : '';
      const name = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path;
      const active = Sessions._spOpen && Sessions._spOpen.path === f.path ? ' sf-row-active' : '';
      return `<div class="sf-row sf-row-file${active}" style="--sf-depth:0"
        data-path="${escapeHtml(f.path)}" onclick="Sessions.openScratchpadInPane(${i})">
        <span class="sf-name">${dir ? `<span class="sf-pane-dir">${escapeHtml(dir)}</span>` : ''}${escapeHtml(name)}</span>
        <span class="sp-row-size">${formatBytes(f.size)}</span>
      </div>`;
    }).join('');
  },

  async openScratchpadInPane(index) {
    const data = Sessions._scratchpadData;
    if (!data || !data.files[index]) return;
    const file = data.files[index];
    const { slug, sessionId } = Sessions.detailState;

    Sessions._spEditor = null;
    Sessions._spOpen = {
      index,
      path: file.path,
      size: file.size,
      mtime: file.mtime,
      canPreview: CodeView.isPreviewable(file.path),
      loading: true
    };
    Sessions._spOpen.mode = Sessions._spOpen.canPreview ? 'preview' : 'source';
    Sessions._renderScratchpadPane();
    Sessions._refreshScratchpadList();

    try {
      const res = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad/file?path=${encodeURIComponent(file.path)}`);
      const open = Sessions._spOpen;
      if (!open || open.path !== file.path) return;
      Object.assign(open, { loading: false, text: res.content != null ? res.content : '', binary: !!res.binary, tooLarge: !!res.tooLarge });
      Sessions._renderScratchpadPane();
    } catch (e) {
      const open = Sessions._spOpen;
      if (!open || open.path !== file.path) return;
      Object.assign(open, { loading: false, error: e.message });
      Sessions._renderScratchpadPane();
    }
  },

  setScratchpadMode(mode) {
    const open = Sessions._spOpen;
    if (!open || open.mode === mode) return;
    if (mode === 'preview' && !open.canPreview) return;
    open.mode = mode;
    Sessions._renderScratchpadPane();
  },

  _renderScratchpadPane() {
    const el = document.getElementById('sp-pane');
    if (!el) return;
    const open = Sessions._spOpen;

    if (!open) {
      el.innerHTML = `<div class="sf-pane-empty">
        <p>Select a file to view it.</p>
        <p class="sf-pane-hint">These are files Claude created in its temporary working directory during this session.</p>
      </div>`;
      return;
    }

    const name = open.path.split('/').pop();
    const dir = open.path.slice(0, open.path.length - name.length);
    const modeBtn = (mode, label) =>
      `<button class="sf-mode-btn${open.mode === mode ? ' active' : ''}" onclick="Sessions.setScratchpadMode('${mode}')">${label}</button>`;

    el.innerHTML = `<div class="sf-pane-header">
        <span class="sf-pane-path" title="${escapeHtml(open.path)}">${dir ? `<span class="sf-pane-dir">${escapeHtml(dir)}</span>` : ''}${escapeHtml(name)}</span>
        <div class="sf-pane-actions">
          ${open.canPreview ? `<div class="sf-mode-toggle">${modeBtn('source', 'Source')}${modeBtn('preview', 'Preview')}</div>` : ''}
          <div class="action-menu">
            <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="File actions">&#8942;</button>
            <div class="action-menu-panel">
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.openScratchpadFile(Sessions._spOpen.index)">Open in editor</button>
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.revealScratchpadFile(Sessions._spOpen.index)">Show in file explorer</button>
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.openScratchpadFolder()">Open folder</button>
            </div>
          </div>
        </div>
      </div>
      <div class="sf-pane-body" id="sp-pane-body"></div>
      <div class="sf-status-bar">
        <span>read-only</span>
        <span class="sf-status-sep">&middot;</span>
        <span>${formatBytes(open.size)}</span>
        <span class="sf-status-sep">&middot;</span>
        <span>${escapeHtml(timeAgo(open.mtime))}</span>
      </div>`;

    const body = document.getElementById('sp-pane-body');
    if (open.loading) {
      showLoading(body, 'Loading file...');
    } else if (open.error) {
      body.innerHTML = `<div class="empty-state"><p>${escapeHtml(open.error)}</p></div>`;
    } else if (open.binary) {
      body.innerHTML = `<div class="empty-state"><p>Binary file (${formatBytes(open.size)}) — open the folder to view it.</p></div>`;
    } else if (open.tooLarge) {
      body.innerHTML = `<div class="empty-state"><p>File too large to show here (${formatBytes(open.size)}) — open the folder to view it.</p></div>`;
    } else if (open.mode === 'preview') {
      CodeView.preview(body, open.text, open.path);
    } else {
      body.innerHTML = '<div class="sf-editor-host code-colors" id="sp-editor-host"></div>';
      Sessions._spEditor = CodeView.mount(document.getElementById('sp-editor-host'), open.text, open.path, { readOnly: true });
    }
  },

  _refreshScratchpadList() {
    const list = document.getElementById('sp-list');
    if (list) list.innerHTML = Sessions._renderScratchpadList();
  },

  _scratchpadKey(data) {
    if (!data || !data.exists) return '';
    return (data.files || []).map(f => `${f.path}@${f.size}@${f.mtime}`).join('|');
  },

  /** Refresh the file list on the detail view's poll tick, keeping the open file in place. */
  async pollScratchpad() {
    const el = document.getElementById('session-scratchpad');
    if (!el || !Sessions._scratchpadLoaded) return;
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;

    try {
      const data = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad`);
      if (Sessions.detailState.slug !== slug || Sessions.detailState.sessionId !== sessionId) return;
      if (Sessions._scratchpadKey(data) === Sessions._scratchpadKey(Sessions._scratchpadData)) return;

      const prev = Sessions._scratchpadData;
      const prevHadFiles = !!(prev && prev.exists && prev.files.length);
      const hasFiles = !!(data.exists && data.files.length);
      const openPath = Sessions._spOpen && Sessions._spOpen.path;
      Sessions._scratchpadData = data;

      if (!prevHadFiles || !hasFiles) {
        Sessions._spOpen = null;
        Sessions._spEditor = null;
        Sessions.renderScratchpad(el, data);
        return;
      }

      if (openPath) {
        const index = data.files.findIndex(f => f.path === openPath);
        if (index < 0) {
          Sessions._spOpen = null;
          Sessions._spEditor = null;
          Sessions._renderScratchpadPane();
        } else {
          Sessions._spOpen.index = index;
        }
      }

      Sessions._refreshScratchpadList();
      const count = document.getElementById('sp-count');
      if (count) count.textContent = `Scratchpad (${data.files.length})`;
    } catch (_) {}
  },

  async openScratchpadFolder() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;
    try {
      await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad/open-folder`, { method: 'POST' });
    } catch (e) {
      toast('Could not open folder: ' + e.message, 'error');
    }
  },

  async openScratchpadFile(index) {
    const data = Sessions._scratchpadData;
    if (!data || !data.files[index]) return;
    const file = data.files[index];
    const { slug, sessionId } = Sessions.detailState;
    try {
      await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad/open-file`, {
        method: 'POST',
        body: { path: file.path }
      });
    } catch (e) {
      toast('Could not open file: ' + e.message, 'error');
    }
  },

  async revealScratchpadFile(index) {
    const data = Sessions._scratchpadData;
    if (!data || !data.files[index]) return;
    const file = data.files[index];
    const { slug, sessionId } = Sessions.detailState;
    try {
      await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad/reveal-file`, {
        method: 'POST',
        body: { path: file.path }
      });
    } catch (e) {
      toast('Could not show file in explorer: ' + e.message, 'error');
    }
  }
});

Object.assign(Sessions, {
  _scratchpadData: null,

  async loadScratchpad() {
    const el = document.getElementById('session-scratchpad');
    if (!el) return;
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) return;

    Sessions._scratchpadLoaded = true;
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

    const rows = data.files.map((f, i) => {
      const lastSlash = f.path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? f.path.slice(0, lastSlash + 1) : '';
      const name = lastSlash >= 0 ? f.path.slice(lastSlash + 1) : f.path;
      return `<div class="scratchpad-file-item" onclick="Sessions.previewScratchpadFile(${i})">
        <span class="scratchpad-file-name">${dir ? `<span class="scratchpad-file-dir">${escapeHtml(dir)}</span>` : ''}${escapeHtml(name)}</span>
        <span class="scratchpad-file-size">${Sessions._formatBytes(f.size)}</span>
        <span class="scratchpad-file-time">${timeAgo(f.mtime)}</span>
        <div class="action-menu">
          <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="File actions">&#8942;</button>
          <div class="action-menu-panel">
            <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.openScratchpadFile(${i})">Open in editor</button>
            <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.revealScratchpadFile(${i})">Show in file explorer</button>
          </div>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `<div class="scratchpad-toolbar">
        <span class="scratchpad-count">${data.files.length} file${data.files.length === 1 ? '' : 's'}</span>
        <button class="btn btn-sm" onclick="Sessions.openScratchpadFolder()">Open folder</button>
      </div>
      <div class="scratchpad-file-list">${rows}</div>`;
  },

  _formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  },

  async previewScratchpadFile(index) {
    const data = Sessions._scratchpadData;
    if (!data || !data.files[index]) return;
    const file = data.files[index];
    const { slug, sessionId } = Sessions.detailState;

    const overlay = openModal({
      title: file.path,
      width: 800,
      body: '<div id="scratchpad-preview-body"><div class="loading"><div class="spinner"></div>Loading…</div></div>',
      buttons: [
        { label: 'Show in explorer', onClick: () => Sessions.revealScratchpadFile(index) },
        { label: 'Open in editor', primary: true, onClick: () => Sessions.openScratchpadFile(index) }
      ]
    });

    try {
      const res = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/scratchpad/file?path=${encodeURIComponent(file.path)}`);
      const body = overlay.querySelector('#scratchpad-preview-body');
      if (res.binary) {
        body.innerHTML = `<div class="empty-state"><p>Binary file (${Sessions._formatBytes(res.size)}) — open the folder to view it.</p></div>`;
      } else if (res.tooLarge) {
        body.innerHTML = `<div class="empty-state"><p>File too large to preview (${Sessions._formatBytes(res.size)}) — open the folder to view it.</p></div>`;
      } else {
        body.innerHTML = `<pre class="scratchpad-file-content">${escapeHtml(res.content)}</pre>`;
      }
    } catch (e) {
      overlay.querySelector('#scratchpad-preview-body').innerHTML =
        `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    }
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

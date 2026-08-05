// --- Files tab: project structure + source viewer/editor ---

const SessionFiles = {
  AUTOSAVE_KEY: 'claude-manager-editor-autosave',
  AUTOSAVE_DELAY_KEY: 'claude-manager-editor-autosave-ms',
  AUTOSAVE_DEFAULT_DELAY_MS: 2000,
  AUTOSAVE_MIN_DELAY_MS: 500,

  slug: null,
  treeLoaded: false,
  dirs: {},
  expanded: new Set(),
  changed: new Set(),
  buffers: {},
  open: null,
  editor: null,
  _saveTimer: null,
  _saving: false,
  _savedAt: null,

  // --- settings (CM Settings › Editor) ---

  autosaveEnabled() {
    return localStorage.getItem(SessionFiles.AUTOSAVE_KEY) === '1';
  },

  setAutosaveEnabled(on) {
    localStorage.setItem(SessionFiles.AUTOSAVE_KEY, on ? '1' : '0');
    if (on) SessionFiles._scheduleAutosave();
    else SessionFiles._clearSaveTimer();
    SessionFiles.renderStatus();
  },

  autosaveDelayMs() {
    const raw = parseInt(localStorage.getItem(SessionFiles.AUTOSAVE_DELAY_KEY), 10);
    if (Number.isFinite(raw) && raw >= SessionFiles.AUTOSAVE_MIN_DELAY_MS) return raw;
    return SessionFiles.AUTOSAVE_DEFAULT_DELAY_MS;
  },

  setAutosaveDelayMs(ms) {
    if (!Number.isFinite(ms) || ms < SessionFiles.AUTOSAVE_MIN_DELAY_MS) return false;
    localStorage.setItem(SessionFiles.AUTOSAVE_DELAY_KEY, String(ms));
    SessionFiles.renderStatus();
    return true;
  },

  // --- lifecycle ---

  reset(slug) {
    SessionFiles._clearSaveTimer();
    SessionFiles.slug = slug;
    SessionFiles.treeLoaded = false;
    SessionFiles.dirs = {};
    SessionFiles.expanded = new Set();
    SessionFiles.changed = new Set();
    SessionFiles.buffers = {};
    SessionFiles.open = null;
    SessionFiles.editor = null;
    SessionFiles._saving = false;
    SessionFiles._savedAt = null;
    SessionFiles._savedPath = null;
    const tree = document.getElementById('sf-tree');
    if (tree) tree.innerHTML = '';
    CodeView.applyState();
    SessionFiles.renderPane();
  },

  async loadTree() {
    const el = document.getElementById('sf-tree');
    if (!el || !SessionFiles.slug) return;
    SessionFiles.treeLoaded = true;
    showLoading(el, 'Loading project files...');
    try {
      SessionFiles.dirs[''] = await SessionFiles._fetchDir('');
      SessionFiles.renderTree();
    } catch (e) {
      el.innerHTML = `<div class="ctx-empty">Could not load project files: ${escapeHtml(e.message)}</div>`;
    }
  },

  async reloadTree() {
    if (!SessionFiles.slug) return;
    const wanted = ['', ...SessionFiles.expanded];
    const loaded = await Promise.all(wanted.map(dir =>
      SessionFiles._fetchDir(dir).catch(() => null)
    ));
    SessionFiles.dirs = {};
    wanted.forEach((dir, i) => {
      if (loaded[i]) SessionFiles.dirs[dir] = loaded[i];
      else SessionFiles.expanded.delete(dir);
    });
    SessionFiles.treeLoaded = true;
    SessionFiles.renderTree();
  },

  async _fetchDir(dir) {
    const qs = dir ? `?path=${encodeURIComponent(dir)}` : '';
    const data = await api(`/api/projects/${encodeURIComponent(SessionFiles.slug)}/files/tree${qs}`);
    return data.entries || [];
  },

  /** Paths changed in this session live in the pinned list above, so the tree leaves them out. */
  setChangedPaths(paths) {
    const next = new Set(paths);
    const unchanged = next.size === SessionFiles.changed.size && [...next].every(p => SessionFiles.changed.has(p));
    SessionFiles.changed = next;
    if (!unchanged && SessionFiles.treeLoaded) SessionFiles.renderTree();
  },

  // --- tree ---

  renderTree() {
    const el = document.getElementById('sf-tree');
    if (!el) return;
    const rows = SessionFiles._rowsHtml('', 0);
    el.innerHTML = rows || '<div class="ctx-empty">No files</div>';
  },

  _rowsHtml(dir, depth) {
    const entries = SessionFiles.dirs[dir];
    if (!entries) return '';
    let html = '';
    for (const entry of entries) {
      const relPath = dir ? dir + '/' + entry.name : entry.name;
      if (entry.type === 'dir') {
        const open = SessionFiles.expanded.has(relPath);
        html += `<div class="sf-row sf-row-dir" style="--sf-depth:${depth}"
          data-path="${escapeHtml(relPath)}" data-type="dir" onclick="SessionFiles.onRowClick(this)">
          <span class="sf-arrow">${open ? '&#9660;' : '&#9654;'}</span>
          <span class="sf-name">${escapeHtml(entry.name)}</span>
        </div>`;
        if (open) html += SessionFiles._rowsHtml(relPath, depth + 1);
        continue;
      }
      if (SessionFiles.changed.has(relPath)) continue;
      const isOpen = SessionFiles.open && SessionFiles.open.path === relPath;
      const dirty = SessionFiles.buffers[relPath] !== undefined;
      html += `<div class="sf-row sf-row-file${isOpen ? ' sf-row-active' : ''}" style="--sf-depth:${depth}"
        data-path="${escapeHtml(relPath)}" data-type="file" onclick="SessionFiles.onRowClick(this)">
        <span class="sf-name">${escapeHtml(entry.name)}</span>
        <span class="sf-dirty" style="${dirty ? '' : 'display:none'}" title="Unsaved changes">&#9679;</span>
      </div>`;
    }
    return html;
  },

  onRowClick(el) {
    const { path, type } = el.dataset;
    if (type === 'dir') SessionFiles.toggleDir(path);
    else SessionFiles.openFile(path);
  },

  async toggleDir(dir) {
    if (SessionFiles.expanded.has(dir)) {
      SessionFiles.expanded.delete(dir);
      SessionFiles.renderTree();
      return;
    }
    SessionFiles.expanded.add(dir);
    if (!SessionFiles.dirs[dir]) {
      try {
        SessionFiles.dirs[dir] = await SessionFiles._fetchDir(dir);
      } catch (e) {
        SessionFiles.expanded.delete(dir);
        toast('Could not open folder: ' + e.message, 'error');
      }
    }
    SessionFiles.renderTree();
  },

  // --- pane ---

  /** Open a file in the pane. opts.mode: 'source' | 'diff'; opts.ctx: dataset of a changed-file row;
   *  opts.discard: throw away this file's unsaved buffer instead of keeping it. */
  async openFile(relPath, opts = {}) {
    if (!relPath || !SessionFiles.slug) return;
    if (opts.discard) delete SessionFiles.buffers[relPath];
    else SessionFiles._stashBuffer();
    SessionFiles._clearSaveTimer();

    const ctx = opts.ctx || null;
    const isDeleted = !!(ctx && ctx.isDeleted === '1');
    const canDiff = SessionFiles._canDiff(ctx);
    const canPreview = !isDeleted && CodeView.isPreviewable(relPath);
    // Markdown and HTML land on their rendered form; everything else on the source.
    const mode = (opts.mode === 'diff' || isDeleted) && canDiff ? 'diff' : (canPreview ? 'preview' : 'source');
    SessionFiles.open = { path: relPath, mode, ctx, canDiff, canPreview, isDeleted, loading: !isDeleted, saved: '', mtime: null, changedLines: undefined };
    SessionFiles.renderPane();
    SessionFiles.renderTree();
    SessionFiles._updateActiveRow();
    if (canDiff && !isDeleted) SessionFiles._loadChangedLines(SessionFiles.open);
    if (isDeleted) return;

    try {
      const data = await api(`/api/projects/${encodeURIComponent(SessionFiles.slug)}/files/content?path=${encodeURIComponent(relPath)}`);
      const open = SessionFiles.open;
      if (!open || open.path !== relPath) return;
      const content = data.content != null ? data.content : '';
      Object.assign(open, {
        loading: false,
        saved: content,
        eol: /\r\n/.test(content) ? '\r\n' : '\n',
        mtime: data.mtime,
        size: data.size,
        binary: !!data.binary,
        tooLarge: !!data.tooLarge
      });
      SessionFiles.renderPane();
    } catch (e) {
      const open = SessionFiles.open;
      if (!open || open.path !== relPath) return;
      open.loading = false;
      open.error = e.message;
      SessionFiles.renderPane();
    }
  },

  /** A diff needs a recorded snapshot (hash) or a file the session created — otherwise source only. */
  _canDiff(ctx) {
    return !!ctx && (ctx.isNew === '1' || !!ctx.hash);
  },

  setMode(mode) {
    if (!SessionFiles.open || SessionFiles.open.mode === mode) return;
    if (mode === 'diff' && !SessionFiles.open.canDiff) return;
    if (mode === 'preview' && !SessionFiles.open.canPreview) return;
    SessionFiles._stashBuffer();
    SessionFiles.open.mode = mode;
    SessionFiles.renderPane();
  },

  renderPane() {
    const el = document.getElementById('sf-pane');
    if (!el) return;
    const open = SessionFiles.open;

    if (!open) {
      el.innerHTML = `<div class="sf-pane-empty">
        <p>Select a file to view its source.</p>
        <p class="sf-pane-hint">Files changed in this session are pinned at the top of the structure; everything else is below.</p>
      </div>`;
      return;
    }

    const name = open.path.split('/').pop();
    const dir = open.path.slice(0, open.path.length - name.length);
    const hasDiff = open.canDiff;
    const hasPreview = open.canPreview;
    const isDiff = open.mode === 'diff';
    const modeBtn = (mode, label) =>
      `<button class="sf-mode-btn${open.mode === mode ? ' active' : ''}" onclick="SessionFiles.setMode('${mode}')">${label}</button>`;

    el.innerHTML = `<div class="sf-pane-header">
        <span class="sf-pane-path" title="${escapeHtml(open.path)}">${dir ? `<span class="sf-pane-dir">${escapeHtml(dir)}</span>` : ''}${escapeHtml(name)}</span>
        <span class="sf-dirty sf-pane-dirty" id="sf-pane-dirty" style="display:none" title="Unsaved changes">&#9679;</span>
        <div class="sf-pane-actions">
          ${hasDiff || hasPreview ? `<div class="sf-mode-toggle">
            ${modeBtn('source', 'Source')}
            ${hasPreview ? modeBtn('preview', 'Preview') : ''}
            ${hasDiff ? modeBtn('diff', 'Diff') : ''}
          </div>` : ''}
          <button class="btn btn-sm btn-primary" id="sf-save-btn" onclick="SessionFiles.save()" disabled>Save</button>
          <div class="action-menu">
            <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="File actions">&#8942;</button>
            <div class="action-menu-panel">
              ${hasDiff ? '<button class="action-menu-item" onclick="event.stopPropagation(); SessionFiles.openDiffWindow()">Open diff in window</button>' : ''}
              <button class="action-menu-item" onclick="event.stopPropagation(); SessionFiles.reloadFile()">Reload from disk</button>
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.openCtxFile(SessionFiles.open.path)">Open in editor</button>
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.revealCtxFile(SessionFiles.open.path)">Show in file explorer</button>
            </div>
          </div>
        </div>
      </div>
      <div class="sf-pane-body" id="sf-pane-body"></div>
      <div class="sf-status-bar">
        <span class="sf-status-state" id="sf-status-state"></span>
        <span class="sf-status-sep">&middot;</span>
        <span id="sf-status-autosave"></span>
        <span class="sf-status-sep">&middot;</span>
        <span class="sf-status-hint">Ctrl+S to save</span>
      </div>`;

    // The body is rebuilt below, so any editor mounted in it is gone; _mountEditor re-creates it.
    SessionFiles.editor = null;

    const body = document.getElementById('sf-pane-body');
    if (open.loading) {
      showLoading(body, isDiff ? 'Computing diff...' : 'Loading file...');
    } else if (open.error) {
      body.innerHTML = `<div class="empty-state"><p>${escapeHtml(open.error)}</p></div>`;
    } else if (isDiff) {
      showLoading(body, 'Computing diff...');
      SessionFiles._renderDiff(body);
    } else if (open.isDeleted) {
      body.innerHTML = '<div class="empty-state"><p>This file was deleted during the session and no snapshot of it was recorded, so there is nothing left to show.</p></div>';
    } else if (open.binary) {
      body.innerHTML = `<div class="empty-state"><p>Binary file (${formatBytes(open.size)}) — open it in your editor instead.</p></div>`;
    } else if (open.tooLarge) {
      body.innerHTML = `<div class="empty-state"><p>File too large to edit here (${formatBytes(open.size)}) — open it in your editor instead.</p></div>`;
    } else if (open.mode === 'preview') {
      CodeView.preview(body, SessionFiles._currentText(), open.path);
    } else {
      body.innerHTML = '<div class="sf-editor-host code-colors" id="sf-editor-host"></div>';
      SessionFiles._mountEditor();
    }

    SessionFiles.renderStatus();
    SessionFiles._updateDirtyMarkers();
  },

  _projSlug() {
    return (Sessions._ctx && Sessions._ctx.projSlug) || SessionFiles.slug;
  },

  /** Text as it stands in the pane — the unsaved buffer if there is one, else what is on disk. */
  _currentText() {
    const open = SessionFiles.open;
    if (!open) return '';
    return SessionFiles.buffers[open.path] !== undefined ? SessionFiles.buffers[open.path] : open.saved;
  },

  async _renderDiff(body) {
    const open = SessionFiles.open;
    const ctx = open.ctx;
    const projSlug = SessionFiles._projSlug();
    try {
      const result = open._diffResult || await FileHistory.fetchDiffCurrent(ctx.session, ctx.hash, parseInt(ctx.from, 10), projSlug, open.path, {
        isNew: ctx.isNew === '1'
      });
      if (SessionFiles.open !== open || open.mode !== 'diff') return;
      open._diffResult = result;
      FileHistory.renderDiff(body, result, open.path);
    } catch (e) {
      if (SessionFiles.open !== open || open.mode !== 'diff') return;
      body.innerHTML = `<div class="empty-state"><p>Could not load diff: ${escapeHtml(e.message)}</p></div>`;
    }
  },

  /** Fetch the same diff-current hunks the Diff tab uses, but just to mark changed lines in Source. */
  async _loadChangedLines(open) {
    const ctx = open.ctx;
    try {
      const result = await FileHistory.fetchDiffCurrent(ctx.session, ctx.hash, parseInt(ctx.from, 10), SessionFiles._projSlug(), open.path, {
        isNew: ctx.isNew === '1'
      });
      if (SessionFiles.open !== open) return;
      open._diffResult = result;
      open.changedLines = result.tooLarge ? null : FileHistory.computeChangedLines(result.hunks || []);
      if (open.mode === 'source' && SessionFiles.editor) SessionFiles.editor.setChangedLines(open.changedLines);
    } catch (e) {
      open.changedLines = null;
    }
  },

  /** Open the resizable diff modal, wired for prev/next across every diffable changed file. */
  openDiffWindow() {
    const open = SessionFiles.open;
    if (!open || !open.canDiff) return;
    const ctx = open.ctx;
    const rows = [...document.querySelectorAll('#ctx-file-list .ctx-file-item')]
      .filter(row => SessionFiles._canDiff(row.dataset));
    FileHistory.showDiffCurrent(ctx.session, ctx.hash, parseInt(ctx.from, 10), SessionFiles._projSlug(), open.path, {
      isNew: ctx.isNew === '1',
      isDeleted: ctx.isDeleted === '1',
      allItems: rows,
      index: rows.findIndex(row => row.dataset.path === open.path)
    });
  },

  reloadFile() {
    const open = SessionFiles.open;
    if (!open) return;
    return SessionFiles.openFile(open.path, { mode: open.mode, ctx: open.ctx, discard: true });
  },

  // --- editor ---

  _mountEditor() {
    const open = SessionFiles.open;
    if (!open) return;
    SessionFiles.editor = CodeView.mount(document.getElementById('sf-editor-host'), SessionFiles._currentText(), open.path, {
      onChange: () => SessionFiles.onEdit(),
      onSave: () => SessionFiles.save(),
      trackChanges: open.canDiff,
      changedLines: open.changedLines
    });
    if (SessionFiles.editor && SessionFiles.editor.setViewState) {
      SessionFiles.editor.setViewState(FileViewCache.get(SessionFiles._projSlug(), open.path));
    }
  },

  /** Editor text with the file's own line endings restored — editors hand back LF regardless. */
  _editorValue() {
    if (!SessionFiles.editor) return null;
    const raw = SessionFiles.editor.getValue();
    const open = SessionFiles.open;
    return open && open.eol === '\r\n' ? raw.replace(/\r?\n/g, '\r\n') : raw;
  },

  onEdit() {
    const open = SessionFiles.open;
    if (!open || open.loading || open.mode !== 'source') return;
    const value = SessionFiles._editorValue();
    if (value === null) return;
    if (value === open.saved) delete SessionFiles.buffers[open.path];
    else SessionFiles.buffers[open.path] = value;
    SessionFiles.renderStatus();
    SessionFiles._updateDirtyMarkers();
    SessionFiles._scheduleAutosave();
  },

  isDirty(relPath) {
    const path = relPath || (SessionFiles.open && SessionFiles.open.path);
    return !!path && SessionFiles.buffers[path] !== undefined;
  },

  /** Keep unsaved text of the file leaving the pane so switching files never drops edits. */
  _stashBuffer() {
    const open = SessionFiles.open;
    if (!open || open.loading || open.mode !== 'source') return;
    const value = SessionFiles._editorValue();
    if (value === null) return;
    if (value === open.saved) delete SessionFiles.buffers[open.path];
    else SessionFiles.buffers[open.path] = value;
    if (SessionFiles.editor && SessionFiles.editor.getViewState) {
      FileViewCache.set(SessionFiles._projSlug(), open.path, SessionFiles.editor.getViewState());
    }
  },

  _scheduleAutosave() {
    SessionFiles._clearSaveTimer();
    if (!SessionFiles.autosaveEnabled() || !SessionFiles.isDirty()) return;
    SessionFiles._saveTimer = setTimeout(() => {
      SessionFiles._saveTimer = null;
      SessionFiles.save();
    }, SessionFiles.autosaveDelayMs());
  },

  _clearSaveTimer() {
    if (SessionFiles._saveTimer) {
      clearTimeout(SessionFiles._saveTimer);
      SessionFiles._saveTimer = null;
    }
  },

  async save() {
    SessionFiles._clearSaveTimer();
    SessionFiles._stashBuffer();
    const open = SessionFiles.open;
    if (!open || !SessionFiles.isDirty(open.path)) return;

    const path = open.path;
    const content = SessionFiles.buffers[path];
    SessionFiles._saving = true;
    SessionFiles.renderStatus();
    try {
      const res = await api(`/api/projects/${encodeURIComponent(SessionFiles.slug)}/files/content`, {
        method: 'PUT',
        body: { path, content }
      });
      if (SessionFiles.buffers[path] === content) delete SessionFiles.buffers[path];
      if (SessionFiles.open && SessionFiles.open.path === path) {
        SessionFiles.open.saved = content;
        SessionFiles.open.mtime = res.mtime;
        SessionFiles.open.size = res.size;
      }
      SessionFiles._savedAt = Date.now();
      SessionFiles._savedPath = path;
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      SessionFiles._saving = false;
      SessionFiles.renderStatus();
      SessionFiles._updateDirtyMarkers();
    }
  },

  // --- status ---

  renderStatus() {
    const stateEl = document.getElementById('sf-status-state');
    const autosaveEl = document.getElementById('sf-status-autosave');
    const saveBtn = document.getElementById('sf-save-btn');
    const dirty = SessionFiles.isDirty();

    if (autosaveEl) {
      autosaveEl.textContent = SessionFiles.autosaveEnabled()
        ? `autosave ${SessionFiles.autosaveDelayMs() / 1000}s`
        : 'autosave off';
    }
    if (saveBtn) saveBtn.disabled = !dirty || SessionFiles._saving;
    if (!stateEl) return;

    stateEl.classList.toggle('sf-status-dirty', dirty);
    const savedHere = SessionFiles.open && SessionFiles._savedPath === SessionFiles.open.path;
    if (SessionFiles._saving) stateEl.textContent = 'Saving...';
    else if (dirty) stateEl.textContent = '● Unsaved changes';
    else if (savedHere && SessionFiles._savedAt) stateEl.textContent = 'Saved ' + new Date(SessionFiles._savedAt).toLocaleTimeString();
    else stateEl.textContent = 'No changes';
  },

  _updateDirtyMarkers() {
    const paneDot = document.getElementById('sf-pane-dirty');
    if (paneDot) paneDot.style.display = SessionFiles.isDirty() ? '' : 'none';
    document.querySelectorAll('#sf-tree .sf-row-file, #sf-changed .ctx-file-item').forEach(row => {
      const dot = row.querySelector('.sf-dirty');
      if (dot) dot.style.display = SessionFiles.buffers[row.dataset.path] !== undefined ? '' : 'none';
    });
  },

  _updateActiveRow() {
    const path = SessionFiles.open && SessionFiles.open.path;
    document.querySelectorAll('#sf-tree .sf-row-file, #sf-changed .ctx-file-item').forEach(row => {
      row.classList.toggle('sf-row-active', row.dataset.path === path);
    });
  }
};

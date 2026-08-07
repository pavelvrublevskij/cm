Object.assign(Sessions, {
  _ctxCollapsed: new Set(),

  async pollContext(slug, sessionId) {
    const el = document.getElementById('sf-changed');
    if (!el) return;

    const info = Sessions._detailInfo;
    const from = info && info.created ? new Date(info.created).toISOString() : '';
    const to = info && info.modified ? new Date(info.modified).toISOString() : '';
    const qs = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';

    try {
      const data = await api(`/api/file-history/${encodeURIComponent(sessionId)}/context${qs}`);
      if (Sessions.detailState.sessionId !== sessionId) return;

      const hasFiles = data.files && data.files.length > 0;
      const hasPlans = data.plans && data.plans.length > 0;
      if (!hasFiles && !hasPlans) return;

      const ctx = Sessions._ctx && Sessions._ctx.sessionId === sessionId ? Sessions._ctx : null;
      const oldFiles = ctx ? ctx.files : [];
      const oldFilesMap = new Map(oldFiles.map(f => [f.path, f]));
      const changedPaths = new Set(
        data.files.filter(f => {
          const old = oldFilesMap.get(f.path);
          return !old || f.mtime !== old.mtime || !!f.isNew !== !!old.isNew || !!f.isDeleted !== !!old.isDeleted;
        }).map(f => f.path)
      );
      const filesDropped = data.files.length !== oldFiles.length;
      const plansChanged = Sessions._plansKey(data.plans) !== Sessions._plansKey(ctx && ctx.plans);
      if (!changedPaths.size && !filesDropped && !plansChanged) return;

      const savedSort = ctx && ctx.sort || 'default';
      Sessions.renderContext(el, sessionId, data);
      if (savedSort !== 'default') Sessions.sortCtxFiles(savedSort);

      Sessions._flashItems(el, changedPaths);

      // New/removed files change what the browsable tree's cached directory listings should show.
      if ((changedPaths.size || filesDropped) && typeof SessionFiles !== 'undefined' && SessionFiles.treeLoaded) {
        SessionFiles.reloadTree();
      }
    } catch (_) {}
  },

  _plansKey(plans) {
    return (plans || []).map(p => `${p.name}@${p.mtime}`).join('|');
  },

  annotateDetailPlan(stats) {
    if (stats && stats.hasPlan) {
      Sessions._detailHasPlan = true;
      Sessions.renderDetailMeta(null);
    }
  },

  async annotatePlans(sessions) {
    if (!sessions.length) { Sessions._planSessionIds = new Set(); return; }
    const slug = Sessions._searchSlug;
    if (!slug) { Sessions._planSessionIds = new Set(); return; }
    try {
      const ids = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/with-plans`);
      Sessions._planSessionIds = new Set(ids);
      Sessions._rerenderPlans();
    } catch (_) {
      Sessions._planSessionIds = new Set();
    }
  },

  async loadContext(sessionId, info) {
    const el = document.getElementById('sf-changed');
    if (!el) return;

    const from = info && info.created ? new Date(info.created).toISOString() : '';
    const to = info && info.modified ? new Date(info.modified).toISOString() : '';
    const qs = from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : '';

    try {
      const data = await api(`/api/file-history/${encodeURIComponent(sessionId)}/context${qs}`);
      if (Sessions.detailState.sessionId !== sessionId) return;
      Sessions.renderContext(el, sessionId, data);
      Sessions._flashItems(el, null);
    } catch (_) {
      Sessions.switchTab('conversation');
    }
  },

  renderContext(el, sessionId, data) {
    const hasFiles = data.files && data.files.length > 0;
    const hasPlans = data.plans && data.plans.length > 0;
    if (!hasFiles && !hasPlans) {
      Sessions._ctx = { sessionId, projSlug: data.projSlug || '', files: [], plans: [], sort: 'default' };
      el.innerHTML = '';
      Sessions._syncFilesTree();
      Sessions.switchTab('conversation');
      return;
    }

    Sessions._ctx = { sessionId, projSlug: data.projSlug || '', files: data.files || [], plans: data.plans || [], sort: 'default' };

    let html = '';

    if (hasFiles) {
      const sortHtml = `<div class="ctx-sort-bar">
        <span class="ctx-sort-label">Sort:</span>
        <button class="ctx-sort-btn active" onclick="Sessions.sortCtxFiles('default')">Default</button>
        <button class="ctx-sort-btn" onclick="Sessions.sortCtxFiles('asc')">A→Z</button>
        <button class="ctx-sort-btn" onclick="Sessions.sortCtxFiles('desc')">Z→A</button>
      </div>`;

      html += `<div class="ctx-section" id="ctx-files-section">
        <button class="ctx-toggle" onclick="Sessions.toggleCtx('ctx-files-section')">
          <span class="ctx-arrow">&#9660;</span> Changed in this session (${data.files.length})
        </button>
        <div class="ctx-body">
          ${sortHtml}
          <div id="ctx-file-list">${Sessions._renderCtxFileList()}</div>
        </div>
      </div>`;
    }

    if (hasPlans) {
      const planRows = data.plans.map(p =>
        `<div class="ctx-plan-row" onclick="Sessions.showPlan('${p.name}')">
          <span class="ctx-plan-name">${escapeHtml(p.name)}</span>
          <span class="ctx-plan-time">${timeAgo(p.mtime)}</span>
        </div>`
      ).join('');

      html += `<div class="ctx-section" id="ctx-plans-section">
        <button class="ctx-toggle" onclick="Sessions.toggleCtx('ctx-plans-section')">
          <span class="ctx-arrow">&#9660;</span> Plans (${data.plans.length})
        </button>
        <div class="ctx-body">${planRows}</div>
      </div>`;
    }

    el.innerHTML = html;
    Sessions._syncFilesTree();
  },

  /** Session-changed files with normalized separators, minus the .claude/ entries the panel hides. */
  _ctxVisibleFiles() {
    const files = (Sessions._ctx && Sessions._ctx.files) || [];
    return files
      .map(f => ({ ...f, path: f.path.replace(/\\/g, '/') }))
      .filter(f => !f.path.includes('/.claude/') && !f.path.startsWith('.claude/'));
  },

  /** Changed files are pinned above the tree, so the tree leaves them out. */
  _syncFilesTree() {
    if (typeof SessionFiles === 'undefined') return;
    SessionFiles.setChangedPaths(Sessions._ctxVisibleFiles().map(f => f.path));
  },

  /** Changed files render as a tree, same row pattern as the project structure below, plus status badges. */
  _renderCtxFileList() {
    const files = Sessions._ctxVisibleFiles();
    if (!files.length) return '<div class="ctx-empty">No files changed</div>';
    return Sessions._ctxTreeHtml(Sessions._buildCtxTree(files, Sessions._ctx.sort), '', 0);
  },

  _buildCtxTree(files, sort) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      const name = parts.pop();
      let node = root;
      for (const part of parts) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ ...f, name });
    }
    if (sort === 'asc' || sort === 'desc') Sessions._sortCtxTree(root, sort);
    return root;
  },

  _sortCtxTree(node, sort) {
    const cmp = (a, b) => (sort === 'desc' ? b.localeCompare(a) : a.localeCompare(b));
    node.dirs = new Map([...node.dirs.entries()].sort((a, b) => cmp(a[0], b[0])));
    node.files.sort((a, b) => cmp(a.name, b.name));
    node.dirs.forEach(child => Sessions._sortCtxTree(child, sort));
  },

  _ctxTreeHtml(node, prefix, depth) {
    const sessionId = Sessions._ctx.sessionId;
    let html = '';
    node.dirs.forEach((child, name) => {
      // Folders holding nothing but a single folder collapse into one row: public/js
      let label = name;
      let dirPath = prefix ? prefix + '/' + name : name;
      let target = child;
      while (!target.files.length && target.dirs.size === 1) {
        const [childName, grandChild] = [...target.dirs.entries()][0];
        label += '/' + childName;
        dirPath += '/' + childName;
        target = grandChild;
      }
      const collapsed = Sessions._ctxCollapsed.has(dirPath);
      html += `<div class="sf-row sf-row-dir" style="--sf-depth:${depth}"
        data-path="${escapeHtml(dirPath)}" onclick="Sessions.toggleCtxDir(this.dataset.path)">
        <span class="sf-arrow">${collapsed ? '&#9654;' : '&#9660;'}</span>
        <span class="sf-name">${escapeHtml(label)}</span>
      </div>`;
      if (!collapsed) html += Sessions._ctxTreeHtml(target, dirPath, depth + 1);
    });
    const openPath = typeof SessionFiles !== 'undefined' && SessionFiles.open ? SessionFiles.open.path : null;
    node.files.forEach(f => {
      const status = f.isNew ? 'new' : (f.isDeleted ? 'deleted' : 'edited');
      html += `<div class="sf-row sf-row-file ctx-file-item ctx-file-${status}${f.path === openPath ? ' sf-row-active' : ''}" style="--sf-depth:${depth}"
        data-session="${escapeHtml(sessionId)}"
        data-hash="${escapeHtml(f.hash || '')}"
        data-from="${f.versions[0] || ''}"
        data-path="${escapeHtml(f.path)}"
        data-is-new="${f.isNew ? '1' : ''}"
        data-is-deleted="${f.isDeleted ? '1' : ''}"
        onclick="Sessions._openCtxRow(this)">
        <span class="sf-name">${escapeHtml(f.name)}</span>
        <span class="sf-dirty" style="display:none" title="Unsaved changes">&#9679;</span>
        <span class="ctx-file-badge ctx-file-badge-${status}">${status}</span>
      </div>`;
    });
    return html;
  },

  toggleCtxDir(dirPath) {
    if (Sessions._ctxCollapsed.has(dirPath)) Sessions._ctxCollapsed.delete(dirPath);
    else Sessions._ctxCollapsed.add(dirPath);
    const list = document.getElementById('ctx-file-list');
    if (list) list.innerHTML = Sessions._renderCtxFileList();
  },

  _flashItems(el, pathSet) {
    if (el.style.display === 'none') {
      Sessions._pendingFlash = pathSet;
      return;
    }
    requestAnimationFrame(() => {
      el.querySelectorAll('.ctx-file-item').forEach(item => {
        if (!pathSet || pathSet.has(item.dataset.path)) {
          item.classList.remove('ctx-file-flash');
          void item.offsetWidth;
          item.classList.add('ctx-file-flash');
        }
      });
    });
  },

  sortCtxFiles(order) {
    Sessions._ctx.sort = order;
    document.querySelectorAll('.ctx-sort-btn').forEach(btn => {
      const labels = { default: 'Default', asc: 'A→Z', desc: 'Z→A' };
      btn.classList.toggle('active', btn.textContent.trim() === labels[order]);
    });
    const list = document.getElementById('ctx-file-list');
    if (list) list.innerHTML = Sessions._renderCtxFileList();
  },

  /** A changed file opens like any project file — source in the pane, diff a toggle away. */
  _openCtxRow(el) {
    SessionFiles.openFile(el.dataset.path, { ctx: { ...el.dataset } });
  },

  async openCtxFile(filePath) {
    const projSlug = Sessions._ctx ? Sessions._ctx.projSlug : '';
    if (!projSlug) return;
    try {
      await api('/api/file-history/open-file', { method: 'POST', body: { projSlug, filePath } });
    } catch (e) {
      toast('Could not open file: ' + e.message, 'error');
    }
  },

  async revealCtxFile(filePath) {
    const projSlug = Sessions._ctx ? Sessions._ctx.projSlug : '';
    if (!projSlug) return;
    try {
      await api('/api/file-history/reveal-file', { method: 'POST', body: { projSlug, filePath } });
    } catch (e) {
      toast('Could not show file in explorer: ' + e.message, 'error');
    }
  },

  toggleCtx(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const body = section.querySelector('.ctx-body');
    const arrow = section.querySelector('.ctx-arrow');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    arrow.innerHTML = open ? '&#9654;' : '&#9660;';
  },

  async showPlan(name) {
    const overlay = openModal({
      title: name,
      width: 800,
      body: '<div id="plan-modal-body"><div class="loading"><div class="spinner"></div>Loading…</div></div>',
      buttons: []
    });
    try {
      const plan = await api(`/api/plans/${encodeURIComponent(name)}`);
      overlay.querySelector('#plan-modal-body').innerHTML =
        `<div class="markdown-body">${renderMarkdown(plan.content)}</div>`;
    } catch (e) {
      overlay.querySelector('#plan-modal-body').innerHTML =
        `<div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
});

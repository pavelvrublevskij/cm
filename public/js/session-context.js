Object.assign(Sessions, {
  async pollContext(slug, sessionId) {
    const el = document.getElementById('session-context');
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
    const el = document.getElementById('session-context');
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
          <span class="ctx-arrow">&#9660;</span> Files edited (${data.files.length})
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
  },

  _renderCtxFileList() {
    const { sessionId, files, sort } = Sessions._ctx;
    if (!files.length) return '<div class="ctx-empty">No files changed</div>';

    const groups = new Map();
    files.forEach(f => {
      const normalized = f.path.replace(/\\/g, '/');
      if (normalized.includes('/.claude/') || normalized.startsWith('.claude/')) return;
      const lastSlash = normalized.lastIndexOf('/');
      const dir = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
      const name = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push({ ...f, name });
    });

    let dirs = [...groups.keys()];
    if (sort === 'asc') dirs.sort((a, b) => a.localeCompare(b));
    else if (sort === 'desc') dirs.sort((a, b) => b.localeCompare(a));

    return dirs.map(dir => {
      let groupFiles = groups.get(dir);
      if (sort === 'asc') groupFiles = groupFiles.slice().sort((a, b) => a.name.localeCompare(b.name));
      else if (sort === 'desc') groupFiles = groupFiles.slice().sort((a, b) => b.name.localeCompare(a.name));

      const header = `<div class="ctx-file-group-header">${escapeHtml(dir || '/')}</div>`;
      const items = groupFiles.map(f => {
        const status = f.isNew ? 'new' : (f.isDeleted ? 'deleted' : 'edited');
        const badge = `<span class="ctx-file-badge ctx-file-badge-${status}">${status}</span>`;
        const openBtns = f.isDeleted ? '' : `<div class="action-menu" data-path="${escapeHtml(f.path)}">
          <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="File actions">&#8942;</button>
          <div class="action-menu-panel">
            <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.openCtxFile(this.closest('.action-menu').dataset.path)">Open in editor</button>
            <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.revealCtxFile(this.closest('.action-menu').dataset.path)">Show in file explorer</button>
          </div>
        </div>`;
        return `<div class="ctx-file-item ctx-file-${status}"
          data-session="${escapeHtml(sessionId)}"
          data-hash="${escapeHtml(f.hash || '')}"
          data-from="${f.versions[0] || ''}"
          data-path="${escapeHtml(f.path)}"
          data-is-new="${f.isNew ? '1' : ''}"
          data-is-deleted="${f.isDeleted ? '1' : ''}"
          onclick="Sessions._openCtxDiff(this)">${badge}<span class="ctx-file-name">${escapeHtml(f.name)}</span>${openBtns}</div>`;
      }).join('');
      return `<div class="ctx-file-group">${header}${items}</div>`;
    }).join('');
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

  _openCtxDiff(el) {
    const { session, hash, from, path, isNew, isDeleted } = el.dataset;
    const allItems = [...document.querySelectorAll('#ctx-file-list .ctx-file-item')];
    const index = allItems.indexOf(el);
    FileHistory.showDiffCurrent(session, hash, parseInt(from, 10), Sessions._ctx.projSlug, path, {
      isNew: isNew === '1',
      isDeleted: isDeleted === '1',
      allItems,
      index
    });
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

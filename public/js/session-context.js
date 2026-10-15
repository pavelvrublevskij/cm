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

  async annotateArtifacts(sessions) {
    if (!sessions.length) { Sessions._artifactSessionIds = new Set(); return; }
    const slug = Sessions._searchSlug;
    if (!slug) { Sessions._artifactSessionIds = new Set(); return; }
    try {
      const ids = await api(`/api/projects/${encodeURIComponent(slug)}/sessions/with-artifacts`);
      Sessions._artifactSessionIds = new Set(ids);
      Sessions._rerenderArtifacts();
    } catch (_) {
      Sessions._artifactSessionIds = new Set();
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
    } catch (e) {
      if (Sessions.detailState.sessionId !== sessionId) return;
      Sessions.renderContextError(el, e);
    }
  },

  /** Loading "Changed in this session" failed outright -- say so instead of silently falling back
   *  to the Conversation tab, which reads identically to "nothing changed" and hides a real bug. */
  renderContextError(el, err) {
    Sessions._ctx = null;
    const message = (err && err.message) || 'Unknown error';
    el.innerHTML = `<div class="empty-state">
      <p>&#9888; Couldn't load file changes for this session.</p>
      <p>${escapeHtml(message)}</p>
      <p><a href="https://github.com/pavelvrublevskij/cm/issues/new" target="_blank" rel="noopener" class="app-footer-issue-link">&#9888; Report this issue</a></p>
    </div>`;
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

    const prev = Sessions._ctx && Sessions._ctx.sessionId === sessionId ? Sessions._ctx : null;
    const prompts = data.prompts || [];
    const fromPrompt = prev && prompts.some(p => p.index === prev.fromPrompt) ? prev.fromPrompt : 0;
    Sessions._ctx = { sessionId, projSlug: data.projSlug || '', files: data.files || [], plans: data.plans || [], prompts, fromPrompt, sort: 'default' };

    let html = '';

    if (hasFiles) {
      const changesOnly = typeof SessionChanges !== 'undefined' && SessionChanges.active;
      const sortHtml = `<div class="ctx-sort-bar">
        <span class="ctx-sort-label">Sort:</span>
        <button class="ctx-sort-btn active" onclick="Sessions.sortCtxFiles('default')">Default</button>
        <button class="ctx-sort-btn" onclick="Sessions.sortCtxFiles('asc')">A→Z</button>
        <button class="ctx-sort-btn" onclick="Sessions.sortCtxFiles('desc')">Z→A</button>
        <button class="ctx-sort-btn" onclick="Sessions.sortCtxFiles('prompt')">By prompt</button>
        <button class="ctx-sort-btn ctx-changes-only-btn${changesOnly ? ' active' : ''}" id="ctx-changes-only-btn"
          title="Show every change of this session as one diff" onclick="SessionChanges.toggle()">Changes only</button>
      </div>
      ${Sessions._ctxPromptFilterHtml()}`;

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
    if (typeof SessionChanges !== 'undefined' && SessionChanges.active) SessionChanges.render();
  },

  /** "From prompt" picker — lists only prompts that changed at least one file. */
  _ctxPromptFilterHtml() {
    const ctx = Sessions._ctx;
    const used = new Set(Sessions._ctxVisibleFiles().flatMap(f => f.prompts || []));
    const options = ctx.prompts.filter(p => used.has(p.index));
    if (!options.length) return '';
    const optionHtml = options.map(p =>
      `<option value="${p.index}"${p.index === ctx.fromPrompt ? ' selected' : ''}>#${p.index} ${escapeHtml(Sessions._ctxPromptLabel(p, 60))}</option>`
    ).join('');
    return `<div class="ctx-sort-bar ctx-prompt-filter">
      <span class="ctx-sort-label">From prompt:</span>
      <select class="ctx-prompt-select" id="ctx-prompt-select" onchange="Sessions.setCtxFromPrompt(this.value)">
        <option value="0"${ctx.fromPrompt ? '' : ' selected'}>All prompts</option>
        ${optionHtml}
      </select>
    </div>`;
  },

  _ctxPromptLabel(prompt, max) {
    const text = (prompt.text || '').replace(/\s+/g, ' ').trim() || '(empty prompt)';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  },

  setCtxFromPrompt(value) {
    Sessions._ctx.fromPrompt = parseInt(value, 10) || 0;
    const list = document.getElementById('ctx-file-list');
    if (list) list.innerHTML = Sessions._renderCtxFileList();
    if (typeof SessionChanges !== 'undefined' && SessionChanges.active) SessionChanges.render();
  },

  /** Visible changed files narrowed to those touched at or after the "From prompt" pick. */
  _ctxListedFiles() {
    const from = Sessions._ctx.fromPrompt;
    const files = Sessions._ctxVisibleFiles();
    return from ? files.filter(f => (f.prompts || []).some(i => i >= from)) : files;
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
    const files = Sessions._ctxListedFiles();
    if (!files.length) {
      return `<div class="ctx-empty">${Sessions._ctx.fromPrompt ? 'No files changed from this prompt on' : 'No files changed'}</div>`;
    }
    if (Sessions._ctx.sort === 'prompt') return Sessions._ctxPromptGroupsHtml(files);
    return Sessions._ctxTreeHtml(Sessions._buildCtxTree(files, Sessions._ctx.sort), '', 0);
  },

  /** One group per prompt that changed files, in prompt order; a file touched by several prompts
   *  shows under each. Files no tool call can be tied to a prompt go last. */
  _ctxPromptGroupsHtml(files) {
    const from = Sessions._ctx.fromPrompt;
    const byPrompt = new Map();
    const unlinked = [];
    for (const f of files) {
      const idxs = (f.prompts || []).filter(i => i >= from);
      if (!idxs.length) unlinked.push(f);
      for (const i of idxs) {
        if (!byPrompt.has(i)) byPrompt.set(i, []);
        byPrompt.get(i).push(f);
      }
    }
    const promptsByIndex = new Map(Sessions._ctx.prompts.map(p => [p.index, p]));
    let html = '';
    for (const i of [...byPrompt.keys()].sort((a, b) => a - b)) {
      const p = promptsByIndex.get(i) || { index: i, text: '' };
      html += `<div class="ctx-prompt-group" title="${escapeAttr(p.text || '')}">
        <span class="ctx-prompt-index">#${i}</span>
        <span class="ctx-prompt-text">${escapeHtml(Sessions._ctxPromptLabel(p, 80))}</span>
        ${p.timestamp ? `<span class="ctx-prompt-time">${timeAgo(p.timestamp)}</span>` : ''}
      </div>`;
      html += Sessions._ctxTreeHtml(Sessions._buildCtxTree(byPrompt.get(i), 'asc'), '', 0);
    }
    if (unlinked.length) {
      html += '<div class="ctx-prompt-group"><span class="ctx-prompt-text">Not linked to a prompt</span></div>';
      html += Sessions._ctxTreeHtml(Sessions._buildCtxTree(unlinked, 'asc'), '', 0);
    }
    return html;
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
      // isDeleted wins over isNew: a file created and then removed later in the same session
      // (e.g. moved to another path) has no current source to show, so it must read as deleted,
      // not new — otherwise the badge promises source that a click won't be able to produce.
      const status = f.isDeleted ? 'deleted' : (f.isNew ? 'new' : 'edited');
      const byScript = Sessions._ctxEditedByScript(f);
      html += `<div class="sf-row sf-row-file ctx-file-item ctx-file-${status}${f.path === openPath ? ' sf-row-active' : ''}" style="--sf-depth:${depth}"
        data-session="${escapeHtml(sessionId)}"
        data-hash="${escapeHtml(f.hash || '')}"
        data-from="${f.versions[0] || ''}"
        data-path="${escapeHtml(f.path)}"
        data-is-new="${f.isNew ? '1' : ''}"
        data-is-deleted="${f.isDeleted ? '1' : ''}"
        data-read-base="${f.readBase ? '1' : ''}"
        onclick="Sessions._openCtxRow(this)">
        <span class="sf-name">${escapeHtml(f.name)}</span>
        <span class="sf-dirty" style="display:none" title="Unsaved changes">&#9679;</span>
        <span class="ctx-file-badge ctx-file-badge-${byScript ? 'script' : status}">${byScript ? 'edited by script' : status}</span>
      </div>`;
    });
    return html;
  },

  /** Changed only by shell commands, with no recorded "before" text to diff against. */
  _ctxEditedByScript(f) {
    return !f.isDeleted && !f.isNew && !f.hash && !f.readBase && !!(f.scripts && f.scripts.length);
  },

  _ctxScriptsFor(path) {
    const f = Sessions._ctxVisibleFiles().find(f => f.path === path);
    return f && f.scripts ? f.scripts : [];
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
      const labels = { default: 'Default', asc: 'A→Z', desc: 'Z→A', prompt: 'By prompt' };
      if (btn.id === 'ctx-changes-only-btn') return;
      btn.classList.toggle('active', btn.textContent.trim() === labels[order]);
    });
    const list = document.getElementById('ctx-file-list');
    if (list) list.innerHTML = Sessions._renderCtxFileList();
    if (typeof SessionChanges !== 'undefined' && SessionChanges.active) SessionChanges.render();
  },

  /** A changed file opens on its diff by default — source is a toggle away. */
  _openCtxRow(el) {
    if (typeof SessionChanges !== 'undefined' && SessionChanges.active) return SessionChanges.scrollTo(el.dataset.path);
    SessionFiles.openFile(el.dataset.path, { mode: 'diff', ctx: { ...el.dataset } });
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

// --- File History diff rendering ---

const FileHistory = {
  async showDiffCurrent(sessionId, hash, version, projSlug, filePath, opts = {}) {
    const isNew = !!opts.isNew;
    const isDeleted = !!opts.isDeleted;
    const allItems = opts.allItems || null;
    const index = opts.index != null ? opts.index : -1;

    const label = FileHistory._makeLabel(isNew, isDeleted, version);

    let navHtml = '';
    if (allItems && allItems.length > 1 && index >= 0) {
      const hasPrev = index > 0;
      const hasNext = index < allItems.length - 1;
      navHtml = `<div class="diff-nav">
        <div class="diff-nav-btns">
          <button class="diff-nav-btn" id="diff-nav-prev"${hasPrev ? '' : ' disabled'}>&#8592; prev</button>
          <button class="diff-nav-btn" id="diff-nav-next"${hasNext ? '' : ' disabled'}>next &#8594;</button>
        </div>
        <span class="diff-nav-label">${index + 1} / ${allItems.length}</span>
      </div>`;
    }

    const state = { filePath, isDeleted };

    const overlay = openModal({
      title: `${filePath} ${label}`,
      cls: 'modal--diff',
      resizable: true,
      body: `${navHtml}<div id="fh-diff-body"><div class="loading"><div class="spinner"></div>Computing diff…</div></div>`,
      buttons: [
        { label: 'Show in explorer', onClick: () => { Sessions.revealCtxFile(state.filePath); return false; } },
        { label: 'Open in editor', primary: true, onClick: () => { Sessions.openCtxFile(state.filePath); return false; } }
      ]
    });

    overlay._fhState = state;
    FileHistory._updateActionButtons(overlay, state);

    if (allItems && allItems.length > 1 && index >= 0) {
      FileHistory._updateNav(overlay, allItems, index);
    }

    await FileHistory._loadDiff(overlay, sessionId, hash, version, projSlug, filePath, { isNew, isDeleted });
  },

  _updateActionButtons(overlay, state) {
    overlay.querySelectorAll('.btn-group .btn').forEach(btn => {
      if (btn.textContent === 'Show in explorer' || btn.textContent === 'Open in editor') {
        btn.disabled = state.isDeleted;
        btn.title = state.isDeleted ? 'File was deleted' : '';
      }
    });
  },

  _makeLabel(isNew, isDeleted, version) {
    return isNew ? '(new file)' : isDeleted ? '(deleted)' : `v${version} → current`;
  },

  _updateNav(overlay, allItems, index) {
    const prevBtn = overlay.querySelector('#diff-nav-prev');
    const nextBtn = overlay.querySelector('#diff-nav-next');
    const navLabel = overlay.querySelector('.diff-nav-label');
    if (prevBtn) { prevBtn.disabled = index <= 0; prevBtn.onclick = () => FileHistory._navToDiff(overlay, allItems, index - 1); }
    if (nextBtn) { nextBtn.disabled = index >= allItems.length - 1; nextBtn.onclick = () => FileHistory._navToDiff(overlay, allItems, index + 1); }
    if (navLabel) navLabel.textContent = `${index + 1} / ${allItems.length}`;
  },

  /** Fetch the "recorded snapshot vs file on disk" diff for one file. */
  fetchDiffCurrent(sessionId, hash, version, projSlug, filePath, { isNew } = {}) {
    const params = new URLSearchParams({ projSlug, filePath });
    if (isNew) params.set('isNew', 'true');
    else params.set('version', String(version));
    const hashSeg = isNew ? 'none' : encodeURIComponent(hash);
    return api(`/api/file-history/${encodeURIComponent(sessionId)}/${hashSeg}/diff-current?${params.toString()}`);
  },

  /** 1-indexed line numbers in the *current* file touched by the session, per diff-current hunks. */
  computeChangedLines(hunks) {
    const lines = new Set();
    for (const hunk of hunks) {
      let newLine = hunk.newStart;
      for (const l of hunk.lines) {
        if (l.type === '+') lines.add(newLine++);
        else if (l.type === '=') newLine++;
      }
    }
    return lines;
  },

  async _loadDiff(overlay, sessionId, hash, version, projSlug, filePath, { isNew, isDeleted }) {
    try {
      const result = await FileHistory.fetchDiffCurrent(sessionId, hash, version, projSlug, filePath, { isNew });
      const body = overlay.querySelector('#fh-diff-body');
      if (body) FileHistory.renderDiff(body, result, filePath);
    } catch (e) {
      const body = overlay.querySelector('#fh-diff-body');
      if (body) body.innerHTML = `<div class="empty-state"><p>Could not load diff: ${escapeHtml(e.message)}</p></div>`;
    }
  },

  async _navToDiff(overlay, allItems, newIndex) {
    const el = allItems[newIndex];
    if (!el) return;
    const { session, hash, from, path, isNew, isDeleted } = el.dataset;
    const isNewBool = isNew === '1';
    const isDeletedBool = isDeleted === '1';
    const version = parseInt(from, 10);

    const titleEl = overlay.querySelector('h3');
    if (titleEl) titleEl.textContent = `${path} ${FileHistory._makeLabel(isNewBool, isDeletedBool, version)}`;

    if (overlay._fhState) {
      overlay._fhState.filePath = path;
      overlay._fhState.isDeleted = isDeletedBool;
      FileHistory._updateActionButtons(overlay, overlay._fhState);
    }

    FileHistory._updateNav(overlay, allItems, newIndex);

    const diffBody = overlay.querySelector('#fh-diff-body');
    if (diffBody) diffBody.innerHTML = '<div class="loading"><div class="spinner"></div>Computing diff…</div>';

    const projSlug = Sessions._ctx ? Sessions._ctx.projSlug : '';
    await FileHistory._loadDiff(overlay, session, hash, version, projSlug, path, {
      isNew: isNewBool,
      isDeleted: isDeletedBool
    });
  },

  /** Render just the diff — syntax-coloured per line, using the file's CodeMirror mode. */
  renderDiff(container, result, filePath) {
    if (result.tooLarge) { container.innerHTML = '<div class="empty-state"><p>The differing region of this file is too large to diff (&gt;8000 lines)</p></div>'; return; }
    if (!result.hunks.length) { container.innerHTML = '<div class="empty-state"><p>No differences found</p></div>'; return; }

    const mode = codeModeFor(filePath);
    const stats = `<div class="diff-stats">
      <span class="diff-added">+${result.stats.added} added</span>
      <span class="diff-removed">-${result.stats.removed} removed</span>
    </div>`;

    const hunks = result.hunks.map(hunk => {
      let oldLine = hunk.oldStart, newLine = hunk.newStart;
      const lines = hunk.lines.map(l => {
        const cls = l.type === '+' ? 'diff-line-add' : l.type === '-' ? 'diff-line-del' : 'diff-line-ctx';
        const prefix = l.type === '+' ? '+' : l.type === '-' ? '-' : ' ';
        const oldNum = l.type === '+' ? '' : oldLine++;
        const newNum = l.type === '-' ? '' : newLine++;
        return `<div class="diff-line ${cls}">`
          + `<span class="diff-linenum diff-linenum-old">${oldNum}</span>`
          + `<span class="diff-linenum diff-linenum-new">${newNum}</span>`
          + `<span class="diff-prefix">${prefix}</span><span class="diff-content">${highlightCode(l.content, mode)}</span></div>`;
      }).join('');
      return `<div class="diff-hunk-header">@@ -${hunk.oldStart} +${hunk.newStart} @@</div>` + lines;
    }).join('<div class="diff-separator"></div>');

    container.innerHTML = stats + `<div class="diff-view code-colors">${hunks}</div>`;
  }
};

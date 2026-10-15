// --- Files tab "Changes only": every change of the session as one stacked diff ---

const SessionChanges = {
  active: false,
  _token: 0,

  reset() {
    SessionChanges.active = false;
    SessionChanges._token++;
    SessionChanges._applyLayout();
  },

  toggle() {
    SessionChanges.active = !SessionChanges.active;
    SessionChanges._token++;
    SessionChanges._applyLayout();
    if (SessionChanges.active) SessionChanges.render();
    else SessionFiles.renderPane();
  },

  /** The project tree is hidden while the pane shows only the session's changes. */
  _applyLayout() {
    const tree = document.querySelector('#sf-structure .sf-tree-section');
    if (tree) tree.style.display = SessionChanges.active ? 'none' : '';
    const btn = document.getElementById('ctx-changes-only-btn');
    if (btn) btn.classList.toggle('active', SessionChanges.active);
  },

  /** Changed files in list order, each once (the "By prompt" grouping can repeat a file). */
  _files() {
    if (!Sessions._ctx) return [];
    const order = [...document.querySelectorAll('#ctx-file-list .ctx-file-item')].map(row => row.dataset.path);
    const listed = new Map(Sessions._ctxListedFiles().map(f => [f.path, f]));
    const seen = new Set();
    const files = [];
    for (const p of order) {
      if (seen.has(p) || !listed.has(p)) continue;
      seen.add(p);
      files.push(listed.get(p));
    }
    return files;
  },

  async render() {
    const el = document.getElementById('sf-pane');
    if (!el || !SessionChanges.active) return;
    const token = ++SessionChanges._token;
    const files = SessionChanges._files();
    const ctx = Sessions._ctx;
    const from = ctx && ctx.fromPrompt ? ` from prompt #${ctx.fromPrompt} on` : '';

    if (!files.length) {
      el.innerHTML = `<div class="sf-pane-empty"><p>No files changed${from}.</p></div>`;
      return;
    }

    el.innerHTML = `<div class="sf-pane-header">
        <span class="sf-pane-path">${files.length} changed file${files.length === 1 ? '' : 's'}${escapeHtml(from)}</span>
        <span class="sc-totals" id="sc-totals"></span>
      </div>
      <div class="sf-pane-body sc-body">
        <div class="diff-readonly-note">Read-only — each file's recorded snapshot compared to the file on disk. Hover a line for <strong>&rarr; source</strong> to open it there.</div>
        ${files.map((f, i) => {
          const status = f.isDeleted ? 'deleted' : (f.isNew ? 'new' : 'edited');
          const byScript = Sessions._ctxEditedByScript(f);
          return `<div class="sc-file" data-path="${escapeHtml(f.path)}">
            <div class="sc-file-header">
              <span class="sc-file-path" title="${escapeAttr(f.path)}">${escapeHtml(f.path)}</span>
              <span class="ctx-file-badge ctx-file-badge-${byScript ? 'script' : status}">${byScript ? 'edited by script' : status}</span>
              <span class="sc-file-stats" id="sc-stats-${i}"></span>
              ${f.isDeleted ? '' : `<button class="btn btn-sm" onclick="SessionChanges.openSource(${escapeAttr(JSON.stringify(f.path))})">Open</button>`}
            </div>
            <div class="sc-file-body" id="sc-body-${i}"><div class="loading"><div class="spinner"></div>Computing diff…</div></div>
          </div>`;
        }).join('')}
      </div>`;

    const totals = { added: 0, removed: 0 };
    await Promise.all(files.map(async (f, i) => {
      const body = document.getElementById(`sc-body-${i}`);
      if (!SessionFiles._canDiff({ hash: f.hash, isNew: f.isNew ? '1' : '', readBase: f.readBase ? '1' : '' })) {
        if (f.scripts && f.scripts.length) {
          body.innerHTML = SessionFiles.scriptsHtml(f.scripts, true);
          return;
        }
        body.innerHTML = '<div class="empty-state"><p>No recorded snapshot for this file — open it to see its source.</p></div>';
        return;
      }
      try {
        const result = await FileHistory.fetchDiffCurrent(ctx.sessionId, f.hash, f.versions[0], ctx.projSlug, f.path, {
          isNew: f.isNew, readBase: f.readBase
        });
        if (token !== SessionChanges._token) return;
        FileHistory.renderDiff(body, result, f.path, { compact: true, onGotoSource: line => SessionChanges.openSource(f.path, line) });
        if (result.stats) {
          totals.added += result.stats.added;
          totals.removed += result.stats.removed;
          const stats = document.getElementById(`sc-stats-${i}`);
          if (stats) stats.innerHTML = `<span class="diff-added">+${result.stats.added}</span> <span class="diff-removed">-${result.stats.removed}</span>`;
        }
      } catch (e) {
        if (token !== SessionChanges._token) return;
        body.innerHTML = `<div class="empty-state"><p>Could not load diff: ${escapeHtml(e.message)}</p></div>`;
      }
    }));
    if (token !== SessionChanges._token) return;
    const totalsEl = document.getElementById('sc-totals');
    if (totalsEl) totalsEl.innerHTML = `<span class="diff-added">+${totals.added}</span> <span class="diff-removed">-${totals.removed}</span>`;
  },

  scrollTo(path) {
    const block = [...document.querySelectorAll('#sf-pane .sc-file')].find(b => b.dataset.path === path);
    if (block) block.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },

  /** Leave the combined view (openFile does that) and open `path` in Source, optionally at `line`. */
  openSource(path, line) {
    const row = [...document.querySelectorAll('#ctx-file-list .ctx-file-item')].find(r => r.dataset.path === path);
    SessionFiles.openFile(path, { mode: 'source', ctx: row ? { ...row.dataset } : null });
    if (line) SessionFiles.gotoSource(path, line);
  },

  /** Called when a single file is opened in the pane — the combined view gives way to it. */
  leave() {
    if (!SessionChanges.active) return;
    SessionChanges.active = false;
    SessionChanges._token++;
    SessionChanges._applyLayout();
  }
};

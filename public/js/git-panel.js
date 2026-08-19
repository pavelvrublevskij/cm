// --- GitPanel ---
// Everything git for one project in a single view: what a commit would include and what a push
// would send (with the commit/push actions themselves), the recipe list, and a project shell
// (xterm.js over the terminal WebSocket bridge with ?mode=shell). Mounted into whichever host is
// asking: the project-detail Git tab, or the modal the footer git button opens from a session view.
// One shell per project, so only one mount holds it. The commit/push actions run through
// GitActions, which is also what the footer button's state comes from. The recipe column only exists
// while a shell does — a recipe with nowhere to be typed is not worth the width — and can be folded
// to a rail from there, which is remembered for the next time a shell opens.
//
// Recipes are typed into the shell without a trailing newline — nothing runs until the user hits
// Enter. Closing the panel detaches: the pty keeps running and reattaches with its scrollback.
//
// Clicking a changed file shows its diff in the middle column beside the shell rather than in a
// dialog: the panel already has the room, and the shell stays alive behind the switch.

const GitPanel = {
  LOG_PAGE: 50,

  RECIPES_COLLAPSED_KEY: 'claude-manager-git-recipes-collapsed',
  VIEW_MODE_KEY: 'claude-manager-git-changes-view',

  BUSY_LABEL: {
    'commit': 'Committing…',
    'commit-push': 'Committing & pushing…',
    'push': 'Pushing…',
    'pull': 'Pulling…',
    'fetch': 'Fetching…',
  },

  STATUS_BADGE: {
    A: 'ctx-file-badge-new',
    M: 'ctx-file-badge-edited',
    D: 'ctx-file-badge-deleted',
    R: 'ctx-file-badge-edited',
    C: 'ctx-file-badge-new',
  },

  STATUS_LABEL: { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' },

  BADGE_CLASS: {
    new: 'ctx-file-badge-new',
    modified: 'ctx-file-badge-edited',
    deleted: 'ctx-file-badge-deleted',
    untracked: 'ctx-file-badge-new'
  },

  _slug: null,
  _hostId: null,
  _info: null,
  _shellInfo: null,
  _view: null,
  _commitDetail: null,
  _openCategories: null,
  _pane: 'shell',       // 'shell' | 'diff' | 'history' — which pane of the middle column shows
  _diffPath: null,
  _diffSha: null,
  _log: null,           // { commits, offset, done } once history has been read
  _openSha: null,
  _busy: null,          // 'commit' | 'commit-push' | 'push' while that action is in flight

  /** Render into `hostId` for `slug`, reattaching to a shell that is already running. */
  async mount(hostId, slug) {
    if (GitPanel._view && (GitPanel._hostId !== hostId || GitPanel._slug !== slug)) {
      GitPanel._disposeView();
    }
    GitPanel._hostId = hostId;
    GitPanel._slug = slug;
    if (GitPanel._openCategories === null) {
      GitPanel._openCategories = new Set([GitRecipes.CATEGORIES[0].name]);
    }

    GitPanel._info = await GitApi.info(slug) || { available: false };
    GitPanel._shellInfo = await GitApi.shellInfo(slug) || { available: false, running: false };

    GitPanel._render();
    if (GitPanel._info.available && GitPanel._shellInfo.running && !GitPanel.shellOpen()) GitPanel.openShell();
  },

  /** Leave the pty running and drop only this view of it. */
  unmount() {
    GitPanel._disposeView();
    GitPanel._hostId = null;
  },

  _render() {
    const el = document.getElementById(GitPanel._hostId);
    if (!el) return;

    if (!GitPanel._info || !GitPanel._info.available) {
      el.innerHTML = `<div class="empty-state">${GitPanel._unavailableText()}</div>`;
      return;
    }

    el.innerHTML = `
      <div class="git-panel-layout${GitPanel._layoutClasses()}" id="git-panel-layout">
        <div class="git-changes" id="git-changes"></div>
        ${GitPanel._shellHtml()}
        ${GitPanel._recipesHtml()}
      </div>`;

    GitPanel._renderChanges();
    GitPanel._renderRecipes();
    GitPanel._showShell(GitPanel.shellOpen());
    GitPanel._applyPaneState();
    if (GitPanel._pane === 'diff' && GitPanel._diffPath) GitPanel.openDiff(GitPanel._diffPath, GitPanel._diffSha);
    if (GitPanel._pane === 'history') GitPanel._renderHistory();
  },

  /** Two different problems, told apart so the user is not sent looking for the wrong one. */
  _unavailableText() {
    return (GitPanel._info || {}).reason === 'git-missing'
      ? 'Git is not installed on this machine.'
      : 'This project is not a git repository.';
  },

  /**
   * Middle column. Shell, diff and history are all mounted and swapped with a class, never
   * re-created: a diff must not tear down a live terminal, and the terminal must not lose its
   * scrollback to a glance at a file.
   */
  _shellHtml() {
    const ptyMissing = GitPanel._shellInfo && GitPanel._shellInfo.available === false;
    const idleBody = ptyMissing
      ? '<div class="git-shell-hint">A shell is unavailable: node-pty is not installed on the server.</div>'
      : `<button class="btn btn-primary" onclick="GitPanel.openShell()">Open Shell</button>
         <div class="git-shell-hint">Runs in the project directory. Clicked recipes are typed here, not executed.</div>`;

    return `<div class="git-shell" id="git-workspace">
        <div class="git-shell-header">
          <div class="git-pane-tabs">
            <button class="sf-mode-btn" id="git-pane-tab-shell" onclick="GitPanel.showPane('shell')">Shell</button>
            <button class="sf-mode-btn" id="git-pane-tab-diff" onclick="GitPanel.showPane('diff')">Diff</button>
            <button class="sf-mode-btn" id="git-pane-tab-history" onclick="GitPanel.showPane('history')">History</button>
          </div>
          <span class="git-shell-cwd" id="git-pane-subject">${escapeHtml(GitPanel._branchLabel())}</span>
          <span class="terminal-pane-status" id="git-shell-status">disconnected</span>
          <div class="git-shell-actions">
            <button class="icon-btn" onclick="GitPanel.reconnect()" title="Restart shell" aria-label="Restart shell">&#x21bb;</button>
            <button class="icon-btn" onclick="GitPanel.killShell()" title="End this shell" aria-label="End this shell">&#x2715;</button>
          </div>
        </div>
        <div class="git-pane git-pane-shell" id="git-pane-shell">
          <div class="git-shell-idle" id="git-shell-idle">${idleBody}</div>
          <div class="git-shell-host" id="git-shell-host"></div>
        </div>
        <div class="git-pane git-pane-diff" id="git-pane-diff">
          <div class="git-diff-body" id="git-diff-body">
            <div class="git-changes-empty">Click a changed file to see what committing it would record.</div>
          </div>
        </div>
        <div class="git-pane git-pane-history" id="git-pane-history">
          <div class="git-history-body" id="git-history-body"></div>
        </div>
      </div>`;
  },

  PANES: ['shell', 'diff', 'history'],

  /** Swap which pane is visible. The shell needs a refit after having been hidden. */
  showPane(pane) {
    GitPanel._pane = GitPanel.PANES.includes(pane) ? pane : 'shell';
    GitPanel._applyPaneState();
    if (GitPanel._pane === 'shell') GitPanel._sendResize();
    if (GitPanel._pane === 'history' && !GitPanel._log) GitPanel.loadLog();
  },

  _applyPaneState() {
    const workspace = document.getElementById('git-workspace');
    if (workspace && workspace.classList) {
      for (const pane of GitPanel.PANES) {
        workspace.classList.toggle(`showing-${pane}`, GitPanel._pane === pane);
      }
    }

    for (const pane of GitPanel.PANES) {
      const tab = document.getElementById(`git-pane-tab-${pane}`);
      if (tab && tab.classList) tab.classList.toggle('active', GitPanel._pane === pane);
    }

    const subject = document.getElementById('git-pane-subject');
    if (subject) subject.textContent = GitPanel._paneSubject();
  },

  _paneSubject() {
    if (GitPanel._pane === 'diff' && GitPanel._diffPath) {
      return GitPanel._diffSha ? `${GitPanel._diffSha} · ${GitPanel._diffPath}` : GitPanel._diffPath;
    }
    return GitPanel._branchLabel();
  },

  /**
   * Show one file's diff in the middle column — no dialog, the panel already has the room. With a
   * sha it is that commit's change to the file; without, what committing it now would record.
   */
  async openDiff(filePath, sha) {
    GitPanel._diffPath = filePath;
    GitPanel._diffSha = sha || null;
    GitPanel.showPane('diff');

    const body = document.getElementById('git-diff-body');
    if (body) showLoading(body, `Diffing ${filePath}…`);

    const result = await GitApi.diff(GitPanel._slug, filePath, sha).catch(e => ({ error: e.message }));
    if (GitPanel._diffPath !== filePath || GitPanel._diffSha !== (sha || null)) return;   // superseded
    GitPanel._renderDiff(result, filePath);
  },

  _renderDiff(result, filePath) {
    const body = document.getElementById('git-diff-body');
    if (!body) return;
    if (result.error) {
      body.innerHTML = `<div class="git-changes-empty">Could not diff ${escapeHtml(filePath)}: ${escapeHtml(result.error)}</div>`;
      return;
    }
    if (result.binary) {
      body.innerHTML = `<div class="git-changes-empty">${escapeHtml(filePath)} is a binary file.</div>`;
      return;
    }
    FileHistory.renderDiff(body, result, filePath);
  },

  /** The column, plus the rail that brings it back once folded. */
  _recipesHtml() {
    return `<div class="git-recipes" id="git-recipes-col">
        <div class="git-recipes-header">
          <span class="git-recipes-title">Recipes</span>
          <button class="icon-btn" onclick="GitPanel.toggleRecipes()" title="Hide recipes" aria-label="Hide recipes">&#x00BB;</button>
        </div>
        <div class="git-recipes-list" id="git-recipes"></div>
      </div>
      <button class="git-recipes-rail" onclick="GitPanel.toggleRecipes()" title="Show recipes" aria-label="Show recipes">
        <span>&#x00AB; Recipes</span>
      </button>`;
  },

  /** Re-read git state and repaint the changes card, keeping a half-typed message. */
  async refreshIfMounted() {
    if (!GitPanel._hostId || !GitPanel._slug) return;
    const draft = GitPanel._draftMessage();
    const info = await GitApi.info(GitPanel._slug);
    if (!info) return;                       // transient failure: keep showing what we had
    GitPanel._info = info;
    GitPanel._renderChanges();
    GitPanel.invalidateLog();
    if (draft) {
      const box = document.getElementById('git-panel-msg');
      if (box) box.value = draft;
    }
  },

  _draftMessage() {
    const box = document.getElementById('git-panel-msg');
    return box ? box.value : '';
  },

  /** What a commit would include, and what a push would send. */
  _renderChanges() {
    const host = document.getElementById('git-changes');
    if (!host) return;
    host.innerHTML = GitPanel._toCommitHtml() + GitPanel._toPushHtml();
    GitPanel.syncGroups();
  },

  _toCommitHtml() {
    const files = (GitPanel._info || {}).files || [];
    const filesBody = `<div class="git-changes-files">${files.length
      ? GitPanel._fileListHtml(files)
      : '<div class="git-changes-empty">Nothing to commit — the working tree is clean.</div>'}</div>`;

    const selectAll = files.length > 1
      ? `<div class="git-changes-select">
           <button class="git-select-btn" onclick="GitPanel.setAllFiles(true)">All</button>
           <button class="git-select-btn" onclick="GitPanel.setAllFiles(false)">None</button>
         </div>`
      : '';

    return `
      <div class="git-changes-header">
        <span class="git-changes-title">To commit</span>
        ${files.length ? `<span class="git-count-badge">${files.length}</span>` : ''}
        ${selectAll}
        ${files.length ? GitPanel._viewToggleHtml() : ''}
        <button class="icon-btn git-changes-reload" onclick="GitPanel.refreshIfMounted()" title="Reload git state" aria-label="Reload git state">&#x21bb;</button>
      </div>
      ${filesBody}
      <textarea id="git-panel-msg" class="git-changes-msg" rows="2" placeholder="Commit message…"></textarea>
      <div class="git-changes-actions" id="git-changes-actions">${GitPanel._actionsHtml()}</div>`;
  },

  _viewToggleHtml() {
    const mode = GitPanel.viewMode();
    const btn = (value, label) => `<button class="sf-mode-btn${mode === value ? ' active' : ''}"
        onclick="GitPanel.setViewMode('${value}')">${label}</button>`;
    return `<div class="git-view-toggle">${btn('flat', 'Flat')}${btn('tree', 'Tree')}</div>`;
  },

  viewMode() {
    try { return localStorage.getItem(GitPanel.VIEW_MODE_KEY) === 'tree' ? 'tree' : 'flat'; }
    catch (_) { return 'flat'; }
  },

  setViewMode(mode) {
    const draft = GitPanel._draftMessage();
    try { localStorage.setItem(GitPanel.VIEW_MODE_KEY, mode === 'tree' ? 'tree' : 'flat'); } catch (_) {}
    GitPanel._renderChanges();
    const box = document.getElementById('git-panel-msg');
    if (box && draft) box.value = draft;
  },

  _fileListHtml(files) {
    return GitPanel.viewMode() === 'tree'
      ? GitPanel._treeHtml(files)
      : files.map(f => GitPanel._fileRowHtml(f, 0)).join('');
  },

  /** A row is not a label: only its checkbox toggles it, so reading a path cannot deselect a file. */
  _fileRowHtml(file, depth) {
    const badge = GitPanel.BADGE_CLASS[file.label] || 'ctx-file-badge-edited';
    const name = GitPanel.viewMode() === 'tree' ? file.path.split('/').pop() : file.path;
    return `
      <div class="git-file-row" style="--git-depth:${depth}">
        <input type="checkbox" class="git-file-cb" value="${escapeAttr(file.path)}" checked
          onchange="GitPanel.syncGroups()" title="Include in the commit">
        <span class="ctx-file-badge git-file-badge ${escapeHtml(badge)}">${escapeHtml(file.label)}</span>
        <button class="git-file-path git-file-link" data-path="${escapeAttr(file.path)}"
          onclick="GitPanel.openDiff(this.getAttribute('data-path'))"
          title="Show what committing ${escapeAttr(file.path)} would record">${escapeHtml(name)}</button>
      </div>`;
  },

  /** Group paths into nested folders so a whole folder can be unticked at once. */
  _buildTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let node = root;
      let prefix = '';
      for (const dir of parts.slice(0, -1)) {
        prefix += dir + '/';
        if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [], prefix });
        node = node.dirs.get(dir);
      }
      node.files.push(file);
    }
    return root;
  },

  _treeHtml(files) {
    const render = (node, depth) => {
      let html = '';
      for (const [name, dir] of node.dirs) {
        html += `
          <div class="git-tree-folder" style="--git-depth:${depth}">
            <input type="checkbox" class="git-group-cb" data-prefix="${escapeAttr(dir.prefix)}" checked
              onchange="GitPanel.toggleGroup(this)" title="Include this folder in the commit">
            <span class="git-tree-name">${escapeHtml(name)}/</span>
            <span class="git-tree-count">${GitPanel._countFiles(dir)}</span>
          </div>`;
        html += render(dir, depth + 1);
      }
      for (const file of node.files) html += GitPanel._fileRowHtml(file, depth);
      return html;
    };
    return render(GitPanel._buildTree(files), 0);
  },

  _countFiles(node) {
    let total = node.files.length;
    for (const dir of node.dirs.values()) total += GitPanel._countFiles(dir);
    return total;
  },

  /** Tick or untick every file under a folder. */
  toggleGroup(cb) {
    const prefix = cb.getAttribute('data-prefix');
    if (!prefix) return;
    document.querySelectorAll('.git-file-cb').forEach(fileCb => {
      if (fileCb.value.indexOf(prefix) === 0) fileCb.checked = cb.checked;
    });
    GitPanel.syncGroups();
  },

  /** A folder follows its files: ticked when all are, indeterminate when only some are. */
  syncGroups() {
    document.querySelectorAll('.git-group-cb').forEach(groupCb => {
      const prefix = groupCb.getAttribute('data-prefix');
      const within = Array.from(document.querySelectorAll('.git-file-cb'))
        .filter(fileCb => fileCb.value.indexOf(prefix) === 0);
      const checked = within.filter(fileCb => fileCb.checked).length;
      groupCb.checked = within.length > 0 && checked === within.length;
      groupCb.indeterminate = checked > 0 && checked < within.length;
    });
  },

  selectedFiles() {
    return Array.from(document.querySelectorAll('.git-file-cb:checked')).map(cb => cb.value);
  },

  setAllFiles(on) {
    document.querySelectorAll('.git-file-cb').forEach(cb => { cb.checked = on; });
    GitPanel.syncGroups();
  },

  /**
   * A commit or push runs a real git command against a possibly slow remote, so the button that
   * started it says what it is doing and every action is disabled until it finishes — otherwise the
   * only sign anything happened is the toast at the end, and a second push is easy to fire.
   */
  _actionButton(kind, label, handler, enabled, extraClass) {
    const running = GitPanel._busy === kind;
    const body = running ? `<span class="btn-spinner"></span>${GitPanel.BUSY_LABEL[kind]}` : label;
    const off = GitPanel._busy || !enabled ? ' disabled' : '';
    return `<button class="btn btn-sm${extraClass || ''}" onclick="${handler}"${off}${running ? ' aria-busy="true"' : ''}>${body}</button>`;
  },

  _actionsHtml() {
    const files = (GitPanel._info || {}).files || [];
    const unpushed = ((GitPanel._info || {}).unpushed || []).length;

    return GitPanel._actionButton('commit', 'Commit', 'GitPanel.commit(false)', files.length, ' btn-primary')
      + GitPanel._actionButton('commit-push', 'Commit &amp; Push', 'GitPanel.commit(true)', files.length)
      + GitPanel._actionButton('push', `Push${unpushed ? ` (${unpushed})` : ''}`, 'GitPanel.push()', unpushed);
  },

  /**
   * Incoming side of the remote. Fetch is always offered when there is a remote, because fetching is
   * how "behind" stops being stale; Pull only when there is something to fast-forward over.
   */
  _syncActionsHtml() {
    const info = GitPanel._info || {};
    const behind = info.behind || 0;

    return GitPanel._actionButton('fetch', 'Fetch', 'GitPanel.fetch()', info.hasRemote)
      + GitPanel._actionButton('pull', `Pull${behind ? ` (${behind})` : ''}`, 'GitPanel.pull()', behind);
  },

  _renderActions() {
    const commitRow = document.getElementById('git-changes-actions');
    if (commitRow) commitRow.innerHTML = GitPanel._actionsHtml();
    const syncRow = document.getElementById('git-sync-actions');
    if (syncRow) syncRow.innerHTML = GitPanel._syncActionsHtml();
  },

  /** Show the action as running for as long as it takes, whatever its outcome. */
  async _withBusy(kind, run) {
    if (GitPanel._busy) return;                 // an action is already in flight
    GitPanel._busy = kind;
    GitPanel._renderActions();
    try {
      await run();
    } finally {
      GitPanel._busy = null;
      GitPanel._renderActions();
    }
  },

  _toPushHtml() {
    const info = GitPanel._info || {};
    const unpushed = info.unpushed || [];

    const commits = unpushed.map(c => `
      <div class="git-commit-row">
        <code>${escapeHtml(c.sha)}</code>
        <span class="git-commit-subject">${escapeHtml(c.subject)}</span>
      </div>`).join('');
    const empty = `<div class="git-changes-empty">${info.upstream
      ? 'Nothing to push — up to date with ' + escapeHtml(info.upstream) + '.'
      : 'No upstream branch yet: the first push needs <code>git push -u</code>.'}</div>`;
    const body = `<div class="git-changes-commits">${unpushed.length ? commits : empty}</div>`;

    const behindNote = info.behind
      ? `<div class="git-changes-note">${info.behind} commit${info.behind === 1 ? '' : 's'} on ${escapeHtml(info.upstream)} you do not have — Pull before pushing.</div>`
      : '';

    return `
      <div class="git-changes-header">
        <span class="git-changes-title">To push</span>
        ${info.ahead ? `<span class="git-sync-label">↑${info.ahead}</span>` : ''}
        ${info.behind ? `<span class="git-sync-label">↓${info.behind}</span>` : ''}
        <div class="git-sync-actions" id="git-sync-actions">${GitPanel._syncActionsHtml()}</div>
      </div>
      ${body}
      ${behindNote}`;
  },

  /** Commit the ticked files with the panel's message, reusing the shared commit path. */
  commit(andPush) {
    const message = GitPanel._draftMessage().trim();
    if (!message) { toast('Commit message is required', 'error'); return; }
    const files = GitPanel.selectedFiles();
    if (!files.length) { toast('No files selected', 'error'); return; }
    return GitPanel._withBusy(andPush ? 'commit-push' : 'commit',
      () => GitActions.runCommit(message, files, andPush));
  },

  push() {
    return GitPanel._withBusy('push', () => GitActions.push());
  },

  pull() {
    return GitPanel._withBusy('pull', () => GitActions.pull());
  },

  fetch() {
    return GitPanel._withBusy('fetch', () => GitActions.fetch());
  },

  /** Read the next page of history. Called on first view of the tab, and by Load more. */
  async loadLog(more) {
    const offset = more && GitPanel._log ? GitPanel._log.commits.length : 0;
    const body = document.getElementById('git-history-body');
    if (body && !offset) showLoading(body, 'Reading history…');

    let page;
    try {
      page = await GitApi.log(GitPanel._slug, GitPanel.LOG_PAGE, offset);
    } catch (e) {
      if (body) body.innerHTML = `<div class="git-changes-empty">Could not read history: ${escapeHtml(e.message)}</div>`;
      return;
    }

    const commits = offset && GitPanel._log ? GitPanel._log.commits.concat(page.commits) : page.commits;
    GitPanel._log = { commits, done: page.done };
    GitPanel._renderHistory();
  },

  /** History is stale the moment a commit is made, so it is re-read on next view rather than kept. */
  invalidateLog() {
    GitPanel._log = null;
    GitPanel._openSha = null;
    if (GitPanel._pane === 'history') GitPanel.loadLog();
  },

  _renderHistory() {
    const body = document.getElementById('git-history-body');
    if (!body) return;
    const log = GitPanel._log;
    if (!log) return;
    if (!log.commits.length) {
      body.innerHTML = '<div class="git-changes-empty">No commits yet.</div>';
      return;
    }

    const rows = log.commits.map(c => GitPanel._commitRowHtml(c)).join('');
    const more = log.done
      ? ''
      : `<button class="btn btn-sm git-history-more" onclick="GitPanel.loadLog(true)">Load more</button>`;
    body.innerHTML = rows + more;
  },

  _commitRowHtml(commit) {
    const open = GitPanel._openSha === commit.sha;
    const refs = commit.refs.map(r => `<span class="git-commit-ref">${escapeHtml(r)}</span>`).join('');
    const merge = commit.isMerge ? '<span class="git-commit-merge" title="Merge commit">merge</span>' : '';
    return `
      <div class="git-commit${open ? ' open' : ''}">
        <button class="git-commit-head" data-sha="${escapeAttr(commit.sha)}"
          onclick="GitPanel.openCommit(this.getAttribute('data-sha'))">
          <code>${escapeHtml(commit.sha)}</code>
          <span class="git-commit-subject">${escapeHtml(commit.subject)}</span>
          ${merge}${refs}
          <span class="git-commit-meta">${escapeHtml(commit.author)} · ${escapeHtml(commit.when)}</span>
        </button>
        ${open ? GitPanel._commitDetailHtml() : ''}
      </div>`;
  },

  /** Files of the open commit, each a link into the diff pane. */
  _commitDetailHtml() {
    const detail = GitPanel._commitDetail;
    if (!detail) return '<div class="git-changes-empty">Loading…</div>';
    if (detail.error) return `<div class="git-changes-empty">${escapeHtml(detail.error)}</div>`;

    const body = detail.body
      ? `<pre class="git-commit-body">${escapeHtml(detail.body)}</pre>`
      : '';
    const files = detail.files.length
      ? detail.files.map(f => `
          <div class="git-file-row">
            <span class="ctx-file-badge git-file-badge ${escapeAttr(GitPanel.STATUS_BADGE[f.status] || 'ctx-file-badge-edited')}">${escapeHtml(GitPanel.STATUS_LABEL[f.status] || f.status)}</span>
            <button class="git-file-path git-file-link" data-path="${escapeAttr(f.path)}" data-sha="${escapeAttr(detail.sha)}"
              onclick="GitPanel.openDiff(this.getAttribute('data-path'), this.getAttribute('data-sha'))"
              title="Show this commit's change to ${escapeAttr(f.path)}">${escapeHtml(f.path)}</button>
          </div>`).join('')
      : '<div class="git-changes-empty">No file changes (a merge, or an empty commit).</div>';

    return `<div class="git-commit-detail">${body}${files}</div>`;
  },

  /** Expand a commit, or collapse it when it is already open. */
  async openCommit(sha) {
    if (GitPanel._openSha === sha) {
      GitPanel._openSha = null;
      GitPanel._commitDetail = null;
      GitPanel._renderHistory();
      return;
    }
    GitPanel._openSha = sha;
    GitPanel._commitDetail = null;
    GitPanel._renderHistory();

    let detail;
    try {
      detail = await GitApi.commitDetail(GitPanel._slug, sha);
    } catch (e) {
      detail = { error: `Could not read ${sha}: ${e.message}` };
    }
    if (GitPanel._openSha !== sha) return;            // collapsed or another commit opened meanwhile
    GitPanel._commitDetail = detail;
    GitPanel._renderHistory();
  },

  _branchLabel() {
    const info = GitPanel._info || {};
    if (!info.branch) return '';
    return info.detached ? `detached @ ${info.branch}` : info.branch;
  },

  _renderRecipes() {
    const host = document.getElementById('git-recipes');
    if (!host) return;
    host.innerHTML = GitRecipes.CATEGORIES.map(cat => {
      const open = GitPanel._openCategories.has(cat.name);
      const items = cat.items.map(item => {
        const cmd = GitRecipes.substitute(item.cmd, GitPanel._info);
        return `<button class="git-recipe${item.danger ? ' git-recipe-danger' : ''}"
            onclick="GitPanel.useRecipe(this)" data-cmd="${escapeAttr(cmd)}" title="Type into the shell">
            <code>${escapeHtml(cmd)}</code>
            <span class="git-recipe-explain">${escapeHtml(item.explain)}</span>
          </button>`;
      }).join('');
      return `<div class="git-recipe-cat${open ? ' open' : ''}">
          <button class="git-recipe-cat-header" onclick="GitPanel.toggleCategory('${escapeHtml(cat.name)}')">
            <span class="git-recipe-cat-caret">${open ? '&#9662;' : '&#9656;'}</span>${escapeHtml(cat.name)}
          </button>
          <div class="git-recipe-items">${items}</div>
        </div>`;
    }).join('');
  },

  recipesCollapsed() {
    try { return localStorage.getItem(GitPanel.RECIPES_COLLAPSED_KEY) === '1'; }
    catch (_) { return false; }
  },

  shellOpen() {
    return !!GitPanel._view;
  },

  /** A recipe is only useful with a shell to type it into, so the column follows the shell. */
  recipesVisible() {
    return GitPanel.shellOpen() && !GitPanel.recipesCollapsed();
  },

  _layoutClasses() {
    if (!GitPanel.shellOpen()) return ' no-recipes';
    return GitPanel.recipesCollapsed() ? ' recipes-collapsed' : '';
  },

  _applyRecipesState() {
    const layout = document.getElementById('git-panel-layout');
    if (!layout || !layout.classList) return;
    layout.classList.toggle('no-recipes', !GitPanel.shellOpen());
    layout.classList.toggle('recipes-collapsed', GitPanel.shellOpen() && GitPanel.recipesCollapsed());
  },

  /** Fold the recipe column away so the changed-file list gets the width. */
  toggleRecipes() {
    const next = !GitPanel.recipesCollapsed();
    try { localStorage.setItem(GitPanel.RECIPES_COLLAPSED_KEY, next ? '1' : '0'); } catch (_) {}
    GitPanel._applyRecipesState();
    GitPanel._sendResize();
  },

  toggleCategory(name) {
    if (GitPanel._openCategories.has(name)) GitPanel._openCategories.delete(name);
    else GitPanel._openCategories.add(name);
    GitPanel._renderRecipes();
  },

  /** Type a recipe into the shell without a newline — the user reviews it and presses Enter. */
  useRecipe(btn) {
    const cmd = btn.getAttribute('data-cmd');
    if (!cmd) return;
    if (!GitPanel._view || !GitPanel._view.isConnected()) {
      toast('Open the shell first', 'error');
      return;
    }
    GitPanel._view.send({ t: 'i', d: cmd });
    GitPanel._view.focus();
  },

  openShell() {
    if (GitPanel._view) return;
    const view = TermView.create({
      hostId: 'git-shell-host',
      url: GitPanel._shellUrl(),
      onStatus: (text, cls) => GitPanel._setStatus(text, cls),
      onOpen: () => { if (typeof GitActions !== 'undefined') GitActions.refreshShellState(); },
    });
    if (!view) {
      toast('Terminal libraries failed to load', 'error');
      return;
    }
    GitPanel._view = view;
    GitPanel._showShell(true);
    GitPanel._applyRecipesState();
  },

  _shellUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/projects/${encodeURIComponent(GitPanel._slug)}/terminal?mode=shell`;
  },

  reconnect() {
    if (!GitPanel._view) { GitPanel.openShell(); return; }
    GitPanel._view.reconnect('[reconnecting]');
  },

  /** End the pty for good, unlike unmount() which only drops this view of it. */
  killShell() {
    if (GitPanel._view) GitPanel._view.send({ t: 'close' });
    GitPanel._disposeView();
    GitPanel._showShell(false);
    GitPanel._applyRecipesState();
    GitPanel._setStatus('disconnected', '');
    if (typeof GitActions !== 'undefined') GitActions.refreshShellState();
  },

  _disposeView() {
    if (!GitPanel._view) return;
    GitPanel._view.dispose();
    GitPanel._view = null;
  },

  _showShell(on) {
    const idle = document.getElementById('git-shell-idle');
    const host = document.getElementById('git-shell-host');
    if (idle) idle.style.display = on ? 'none' : '';
    if (host) host.style.display = on ? '' : 'none';
  },

  _setStatus(text, cls) {
    const el = document.getElementById('git-shell-status');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('connected', 'error');
    if (cls) el.classList.add(cls);
  },

  _sendResize() {
    if (GitPanel._view) GitPanel._view.resize();
  }
};

window.GitPanel = GitPanel;

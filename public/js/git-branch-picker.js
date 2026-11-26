// --- GitBranchPicker ---
// Searchable branch list dropping from the branch name in the git menu bar, or from a Task Board
// lane's branch. Local branches first, then remote branches nothing local tracks yet — picking one
// of those creates the tracking branch. ↑/↓ move through the filtered list, Enter switches, Esc closes.
//
// open(ctx) says where it shows and which project it switches: { slug, panelId, files(), label(),
// checkout(name, remote, stash) }. Without one it is the git panel's picker. Clicks outside the
// element marked .git-branch-host close it.
//
// Switching with uncommitted changes asks first: stash them and switch, or bring them along (which
// git itself refuses when the target branch would overwrite them).

const GitBranchPicker = {
  _isOpen: false,
  _branches: null,      // { local, remote } once read; null while loading
  _filter: '',
  _hl: 0,               // index into _matches()
  _ctx: null,           // where the open picker shows and what it switches
  _listening: false,

  /** The git panel's picker: its project, its uncommitted files, its busy guard. */
  _gitPanelCtx() {
    return {
      slug: GitPanel._slug,
      panelId: 'git-branch-picker',
      files: () => ((GitPanel._info || {}).files || []).length,
      label: () => GitPanel._branchLabel(),
      checkout: (name, remote, stash) => GitPanel._withBusy('checkout', () => GitActions.checkout(name, remote, stash)),
    };
  },

  /** Open, and showing in this panel (the git panel's or a lane's). */
  isOpenIn(panelId) {
    return GitBranchPicker._isOpen && !!GitBranchPicker._ctx && GitBranchPicker._ctx.panelId === panelId;
  },

  toggle() {
    if (GitBranchPicker.isOpenIn('git-branch-picker')) GitBranchPicker.close();
    else GitBranchPicker.open();
  },

  async open(ctx) {
    if (typeof GitMenu !== 'undefined') GitMenu.close();
    GitBranchPicker.close();
    GitBranchPicker._ctx = ctx || GitBranchPicker._gitPanelCtx();
    GitBranchPicker._isOpen = true;
    GitBranchPicker._branches = null;
    GitBranchPicker._filter = '';
    GitBranchPicker._hl = 0;
    GitBranchPicker._listen();
    GitBranchPicker.render();

    let branches;
    try {
      branches = await GitApi.branches(GitBranchPicker._ctx.slug);
    } catch (e) {
      toast(`Could not list branches: ${e.message}`, 'error');
      GitBranchPicker.close();
      return;
    }
    if (!GitBranchPicker._isOpen) return;
    GitBranchPicker._branches = branches;
    GitBranchPicker.render();
  },

  close() {
    if (!GitBranchPicker._isOpen) return;
    GitBranchPicker._isOpen = false;
    const panel = document.getElementById(GitBranchPicker._ctx.panelId);
    if (panel) { panel.classList.remove('open'); panel.innerHTML = ''; }
  },

  /** Local then remote, narrowed by the filter text — the order ↑/↓ walk through. */
  _matches() {
    const b = GitBranchPicker._branches;
    if (!b) return [];
    const q = GitBranchPicker._filter.toLowerCase();
    const hit = name => !q || name.toLowerCase().includes(q);
    return b.local.filter(x => hit(x.name)).map(x => ({ name: x.name, upstream: x.upstream, current: x.current, remote: false }))
      .concat(b.remote.filter(x => hit(x.name)).map(x => ({ name: x.name, localName: x.localName, remote: true })));
  },

  render() {
    if (!GitBranchPicker._ctx) return;
    const panel = document.getElementById(GitBranchPicker._ctx.panelId);
    if (!panel) return;
    panel.classList.add('open');
    if (!GitBranchPicker._branches) {
      panel.innerHTML = '<div class="git-menu-hint">Loading branches…</div>';
      return;
    }
    panel.innerHTML = `
      <input type="text" class="git-branch-filter" id="git-branch-filter" placeholder="Filter branches…"
        autocomplete="off" spellcheck="false" value="${escapeAttr(GitBranchPicker._filter)}"
        oninput="GitBranchPicker.setFilter(this.value)" onkeydown="GitBranchPicker.onKey(event)">
      <div class="git-branch-list" id="git-branch-list"></div>`;
    GitBranchPicker._renderList();
    const input = document.getElementById('git-branch-filter');
    if (input) input.focus();
  },

  /** Only the list repaints while typing, so the filter input keeps focus and caret. */
  _renderList() {
    const host = document.getElementById('git-branch-list');
    if (!host) return;
    const matches = GitBranchPicker._matches();
    if (!matches.length) {
      host.innerHTML = '<div class="git-menu-hint">No matching branches.</div>';
      return;
    }

    const row = (b, i) => {
      const meta = b.remote ? `creates ${b.localName}` : (b.upstream || '');
      return `<button class="git-menu-item git-branch-row${i === GitBranchPicker._hl ? ' active' : ''}${b.current ? ' current' : ''}"
          onclick="GitBranchPicker.pick(${i})" onmouseenter="GitBranchPicker.highlight(${i})">
          <span class="git-branch-mark">${b.current ? '&#9679;' : ''}</span>
          <span class="git-menu-label">${escapeHtml(b.name)}</span>
          <span class="git-branch-meta">${escapeHtml(meta)}</span>
        </button>`;
    };
    let html = '';
    matches.forEach((b, i) => {
      if (i === 0 && !b.remote) html += '<div class="git-menu-section">Local</div>';
      if (b.remote && (i === 0 || !matches[i - 1].remote)) html += '<div class="git-menu-section">Remote</div>';
      html += row(b, i);
    });
    host.innerHTML = html;
  },

  setFilter(value) {
    GitBranchPicker._filter = value;
    GitBranchPicker._hl = 0;
    GitBranchPicker._renderList();
  },

  highlight(i) {
    GitBranchPicker._hl = i;
    document.querySelectorAll('#git-branch-list .git-branch-row').forEach((rowEl, j) => rowEl.classList.toggle('active', j === i));
  },

  onKey(e) {
    const count = GitBranchPicker._matches().length;
    if (e.key === 'Escape') {
      e.preventDefault();
      GitBranchPicker.close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (count) GitBranchPicker.pick(GitBranchPicker._hl);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
      e.preventDefault();
      GitBranchPicker.highlight((GitBranchPicker._hl + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
      const active = document.querySelector('#git-branch-list .git-branch-row.active');
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    }
  },

  pick(i) {
    const branch = GitBranchPicker._matches()[i];
    GitBranchPicker.close();
    if (!branch || branch.current) return;
    GitBranchPicker.switchTo(branch.name, branch.remote);
  },

  switchTo(name, remote) {
    const ctx = GitBranchPicker._ctx;
    const files = ctx.files();
    if (!files) return ctx.checkout(name, remote, false);

    openModal({
      title: 'Uncommitted changes',
      body: `<p>${files} changed file${files === 1 ? '' : 's'} on ${escapeHtml(ctx.label())}. What should happen to them when switching to <code>${escapeHtml(name)}</code>?</p>
        <div class="git-menu-hint">Bring along keeps them in the working tree; git refuses if ${escapeHtml(name)} would overwrite them.</div>`,
      buttons: [
        { label: 'Bring changes along', onClick: () => { ctx.checkout(name, remote, false); } },
        { label: 'Stash & switch', primary: true, onClick: () => { ctx.checkout(name, remote, true); } },
      ],
    });
  },

  /** One document-level outside-click listener: a click outside the picker's host closes it. */
  _listen() {
    if (GitBranchPicker._listening) return;
    GitBranchPicker._listening = true;
    document.addEventListener('mousedown', e => {
      if (!GitBranchPicker._isOpen) return;
      if (e.target.closest && e.target.closest('.git-branch-host')) return;
      GitBranchPicker.close();
    });
  },
};

window.GitBranchPicker = GitBranchPicker;

// --- GitMenu ---
// Desktop-style menu bar above the git panel: Branch, Commit, Remote, Stash. A new area of git gets a
// new entry in MENUS rather than another button. Each menu builds its items from live panel state
// when it opens, so disabled entries always match what the buttons below would allow.
// The branch name on the right opens GitBranchPicker, the same picker Branch › Switch branch… opens.
//
// Items are kept in _items by index and run through run(i), so a rendered onclick never has to carry
// a closure. Keyboard: ↑/↓ within a menu, ←/→ across menus (or into and out of a submenu), Esc closes.

const GitMenu = {
  _open: null,          // name of the open menu
  _items: [],           // flattened item list of the open menu, indexed by data-i
  _stashes: null,       // stash list read when the Stash menu opens; null while loading
  _listening: false,

  MENUS: [
    {
      name: 'Branch',
      items: () => [
        { label: 'Switch branch…', action: () => GitBranchPicker.open() },
        { label: 'New branch…', action: () => GitMenu.newBranch() },
      ],
    },
    {
      name: 'Commit',
      items: () => {
        const ready = GitMenu._fileCount() > 0 && !GitPanel._busy;
        return [
          { label: 'Commit', action: () => GitPanel.commit(false), enabled: ready },
          { label: 'Commit & Push', action: () => GitPanel.commit(true), enabled: ready },
        ];
      },
    },
    {
      name: 'Remote',
      items: () => {
        const info = GitPanel._info || {};
        const idle = !GitPanel._busy;
        return [
          { label: 'Fetch', action: () => GitPanel.fetch(), enabled: idle && info.hasRemote },
          { label: `Pull${info.behind ? ` (${info.behind})` : ''}`, action: () => GitPanel.pull(), enabled: idle && info.behind > 0 },
          { label: 'Push', action: () => GitPanel.push(), enabled: idle && GitPanel.canPush() },
        ];
      },
    },
    {
      name: 'Stash',
      load: () => GitMenu._loadStashes(),
      items: () => {
        const dirty = GitMenu._fileCount() > 0 && !GitPanel._busy;
        const items = [
          { label: 'Stash changes…', action: () => GitMenu.stashDialog(false), enabled: dirty },
          { label: 'Stash incl. untracked…', action: () => GitMenu.stashDialog(true), enabled: dirty },
          { separator: true },
        ];
        if (GitMenu._stashes === null) return items.concat({ label: 'Loading stashes…', enabled: false });
        if (!GitMenu._stashes.length) return items.concat({ label: 'No stashes', enabled: false });
        return items.concat(GitMenu._stashes.map(s => ({
          label: `${s.ref}  ${s.message}`,
          title: s.when,
          submenu: [
            { label: 'Apply', action: () => GitMenu._stashOp('apply', s.ref) },
            { label: 'Pop', action: () => GitMenu._stashOp('pop', s.ref) },
            { label: 'Drop…', action: () => GitMenu.confirmDrop(s), danger: true },
          ],
        })));
      },
    },
  ],

  _fileCount() {
    return ((GitPanel._info || {}).files || []).length;
  },

  /** Paint the bar into #git-menubar-host. Called on every panel render and refresh. */
  render() {
    const host = document.getElementById('git-menubar-host');
    if (!host) return;
    const menus = GitMenu.MENUS.map(m => `
      <div class="git-menu">
        <button class="git-menu-title${GitMenu._open === m.name ? ' open' : ''}" data-menu="${escapeAttr(m.name)}"
          onclick="GitMenu.toggle('${m.name}')" onmouseenter="GitMenu.hover('${m.name}')">${escapeHtml(m.name)}</button>
        <div class="git-menu-panel${GitMenu._open === m.name ? ' open' : ''}" id="git-menu-panel-${m.name}">${GitMenu._open === m.name ? GitMenu._panelHtml(m) : ''}</div>
      </div>`).join('');

    host.innerHTML = `<div class="git-menubar" id="git-menubar">
        ${menus}
        <div class="git-menu git-menu-branch">
          <button class="git-menu-title git-branch-btn" onclick="GitBranchPicker.toggle()" title="Switch branch">
            <span class="git-branch-icon">&#x2387;</span> ${escapeHtml(GitPanel._branchLabel())} <span class="dd-arrow"></span></button>
          <div class="git-menu-panel git-branch-picker${GitBranchPicker._isOpen ? ' open' : ''}" id="git-branch-picker"></div>
        </div>
      </div>`;
    if (GitBranchPicker._isOpen) GitBranchPicker.render();
    GitMenu._listen();
  },

  _panelHtml(menu) {
    GitMenu._items = [];
    const itemHtml = item => {
      if (item.separator) return '<div class="git-menu-sep"></div>';
      const i = GitMenu._items.push(item) - 1;
      const off = item.enabled === false ? ' disabled' : '';
      const title = item.title ? ` title="${escapeAttr(item.title)}"` : '';
      if (item.submenu) {
        return `<div class="git-menu-parent">
            <button class="git-menu-item" data-i="${i}"${title}${off} onclick="GitMenu.openSub(this)">
              <span class="git-menu-label">${escapeHtml(item.label)}</span><span class="git-menu-caret">&#9656;</span></button>
            <div class="git-menu-panel git-menu-sub">${item.submenu.map(itemHtml).join('')}</div>
          </div>`;
      }
      return `<button class="git-menu-item${item.danger ? ' git-menu-danger' : ''}" data-i="${i}"${title}${off}
          onclick="GitMenu.run(${i})"><span class="git-menu-label">${escapeHtml(item.label)}</span></button>`;
    };
    return menu.items().map(itemHtml).join('');
  },

  toggle(name) {
    if (GitMenu._open === name) GitMenu.close();
    else GitMenu.open(name);
  },

  /** Like a desktop menu bar: once one menu is open, pointing at another opens that one instead. */
  hover(name) {
    if (GitMenu._open && GitMenu._open !== name) GitMenu.open(name);
  },

  open(name) {
    const menu = GitMenu.MENUS.find(m => m.name === name);
    if (!menu) return;
    GitBranchPicker.close();
    GitMenu._open = name;
    GitMenu.render();
    if (menu.load) menu.load();
  },

  close() {
    if (!GitMenu._open) return;
    GitMenu._open = null;
    GitMenu._items = [];
    GitMenu.render();
  },

  run(i) {
    const item = GitMenu._items[i];
    if (!item || item.enabled === false || !item.action) return;
    GitMenu.close();
    item.action();
  },

  /** A parent item opens its submenu on hover by CSS; click and → open it for keyboard users too. */
  openSub(btn) {
    const parent = btn.closest('.git-menu-parent');
    if (!parent) return;
    parent.classList.add('open');
    const first = parent.querySelector('.git-menu-sub .git-menu-item:not([disabled])');
    if (first) first.focus();
  },

  async _loadStashes() {
    GitMenu._stashes = null;
    let stashes;
    try {
      stashes = (await GitApi.stashes(GitPanel._slug)).stashes;
    } catch (e) {
      toast(`Could not read stashes: ${e.message}`, 'error');
      stashes = [];
    }
    GitMenu._stashes = stashes;
    if (GitMenu._open === 'Stash') GitMenu.render();
  },

  newBranch() {
    openModal({
      title: 'New branch',
      body: formGroup('Name', '<input type="text" id="git-new-branch-name" placeholder="feature/123" autocomplete="off">')
        + `<div class="git-menu-hint">Created from ${escapeHtml(GitPanel._branchLabel())}. Uncommitted changes come along.</div>`,
      buttons: [{
        label: 'Create', primary: true,
        onClick: () => {
          const name = document.getElementById('git-new-branch-name').value.trim();
          if (!name) { toast('Branch name is required', 'error'); return false; }
          GitPanel._withBusy('branch', () => GitActions.createBranch(name));
        },
      }],
    });
    const input = document.getElementById('git-new-branch-name');
    if (input) input.focus();
  },

  stashDialog(untracked) {
    openModal({
      title: untracked ? 'Stash changes incl. untracked' : 'Stash changes',
      body: formGroup('Message (optional)', '<input type="text" id="git-stash-message" autocomplete="off">'),
      buttons: [{
        label: 'Stash', primary: true,
        onClick: () => {
          const message = document.getElementById('git-stash-message').value.trim();
          GitPanel._withBusy('stash', () => GitActions.stash(message, untracked));
        },
      }],
    });
    const input = document.getElementById('git-stash-message');
    if (input) input.focus();
  },

  confirmDrop(stash) {
    openModal({
      title: 'Drop stash',
      body: `<p>Delete <code>${escapeHtml(stash.ref)}</code> ${escapeHtml(stash.message)}? This cannot be undone.</p>`,
      buttons: [{ label: 'Drop', danger: true, onClick: () => { GitMenu._stashOp('drop', stash.ref); } }],
    });
  },

  _stashOp(op, ref) {
    return GitPanel._withBusy('stash', () => GitActions.stashOp(op, ref));
  },

  /** One document-level listener pair for the whole page: outside click and keyboard. */
  _listen() {
    if (GitMenu._listening) return;
    GitMenu._listening = true;
    document.addEventListener('mousedown', e => {
      if (!GitMenu._open && !GitBranchPicker._isOpen) return;
      if (e.target.closest && e.target.closest('#git-menubar')) return;
      GitMenu.close();
      GitBranchPicker.close();
    });
    document.addEventListener('keydown', e => GitMenu._onKey(e));
  },

  _onKey(e) {
    if (!GitMenu._open) return;
    const names = GitMenu.MENUS.map(m => m.name);
    const idx = names.indexOf(GitMenu._open);
    const active = document.activeElement;
    const inSub = active && active.closest && active.closest('.git-menu-sub');

    if (e.key === 'Escape') {
      e.preventDefault();
      GitMenu.close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const scope = inSub || document.getElementById(`git-menu-panel-${GitMenu._open}`);
      if (!scope) return;
      const items = Array.from(scope.querySelectorAll(':scope > .git-menu-item:not([disabled]), :scope > .git-menu-parent > .git-menu-item:not([disabled])'));
      if (!items.length) return;
      const at = items.indexOf(active);
      const next = at === -1 ? (e.key === 'ArrowDown' ? 0 : items.length - 1)
        : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!inSub && active && active.closest && active.closest('.git-menu-parent')) GitMenu.openSub(active);
      else GitMenu._openAndFocus(names[(idx + 1) % names.length]);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (inSub) {
        const parent = inSub.closest('.git-menu-parent');
        parent.classList.remove('open');
        parent.querySelector('.git-menu-item').focus();
      } else {
        GitMenu._openAndFocus(names[(idx - 1 + names.length) % names.length]);
      }
    }
  },

  _openAndFocus(name) {
    GitMenu.open(name);
    const title = document.querySelector(`.git-menu-title[data-menu="${name}"]`);
    if (title) title.focus();
  },
};

window.GitMenu = GitMenu;

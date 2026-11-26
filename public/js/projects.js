const ProjectNav = {
  toggle() {
    const body = document.getElementById('project-nav-body');
    const arrow = document.getElementById('project-nav-arrow');
    const open = body.classList.toggle('collapsed');
    arrow.innerHTML = open ? '&#9654;' : '&#9660;';
  },
  expand() {
    const body = document.getElementById('project-nav-body');
    const arrow = document.getElementById('project-nav-arrow');
    body.classList.remove('collapsed');
    arrow.innerHTML = '&#9660;';
  }
};

const Projects = {
  data: [],
  _expanded: new Set(),
  _othersOpen: false,

  async load() {
    showLoading('projects-grid');
    try {
      Projects.data = await api('/api/projects');
      Projects.renderGrid();
      Projects.renderNav();
    } catch (e) {
      toast('Could not load projects: ' + e.message, 'error');
    }
  },

  POLL_MS: 15000,
  _timer: null,
  _favoriteRev: 0,
  _favoritePending: 0,

  startPolling() {
    if (Projects._timer) return;
    Projects._timer = setInterval(Projects.refresh, Projects.POLL_MS);
  },

  /** Re-fetch projects in the background; re-render only when the list actually changed. */
  async refresh() {
    const rev = Projects._favoriteRev;
    try {
      const data = await api('/api/projects');
      // A star clicked while this fetch was in flight would be undone by its stale result.
      if (Projects._favoritePending || rev !== Projects._favoriteRev) return;
      if (JSON.stringify(data) === JSON.stringify(Projects.data)) return;
      Projects.data = data;
      Projects.renderGrid();
      Projects.renderNav();
      if (typeof ActiveCount !== 'undefined') ActiveCount._apply();
      if (App.currentView === 'project-detail') {
        document.querySelectorAll('.project-list .nav-item').forEach(el => {
          el.classList.toggle('active', el.dataset.slug === App.currentProject);
        });
        Projects.renderTabCounts(App.currentProject);
      }
    } catch (_) { /* silent — next tick retries */ }
  },

  /** Counts on the project-detail tab buttons. */
  renderTabCounts(slug) {
    const project = Projects.data.find(p => p.slug === slug);
    const memoryTabBtn = document.getElementById('memory-tab-btn');
    if (memoryTabBtn) {
      const count = project ? project.memoryCount : 0;
      memoryTabBtn.textContent = count > 0 ? `Memory (${count})` : 'Memory';
    }
    const sessionsTabBtn = document.getElementById('sessions-tab-btn');
    if (sessionsTabBtn) {
      const count = project ? project.sessionCount : 0;
      sessionsTabBtn.style.display = count > 0 ? '' : 'none';
      sessionsTabBtn.textContent = count > 0 ? `Sessions (${count})` : 'Sessions';
    }
    const skillsTabBtn = document.getElementById('skills-tab-btn');
    if (skillsTabBtn) {
      const count = project ? project.skillsCount : 0;
      skillsTabBtn.textContent = count > 0 ? `Skills (${count})` : 'Skills';
    }
    const stylesTabBtn = document.getElementById('output-styles-tab-btn');
    if (stylesTabBtn) {
      const count = project ? project.outputStylesCount : 0;
      stylesTabBtn.textContent = count > 0 ? `Output Styles (${count})` : 'Output Styles';
    }
  },

  /** Split `list` (default Projects.data) into auto-detected clusters (with summed stats) and singletons. */
  _grouped(list = Projects.data) {
    const byId = {};
    const ungrouped = [];
    for (const p of list) {
      if (!p.groupId) { ungrouped.push(p); continue; }
      if (!byId[p.groupId]) byId[p.groupId] = { groupId: p.groupId, label: p.groupLabel, members: [] };
      byId[p.groupId].members.push(p);
    }
    const groups = Object.values(byId).map(g => ({
      ...g,
      primary: g.members.find(m => m.groupPrimary) || g.members[0],
      memoryCount: g.members.reduce((s, m) => s + m.memoryCount, 0),
      sessionCount: g.members.reduce((s, m) => s + m.sessionCount, 0),
      skillsCount: g.members.reduce((s, m) => s + m.skillsCount, 0),
      outputStylesCount: g.members.reduce((s, m) => s + m.outputStylesCount, 0),
      hasClaudeMd: g.members.some(m => m.hasClaudeMd),
      hasAiMemory: g.members.some(m => m.hasAiMemory)
    }));
    return { groups, ungrouped };
  },

  /** Projects above `p` in its group's tree, nearest first. */
  _ancestors(p) {
    const out = [];
    const bySlug = slug => Projects.data.find(x => x.slug === slug);
    for (let a = bySlug(p.groupParentSlug); a; a = bySlug(a.groupParentSlug)) out.push(a);
    return out;
  },

  /** Starred, or nested under a starred project. */
  _inFavorites(p) {
    return p.favorite || Projects._ancestors(p).some(a => a.favorite);
  },

  /** Favorites (starred projects plus everything nested under them), and the rest. */
  _split() {
    return {
      favorites: Projects.data.filter(Projects._inFavorites),
      others: Projects.data.filter(p => !Projects._inFavorites(p))
    };
  },

  /** Each starred project not already nested under another starred one, with the tree rows of
   *  the projects nested under it. */
  _favoriteEntries() {
    return Projects.data
      .filter(p => p.favorite && !Projects._ancestors(p).some(a => a.favorite))
      .map(p => ({
        project: p,
        children: Projects._treeRows(Projects._tree(Projects.data.filter(m => Projects._ancestors(m).includes(p))))
      }));
  },

  _gridHtml(list) {
    const { groups, ungrouped } = Projects._grouped(list);
    return groups.map(Projects._groupCardHtml).join('') + ungrouped.map(p => Projects._cardHtml(p)).join('');
  },

  renderGrid() {
    const grid = document.getElementById('projects-grid');
    const { favorites, others } = Projects._split();
    if (!favorites.length) {
      grid.innerHTML = Projects._gridHtml(Projects.data);
      return;
    }
    const open = Projects._othersOpen;
    grid.innerHTML = `
      <div class="project-section-title">&#9733; Favorites</div>
      ${Projects._favoriteEntries().map(({ project, children }) => Projects._cardHtml(project, { favoriteLabel: true, children })).join('')}
      ${others.length ? `
        <div class="project-section-title project-section-title--toggle" onclick="Projects.toggleOthers()">
          <span class="project-group-caret">${open ? '&#9660;' : '&#9654;'}</span> Other projects
          <span class="badge">${others.length}</span>
        </div>
        ${open ? Projects._gridHtml(others) : ''}
      ` : ''}
    `;
  },

  toggleOthers() {
    Projects._othersOpen = !Projects._othersOpen;
    Projects.renderGrid();
    Projects.renderNav();
  },

  _starHtml(p) {
    const title = p.favorite ? 'Remove from favorites' : 'Add to favorites';
    return `<span class="fav-star${p.favorite ? ' fav-star--on' : ''}" onclick="event.stopPropagation(); Projects.toggleFavorite('${p.slug}')" title="${title}">${p.favorite ? '&#9733;' : '&#9734;'}</span>`;
  },

  /** Name a favorite is listed under: its group's label plus its folder when it belongs to a group. */
  _favoriteLabel(p) {
    return p.groupId ? `${p.groupLabel} / ${Projects._memberLabel(p)}` : decodeName(p.slug);
  },

  async toggleFavorite(slug) {
    const p = Projects.data.find(x => x.slug === slug);
    if (!p) return;
    const favorite = !p.favorite;
    p.favorite = favorite;
    Projects._favoriteRev++;
    Projects._favoritePending++;
    Projects.renderGrid();
    Projects.renderNav();
    try {
      await api(`/api/projects/${slug}/favorite`, { method: 'PUT', body: { favorite } });
    } catch (e) {
      p.favorite = !favorite;
      Projects.renderGrid();
      Projects.renderNav();
      toast('Could not update favorite: ' + e.message, 'error');
    } finally {
      Projects._favoritePending--;
    }
  },

  /** The stats strip shared by a plain project card and a group card — a group just sums its
   *  members' counts first, so both render from the same shape. */
  _statsHtml(p) {
    return `
      <div class="project-stats">
        <div class="stat"><span class="stat-value">${p.memoryCount}</span> memories</div>
        <div class="stat"><span class="stat-value">${p.sessionCount}</span> sessions</div>
        ${p.hasClaudeMd ? '<div class="stat" style="color:var(--success)">CLAUDE.md</div>' : ''}
        ${p.hasAiMemory ? '<div class="stat" style="color:var(--accent)">.ai_project_memory</div>' : ''}
      </div>
    `;
  },

  _pathHtml(p, cls) {
    return `<span class="${cls} clickable-path" onclick="event.stopPropagation(); Projects.openFolder('${p.slug}')" title="Open folder in file explorer">${escapeHtml(p.path)}</span>`;
  },

  _cardHtml(p, { favoriteLabel, children = [] } = {}) {
    return `
      <div class="card project-card" onclick="App.navigate('project-detail', { slug: '${p.slug}' })">
        <div class="project-name">${Projects._starHtml(p)}${favoriteLabel ? escapeHtml(Projects._favoriteLabel(p)) : decodeName(p.slug)}</div>
        ${Projects._pathHtml(p, 'project-path')}
        ${Projects._statsHtml(p)}
        ${children.length ? `<div class="project-group-members">${children.map(Projects._memberRowHtml).join('')}</div>` : ''}
      </div>
    `;
  },

  /** Folder name a member is shown under: its path relative to its parent project when nested
   *  (so "linked-repos/service" reads as the folder path it actually lives at), else its own
   *  directory name. */
  _memberLabel(p) {
    if (p.groupRelPath) return p.groupRelPath;
    const parts = p.path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || p.path;
  },

  /** Build the group's containment forest from each member's groupParentSlug. Only registered
   *  projects are nodes — unregistered folders in between are already folded into groupRelPath. */
  _tree(members) {
    const nodes = {};
    for (const m of members) nodes[m.slug] = { project: m, children: [] };
    const roots = [];
    for (const m of members) {
      const parent = m.groupParentSlug ? nodes[m.groupParentSlug] : null;
      if (parent) parent.children.push(nodes[m.slug]);
      else roots.push(nodes[m.slug]);
    }
    const sortTree = list => {
      list.sort((a, b) => Projects._memberLabel(a.project).localeCompare(Projects._memberLabel(b.project)));
      list.forEach(n => sortTree(n.children));
    };
    sortTree(roots);
    roots.sort((a, b) => (b.project.groupPrimary ? 1 : 0) - (a.project.groupPrimary ? 1 : 0));
    return roots;
  },

  /** Depth-first flatten of _tree into render-ready rows. */
  _treeRows(nodes, depth = 0, out = []) {
    for (const node of nodes) {
      out.push({ project: node.project, depth });
      Projects._treeRows(node.children, depth + 1, out);
    }
    return out;
  },

  _memberRowHtml({ project: m, depth }) {
    return `
      <div class="project-group-member" style="padding-left:${depth * TREE_INDENT_STEP}px" onclick="event.stopPropagation(); App.navigate('project-detail', { slug: '${m.slug}' })">
        <span class="project-group-member-name">${Projects._starHtml(m)}${m.groupPrimary ? '&#9733; ' : ''}${escapeHtml(Projects._memberLabel(m))}</span>
        ${Projects._pathHtml(m, 'project-group-member-path')}
      </div>
    `;
  },

  _groupCardHtml(g) {
    const expanded = Projects._expanded.has(g.groupId);
    const memberRows = Projects._treeRows(Projects._tree(g.members)).map(Projects._memberRowHtml).join('');

    return `
      <div class="card project-card project-card--group">
        <div class="project-card-header" onclick="Projects.toggleGroup('${g.groupId}')">
          <span class="project-group-caret">${expanded ? '&#9660;' : '&#9654;'}</span>
          <div class="project-name">${escapeHtml(g.label)}</div>
          <span class="badge">${g.members.length} projects</span>
        </div>
        ${Projects._statsHtml(g)}
        ${expanded ? `<div class="project-group-members">${memberRows}</div>` : ''}
      </div>
    `;
  },

  toggleGroup(groupId) {
    if (Projects._expanded.has(groupId)) Projects._expanded.delete(groupId);
    else Projects._expanded.add(groupId);
    Projects.renderGrid();
    Projects.renderNav();
  },

  /** One project row in the sidebar. `depth` is its level in a group's tree; omit it for an
   *  ungrouped project, which sits at the list's own base indent. `px` overrides the indent the
   *  depth would give. */
  _navItemHtml(p, { label, title, depth, px = depth === undefined ? undefined : treeIndent(depth) }) {
    const indent = px === undefined ? '' : ` style="--tree-indent:${px}px"`;
    const cls = px === undefined ? 'nav-item' : 'nav-item nav-item--sub';
    return `
      <div class="${cls}" data-slug="${p.slug}"${indent} onclick="App.navigate('project-detail', { slug: '${p.slug}' })" title="${escapeAttr(title)}">
        <span class="icon">&#128193;${p.favorite ? '<span class="fav-folder-star">&#9733;</span>' : ''}</span>
        <span class="nav-label">${escapeHtml(label)}</span>
        <span class="badge badge-active nav-active-badge" data-slug="${p.slug}" style="display:none"></span>
        ${Projects._starHtml(p)}
      </div>
    `;
  },

  _navGroupHtml(g, expanded) {
    return `
      <div class="nav-item nav-item--group-header" onclick="Projects.toggleGroup('${g.groupId}')" title="${escapeAttr(g.label)} — ${g.members.length} projects">
        <span class="icon project-group-caret">${expanded ? '&#9660;' : '&#9654;'}</span>
        <span class="nav-label">${escapeHtml(g.label)}</span>
        <span class="nav-group-count">${g.members.length}</span>
      </div>
    `;
  },

  _navOthersHtml(count) {
    const open = Projects._othersOpen;
    return `
      <div class="nav-item nav-item--group-header nav-item--others" onclick="Projects.toggleOthers()" title="Other projects — ${count}">
        <span class="icon project-group-caret">${open ? '&#9660;' : '&#9654;'}</span>
        <span class="nav-label">Other projects</span>
        <span class="nav-group-count">${count}</span>
      </div>
    `;
  },

  /** The project list in sidebar order, flattened into the rows the sidebar and every project
   *  dropdown render from: 'section' rows (Favorites, Other projects — only when something is
   *  starred), 'group' rows, and 'project' rows with their depth, label and title. `extra`
   *  ({ slug, label, title }) are projects known elsewhere but not registered here; they go last,
   *  ungrouped, with no `project`. */
  listRows(extra = []) {
    const { favorites, others } = Projects._split();
    const extraRows = extra.filter(e => !Projects.data.some(p => p.slug === e.slug));
    const section = favorites.length ? 'others' : null;
    const row = (p, fields) => ({ kind: 'project', slug: p.slug, project: p, depth: 0, section, ...fields });
    const rows = [];
    if (favorites.length) {
      rows.push({ kind: 'section', key: 'favorites', label: 'Favorites' });
      for (const { project: p, children } of Projects._favoriteEntries()) {
        const label = Projects._favoriteLabel(p);
        rows.push(row(p, { section: 'favorites', label, title: label }));
        for (const { project: c, depth } of children) {
          rows.push(row(c, { section: 'favorites', depth: depth + 1, label: Projects._memberLabel(c), title: c.path }));
        }
      }
      if (others.length + extraRows.length) rows.push({ kind: 'section', key: 'others', label: 'Other projects', count: others.length });
    }
    const { groups, ungrouped } = Projects._grouped(favorites.length ? others : Projects.data);
    for (const g of groups) {
      rows.push({ kind: 'group', section, groupId: g.groupId, label: g.label, members: g.members });
      for (const { project: p, depth } of Projects._treeRows(Projects._tree(g.members))) {
        rows.push(row(p, { groupId: g.groupId, groupLabel: g.label, depth, label: Projects._memberLabel(p), title: p.path }));
      }
    }
    for (const p of ungrouped) rows.push(row(p, { label: decodeName(p.slug), title: decodeName(p.slug) }));
    for (const e of extraRows) rows.push({ kind: 'project', slug: e.slug, project: null, depth: 0, section, label: e.label, title: e.title });
    return rows;
  },

  /** Drop the section and group rows of `rows` left with no project rows under them. */
  pruneRows(rows) {
    return rows.filter(r => r.kind === 'project' || rows.some(x => x.kind === 'project'
      && (r.kind === 'group' ? x.groupId === r.groupId : x.section === r.key)));
  },

  /** A <select> of projects in sidebar order: favorites, each group and the rest as option groups,
   *  nested projects indented, full path as the tooltip. `leading` ([value, label, title?]) options go first; `extra` as in
   *  listRows; `filter(slug)` keeps a project. */
  selectHtml(id, selected, { leading = [], extra = [], filter = () => true } = {}) {
    const option = (value, label, title) =>
      `<option value="${escapeAttr(value)}"${title ? ` title="${escapeAttr(title)}"` : ''}${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    let html = leading.map(([value, label, title]) => option(value, label, title)).join('');
    let open = null;
    for (const r of Projects.listRows(extra)) {
      if (r.kind !== 'project' || !filter(r.slug)) continue;
      const key = r.groupId || r.section;
      if (key !== open) {
        if (open) html += '</optgroup>';
        const label = r.groupId ? r.groupLabel : r.section === 'favorites' ? '★ Favorites' : 'Other projects';
        if (key) html += `<optgroup label="${escapeAttr(label)}">`;
        open = key;
      }
      html += option(r.slug, '  '.repeat(r.depth) + r.label, r.project ? r.project.path : r.title);
    }
    if (open) html += '</optgroup>';
    return `<select id="${escapeAttr(id)}">${html}</select>`;
  },

  renderNav() {
    const list = document.getElementById('project-nav-list');
    let hidden = false;   // inside the folded "Other projects" section
    let folded = null;    // the collapsed group whose member rows are skipped
    list.innerHTML = Projects.listRows().map(r => {
      if (r.kind === 'section') {
        hidden = r.key === 'others' && !Projects._othersOpen;
        return r.key === 'others' ? Projects._navOthersHtml(r.count) : '';
      }
      if (hidden) return '';
      if (r.kind === 'group') {
        const expanded = Projects._expanded.has(r.groupId) || r.members.some(m => m.slug === App.currentProject);
        folded = expanded ? null : r.groupId;
        return Projects._navGroupHtml(r, expanded);
      }
      if (r.groupId && r.groupId === folded) return '';
      const indent = r.groupId ? { depth: r.depth } : r.depth ? { px: TREE_INDENT_ROOT + r.depth * TREE_INDENT_STEP } : {};
      return Projects._navItemHtml(r.project, { label: r.label, title: r.title, ...indent });
    }).join('');
    const countEl = document.getElementById('project-nav-count');
    if (countEl) countEl.textContent = Projects.data.length;
    if (typeof ActiveCount !== 'undefined') ActiveCount.refresh();
    if (typeof ActiveSessionsBar !== 'undefined') {
      ActiveSessionsBar._lastSidebarKey = null;
      ActiveSessionsBar._renderSidebar();
    }
  },

  async openFolder(slug) {
    try {
      await api(`/api/projects/${slug}/open-folder`, { method: 'POST' });
    } catch (e) {
      toast('Could not open folder: ' + e.message, 'error');
    }
  }
};

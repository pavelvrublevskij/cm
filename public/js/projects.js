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
    Projects.renderGrid();
    Projects.renderNav();
    try {
      await api(`/api/projects/${slug}/favorite`, { method: 'PUT', body: { favorite } });
    } catch (e) {
      p.favorite = !favorite;
      Projects.renderGrid();
      Projects.renderNav();
      toast('Could not update favorite: ' + e.message, 'error');
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

  _navGroupHtml(g) {
    const expanded = Projects._expanded.has(g.groupId) || g.members.some(m => m.slug === App.currentProject);
    const memberHtml = expanded
      ? Projects._treeRows(Projects._tree(g.members))
          .map(({ project: p, depth }) => Projects._navItemHtml(p, { label: Projects._memberLabel(p), title: p.path, depth }))
          .join('')
      : '';
    return `
      <div class="nav-item nav-item--group-header" onclick="Projects.toggleGroup('${g.groupId}')" title="${escapeAttr(g.label)} — ${g.members.length} projects">
        <span class="icon project-group-caret">${expanded ? '&#9660;' : '&#9654;'}</span>
        <span class="nav-label">${escapeHtml(g.label)}</span>
        <span class="nav-group-count">${g.members.length}</span>
      </div>
      ${memberHtml}
    `;
  },

  _navListHtml(list) {
    const { groups, ungrouped } = Projects._grouped(list);
    return groups.map(Projects._navGroupHtml).join('')
      + ungrouped.map(p => Projects._navItemHtml(p, { label: decodeName(p.slug), title: decodeName(p.slug) })).join('');
  },

  renderNav() {
    const list = document.getElementById('project-nav-list');
    const { favorites, others } = Projects._split();

    if (!favorites.length) {
      list.innerHTML = Projects._navListHtml(Projects.data);
    } else {
      const open = Projects._othersOpen;
      list.innerHTML = Projects._favoriteEntries().map(({ project: p, children }) => {
        const label = Projects._favoriteLabel(p);
        return Projects._navItemHtml(p, { label, title: label })
          + children.map(({ project: c, depth }) => Projects._navItemHtml(c, {
            label: Projects._memberLabel(c), title: c.path, px: TREE_INDENT_ROOT + (depth + 1) * TREE_INDENT_STEP
          })).join('');
      }).join('') + (others.length ? `
        <div class="nav-item nav-item--group-header nav-item--others" onclick="Projects.toggleOthers()" title="Other projects — ${others.length}">
          <span class="icon project-group-caret">${open ? '&#9660;' : '&#9654;'}</span>
          <span class="nav-label">Other projects</span>
          <span class="nav-group-count">${others.length}</span>
        </div>
        ${open ? Projects._navListHtml(others) : ''}
      ` : '');
    }
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

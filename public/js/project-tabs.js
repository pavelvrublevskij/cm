// --- Project Usage (header strip) ---

const ProjectUsage = {
  currentSlug: null,
  _df: null,

  get fromDate() { return ProjectUsage._df && ProjectUsage._df.fromDate; },
  get toDate() { return ProjectUsage._df && ProjectUsage._df.toDate; },
  get fromTime() { return ProjectUsage._df && ProjectUsage._df.fromTime; },
  get toTime() { return ProjectUsage._df && ProjectUsage._df.toTime; },
  get datePreset() { return ProjectUsage._df && ProjectUsage._df.datePreset; },

  async load(slug) {
    if (ProjectUsage.currentSlug !== slug) {
      ProjectUsage.currentSlug = slug;
      ProjectUsage._df = makeDateFilter('proj-filter-from', 'proj-filter-to', 'proj-filter-date-preset');
      ProjectUsage.applyDatePresetState('today');
    }
    await ProjectUsage.render();
  },

  applyDatePresetState(preset) {
    ProjectUsage._df.applyPreset(preset);
  },

  buildQuery() {
    return ProjectUsage._df ? ProjectUsage._df.queryString() : '';
  },

  async render() {
    const el = document.getElementById('project-detail-usage');
    if (!el || !ProjectUsage.currentSlug) return;
    el.innerHTML = '';
    try {
      const data = await api(`/api/usage/project/${ProjectUsage.currentSlug}${ProjectUsage.buildQuery()}`);
      if (!data.sessionCount) {
        el.innerHTML = '<span class="project-usage-empty">No token usage recorded</span>';
        return;
      }
      const t = data.totals;
      const c = data.cost;
      el.innerHTML = `
        <span class="project-usage-item"><span class="lbl">Sessions</span> <strong>${data.sessionCount}</strong></span>
        <span class="project-usage-item color-input"><span class="lbl">Input</span> <strong>${fmtTokens(t.input_tokens)}</strong></span>
        <span class="project-usage-item color-output"><span class="lbl">Output</span> <strong>${fmtTokens(t.output_tokens)}</strong></span>
        <span class="project-usage-item color-cache-write"><span class="lbl">Cache W</span> <strong>${fmtTokens(t.cache_creation_input_tokens)}</strong></span>
        <span class="project-usage-item color-cache-read"><span class="lbl">Hits</span> <strong>${fmtTokens(t.cache_read_input_tokens)}</strong></span>
        <span class="project-usage-item color-cost"><span class="lbl">Cost</span> <strong>$${c.total.toFixed(2)}</strong></span>
      `;
    } catch (e) {
      el.innerHTML = `<span class="project-usage-empty">Could not load usage: ${escapeHtml(e.message)}</span>`;
    }
  },

  setDatePreset(preset) {
    if (preset === 'custom') { if (ProjectUsage._df) ProjectUsage._df.datePreset = 'custom'; return; }
    ProjectUsage.applyDatePresetState(preset);
    ProjectUsage.render();
    if (typeof Sessions !== 'undefined') Sessions.rerenderWithFilter();
  },

  applyCustomDates() {
    ProjectUsage._df.applyCustom();
    ProjectUsage.render();
    if (typeof Sessions !== 'undefined') Sessions.rerenderWithFilter();
  },

  clearFilter() {
    ProjectUsage.applyDatePresetState('today');
    ProjectUsage.render();
    if (typeof Sessions !== 'undefined') Sessions.setPlanFilter(false);
  }
};

// --- Project Tabs ---

const ProjectTabs = {
  switch(tab, btn) {
    document.querySelectorAll('.project-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    btn.classList.add('active');
    ProjectTabs.loadTab(tab);
  },
  loadTab(tab) {
    if (!App.currentProject) return;
    const loaders = {
      'memory': () => Memory.load(App.currentProject),
      'sessions': () => Sessions.load(App.currentProject),
      'proj-settings': () => ProjectSettings.load(App.currentProject),
      'proj-mcp': () => ProjectMcp.load(App.currentProject),
      'proj-agents': () => ProjectAgents.load(App.currentProject),
      'proj-skills': () => ProjectSkills.load(App.currentProject),
      'proj-output-styles': () => ProjectOutputStyles.load(App.currentProject),
      'claude-md': () => ClaudeMd.loadProject(App.currentProject),
      'git': () => GitPanel.mount('git-tab-body', App.currentProject)
    };
    if (loaders[tab]) loaders[tab]();
  },
  refresh() {
    const activeTab = document.querySelector('.project-tab.active');
    if (activeTab) {
      const tab = activeTab.id.replace('tab-', '');
      ProjectTabs.loadTab(tab);
    }
    toast('Refreshed');
  }
};

// --- Project Agents Tab ---

const ProjectAgents = makeFrontmatterCrud({
  globalName: 'ProjectAgents',
  containerId: 'proj-agents-content',
  apiBase: () => `/api/agents/project/${ProjectAgents.slug}`,
  itemKey: 'filename',
  idPrefix: 'agent',
  itemLabel: 'Agent',
  cardTitle: a => `<span style="color:var(--accent)">${escapeHtml(a.name)}</span>`,
  editTitle: (item, filename) => item.frontmatter.name || filename,
  editContentLabel: 'Instructions',
  addCreateBtn: true,
  emptyHtml: '<div class="empty-state"><p>No custom agents</p><p style="color:var(--text-secondary);margin-top:8px">Custom agents are subagent definitions in .claude/agents/</p></div>',
  editExtraFields: (item, idp) => formRow(
    formGroup('Tools', `<input type="text" id="${idp}-edit-tools" value="${escapeHtml(item.frontmatter.tools || '')}" placeholder="Read, Grep, Bash(*)">`),
    formGroup('Model', `<input type="text" id="${idp}-edit-model" value="${escapeHtml(item.frontmatter.model || '')}" placeholder="default">`)
  ),
  readEditExtras: (fm, idp) => {
    const tools = document.getElementById(`${idp}-edit-tools`).value.trim();
    if (tools) fm.tools = tools; else delete fm.tools;
    const model = document.getElementById(`${idp}-edit-model`).value.trim();
    if (model) fm.model = model; else delete fm.model;
  },
  createFields: idp =>
    formGroup('Filename', `<input type="text" id="${idp}-new-file" placeholder="my-agent.md">`)
    + formGroup('Name', `<input type="text" id="${idp}-new-name" placeholder="Agent Name">`)
    + formGroup('Description', `<input type="text" id="${idp}-new-desc" placeholder="What this agent does">`),
  createBody: idp => {
    let filename = document.getElementById(`${idp}-new-file`).value.trim();
    if (!filename) { toast('Filename required', 'error'); return null; }
    if (!filename.endsWith('.md')) filename += '.md';
    return {
      key: filename,
      frontmatter: { name: document.getElementById(`${idp}-new-name`).value, description: document.getElementById(`${idp}-new-desc`).value },
      content: ''
    };
  }
});

// --- Project Skills Tab ---

const ProjectSkills = makeFrontmatterCrud({
  globalName: 'ProjectSkills',
  containerId: 'proj-skills-content',
  apiBase: () => `/api/skills/project/${ProjectSkills.slug}`,
  itemKey: 'name',
  idPrefix: 'pskill',
  itemLabel: 'Skill',
  cardTitle: s => `<span style="color:var(--accent);font-family:var(--font-mono)">/${escapeHtml(s.name)}</span>`,
  editTitle: (item, name) => '/' + name,
  addCreateBtn: true,
  emptyHtml: '<div class="empty-state"><p>No project-level skills</p><p style="color:var(--text-secondary);margin-top:8px">Skills are custom slash commands in .claude/skills/</p></div>',
  editExtraFields: (item, idp) => formRow(
    formGroup('Allowed Tools', `<input type="text" id="${idp}-edit-tools" value="${escapeHtml(item.frontmatter['allowed-tools'] || '')}" placeholder="Read, Grep, Bash(npm *)">`),
    formGroup('Model', `<input type="text" id="${idp}-edit-model" value="${escapeHtml(item.frontmatter.model || '')}" placeholder="default">`)
  ),
  readEditExtras: (fm, idp) => {
    const tools = document.getElementById(`${idp}-edit-tools`).value.trim();
    if (tools) fm['allowed-tools'] = tools; else delete fm['allowed-tools'];
    const model = document.getElementById(`${idp}-edit-model`).value.trim();
    if (model) fm.model = model; else delete fm.model;
  },
  createFields: idp =>
    formGroup('Skill Name (folder name)', `<input type="text" id="${idp}-new-name" placeholder="my-skill">`)
    + formGroup('Description', `<input type="text" id="${idp}-new-desc" placeholder="What this skill does">`),
  createBody: idp => {
    const name = document.getElementById(`${idp}-new-name`).value.trim();
    const desc = document.getElementById(`${idp}-new-desc`).value.trim();
    if (!name) { toast('Name required', 'error'); return null; }
    return { key: name, frontmatter: { name, description: desc }, content: '# Instructions\n\n' };
  }
});

// --- Project Output Styles Tab ---

const ProjectOutputStyles = makeFrontmatterCrud({
  globalName: 'ProjectOutputStyles',
  containerId: 'proj-output-styles-content',
  apiBase: () => `/api/output-styles/project/${ProjectOutputStyles.slug}`,
  itemKey: 'filename',
  idPrefix: 'pos',
  itemLabel: 'Output Style',
  cardTitle: s => escapeHtml(s.name),
  editTitle: (item, filename) => item.frontmatter.name || filename,
  addCreateBtn: true,
  emptyHtml: '<div class="empty-state"><p>No project-level output styles</p><p style="color:var(--text-secondary);margin-top:8px">Output styles are response presets in .claude/output-styles/</p></div>',
  createFields: idp =>
    formGroup('Filename', `<input type="text" id="${idp}-new-file" placeholder="my-style.md">`)
    + formGroup('Name', `<input type="text" id="${idp}-new-name" placeholder="My Style">`),
  createBody: idp => {
    let filename = document.getElementById(`${idp}-new-file`).value.trim();
    const name = document.getElementById(`${idp}-new-name`).value.trim();
    if (!filename) { toast('Filename required', 'error'); return null; }
    if (!filename.endsWith('.md')) filename += '.md';
    return { key: filename, frontmatter: { name, description: '' }, content: '' };
  }
});


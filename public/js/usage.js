const Usage = {
  currentGroup: 'day',
  currentModels: new Set(),
  currentProjects: new Map(),
  _df: null,
  allModels: [],
  allProjects: [],
  searchTerms: { models: '', projects: '' },
  openDropdown: null,
  viewMode: 'charts',

  saveFilterState() {
    localStorage.setItem('usage-group', Usage.currentGroup);
    const preset = document.getElementById('filter-date-preset');
    if (preset) localStorage.setItem('usage-date-preset', preset.value);
    const from = document.getElementById('filter-from');
    const to = document.getElementById('filter-to');
    if (from) localStorage.setItem('usage-date-from', from.value || '');
    if (to) localStorage.setItem('usage-date-to', to.value || '');
    localStorage.setItem('usage-models', JSON.stringify(Array.from(Usage.currentModels)));
    localStorage.setItem('usage-projects', JSON.stringify(Array.from(Usage.currentProjects.entries())));
  },

  restoreFilterState() {
    const group = localStorage.getItem('usage-group') || 'day';
    const preset = localStorage.getItem('usage-date-preset') || 'month';
    const from = localStorage.getItem('usage-date-from') || '';
    const to = localStorage.getItem('usage-date-to') || '';
    const models = JSON.parse(localStorage.getItem('usage-models') || '[]');
    const projects = JSON.parse(localStorage.getItem('usage-projects') || '[]');

    Usage.currentGroup = group;
    Usage.currentModels = new Set(models);
    Usage.currentProjects = new Map(projects);

    Usage._df = makeDateFilter('filter-from', 'filter-to', 'filter-date-preset');
    if (preset === 'custom') {
      const fromEl = document.getElementById('filter-from');
      const toEl = document.getElementById('filter-to');
      if (fromEl) fromEl.value = from;
      if (toEl) toEl.value = to;
      Usage._df.applyCustom();
      const presetEl = document.getElementById('filter-date-preset');
      if (presetEl) presetEl.value = 'custom';
    } else {
      Usage.applyDatePresetState(preset);
    }
  },

  async load() {
    Usage.searchTerms = { models: '', projects: '' };
    Usage.restoreFilterState();
    const savedMode = localStorage.getItem('usage-view-mode') || 'charts';
    Usage.setViewMode(savedMode, { silent: true });
    Usage.bindOutsideClick();
    await Usage.refresh();
  },

  applyDatePresetState(preset) {
    Usage._df.applyPreset(preset);
  },

  setViewMode(mode, opts) {
    if (mode !== 'charts' && mode !== 'tables') mode = 'charts';
    Usage.viewMode = mode;
    if (!opts || !opts.silent) localStorage.setItem('usage-view-mode', mode);
    const view = document.getElementById('view-usage');
    if (view) view.dataset.viewMode = mode;
    document.querySelectorAll('#usage-view-toggle .view-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (mode === 'charts' && typeof UsageCharts !== 'undefined' && UsageCharts.lastData) {
      UsageCharts.rerenderForTheme();
    }
  },

  basename(p) {
    if (!p) return '';
    const m = String(p).match(/[^\\\/]+$/);
    return m ? m[0] : p;
  },

  buildQuery() {
    let q = '';
    for (const m of Usage.currentModels) q += '&models=' + encodeURIComponent(m);
    for (const slug of Usage.currentProjects.keys()) q += '&projects=' + encodeURIComponent(slug);
    for (const part of Usage._df.queryParts()) q += '&' + part;
    return q;
  },

  async refresh() {
    const viewBody = document.querySelector('#view-usage .view-body');
    const scrollTop = viewBody ? viewBody.scrollTop : 0;

    showLoading('usage-summary');
    document.getElementById('usage-periods').innerHTML = '';
    document.getElementById('usage-projects').innerHTML = '';

    document.querySelectorAll('#usage-period-tabs .tab-btn, #usage-period-tabs-chart .tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.group === Usage.currentGroup);
    });

    const q = Usage.buildQuery();

    try {
      const [summary, periods, projects] = await Promise.all([
        api('/api/usage/summary?_=1' + q),
        api('/api/usage/by-period?group=' + Usage.currentGroup + q),
        api('/api/usage/by-project?_=1' + q),
        UsageMarks.fetch()
      ]);
      Usage.allModels = summary.allModels || [];
      Usage.allProjects = summary.allProjects || [];
      Usage.renderSummary(summary);
      Usage.initTooltips();
      Usage.renderByModel(summary.byModel, summary.modelPricing);
      Usage.renderPricing(summary.modelPricing, summary.byModel, summary.pricingUpdated, summary.pricingSource);
      Usage.renderPeriods(periods.periods);
      Usage.renderProjects(projects.projects);
      UsageMarks.render();
      if (typeof UsageCharts !== 'undefined') {
        UsageCharts.lastData = { summary: summary, periods: periods.periods, projects: projects.projects };
        if (Usage.viewMode === 'charts') {
          const view = document.getElementById('view-usage');
          if (view) view.dataset.viewMode = 'tables';
          requestAnimationFrame(() => {
            if (view) view.dataset.viewMode = 'charts';
            UsageCharts.rerenderForTheme();
          });
        }
      }
      Usage.renderTriggerLabels();
      Usage.renderDropdownList('models');
      Usage.renderDropdownList('projects');
      if (viewBody) viewBody.scrollTop = scrollTop;
    } catch (e) {
      toast('Could not load usage data: ' + e.message, 'error');
    }
  },

  async setGroup(group, btn) {
    Usage.currentGroup = group;
    Usage.saveFilterState();
    document.querySelectorAll('#usage-period-tabs .tab-btn, #usage-period-tabs-chart .tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.group === group);
    });
    const viewBody = document.querySelector('#view-usage .view-body');
    const scrollTop = viewBody ? viewBody.scrollTop : 0;
    showLoading('usage-periods');
    const q = Usage.buildQuery();
    try {
      const data = await api('/api/usage/by-period?group=' + group + q);
      Usage.renderPeriods(data.periods);
      if (typeof UsageCharts !== 'undefined') {
        UsageCharts.renderPeriod(data.periods, UsageCharts.palette());
        if (UsageCharts.lastData) UsageCharts.lastData.periods = data.periods;
      }
      if (viewBody) viewBody.scrollTop = scrollTop;
    } catch (e) {
      toast('Could not load period data: ' + e.message, 'error');
    }
  },

  toggleDropdown(key, event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('filter-' + key + '-panel');
    if (Usage.openDropdown === key) {
      panel.hidden = true;
      Usage.openDropdown = null;
    } else {
      if (Usage.openDropdown) {
        document.getElementById('filter-' + Usage.openDropdown + '-panel').hidden = true;
      }
      panel.hidden = false;
      Usage.openDropdown = key;
      const search = panel.querySelector('.multi-select-search');
      if (search) { search.value = Usage.searchTerms[key] || ''; search.focus(); }
    }
  },

  bindOutsideClick() {
    if (Usage._outsideBound) return;
    Usage._outsideBound = true;
    document.addEventListener('click', e => {
      if (!Usage.openDropdown) return;
      if (e.target.closest('.multi-select')) return;
      document.getElementById('filter-' + Usage.openDropdown + '-panel').hidden = true;
      Usage.openDropdown = null;
    });
  },

  filterOptions(key, term) {
    Usage.searchTerms[key] = (term || '').toLowerCase();
    Usage.renderDropdownList(key);
  },

  renderDropdownList(key) {
    const listEl = document.getElementById('filter-' + key + '-list');
    if (!listEl) return;
    const term = Usage.searchTerms[key] || '';
    let items;
    if (key === 'models') {
      items = Usage.allModels
        .filter(m => !term || m.toLowerCase().includes(term) || (Usage.fmtModel(m) || '').toLowerCase().includes(term))
        .map(m => ({
          value: m,
          label: Usage.fmtModel(m),
          checked: Usage.currentModels.has(m)
        }));
    } else {
      items = Usage.allProjects
        .map(p => ({ p, base: Usage.basename(p.name) }))
        .filter(({ p, base }) => !term || base.toLowerCase().includes(term))
        .sort((a, b) => a.base.localeCompare(b.base))
        .map(({ p, base }) => ({
          value: p.slug,
          extra: p.name,
          label: base,
          title: p.name,
          checked: Usage.currentProjects.has(p.slug)
        }));
    }
    if (!items.length) {
      listEl.innerHTML = '<div class="multi-select-empty">No matches</div>';
      return;
    }
    const jsQuote = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    listEl.innerHTML = items.map(it => {
      const valAttr = escapeHtml(jsQuote(it.value));
      const extraAttr = it.extra ? escapeHtml(jsQuote(it.extra)) : '';
      const onchange = key === 'models'
        ? `Usage.toggleModel('${valAttr}')`
        : `Usage.toggleProject('${valAttr}', '${extraAttr}')`;
      const titleAttr = it.title ? ` title="${escapeHtml(it.title)}"` : '';
      return `<label class="multi-select-option"${titleAttr}>
        <input type="checkbox" ${it.checked ? 'checked' : ''} onchange="${onchange}">
        <span>${escapeHtml(it.label)}</span>
      </label>`;
    }).join('');
  },

  renderTriggerLabels() {
    const mLabel = document.getElementById('filter-models-label');
    if (mLabel) {
      mLabel.textContent = Usage.currentModels.size === 0
        ? 'All models'
        : Usage.currentModels.size === 1
          ? Usage.fmtModel(Array.from(Usage.currentModels)[0])
          : Usage.currentModels.size + ' models selected';
    }
    const pLabel = document.getElementById('filter-projects-label');
    if (pLabel) {
      pLabel.textContent = Usage.currentProjects.size === 0
        ? 'All projects'
        : Usage.currentProjects.size === 1
          ? Usage.basename(Array.from(Usage.currentProjects.values())[0])
          : Usage.currentProjects.size + ' projects selected';
    }
  },

  toggleModel(model) {
    if (Usage.currentModels.has(model)) Usage.currentModels.delete(model);
    else Usage.currentModels.add(model);
    Usage.saveFilterState();
    Usage.refresh();
  },

  toggleProject(slug, name) {
    if (Usage.currentProjects.has(slug)) Usage.currentProjects.delete(slug);
    else Usage.currentProjects.set(slug, name || slug);
    Usage.saveFilterState();
    Usage.refresh();
  },

  setDatePreset(preset) {
    if (preset === 'custom') { Usage._df.datePreset = 'custom'; Usage.saveFilterState(); return; }
    const autoGroup = { today: 'hour', yesterday: 'hour', '7d': 'day', '30d': 'day', month: 'day', year: 'month', all: 'month' };
    if (autoGroup[preset]) {
      Usage.currentGroup = autoGroup[preset];
      document.querySelectorAll('#usage-period-tabs .tab-btn, #usage-period-tabs-chart .tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.group === Usage.currentGroup);
      });
    }
    Usage.applyDatePresetState(preset);
    Usage.saveFilterState();
    Usage.refresh();
  },

  applyCustomDates() {
    Usage._df.applyCustom();
    Usage.saveFilterState();
    Usage.refresh();
  },

  clearFilters() {
    Usage.currentModels = new Set();
    Usage.currentProjects = new Map();
    Usage.searchTerms = { models: '', projects: '' };
    Usage.currentGroup = 'day';
    Usage.applyDatePresetState('month');
    Usage.saveFilterState();
    Usage.refresh();
  },

  togglePricing() {
    const el = document.getElementById('usage-pricing');
    const chev = document.getElementById('usage-pricing-chevron');
    const hidden = el.style.display === 'none';
    el.style.display = hidden ? '' : 'none';
    chev.innerHTML = hidden ? '&#9660;' : '&#9654;';
  },

  renderSummary(data) {
    const t = data.totals;
    const c = data.cost;
    const items = [
      { label: 'Input Tokens', value: fmtTokens(t.input_tokens), sub: Usage.fmtCost(c.input), color: 'color-input',
        tip: 'Tokens sent to Claude in your prompts, system instructions, and tool results. This is what you "say" to the model each turn.' },
      { label: 'Output Tokens', value: fmtTokens(t.output_tokens), sub: Usage.fmtCost(c.output), color: 'color-output',
        tip: 'Tokens generated by Claude in responses — text, code, tool calls, and thinking. The most expensive token type.' },
      { label: 'Cache Write', value: fmtTokens(t.cache_creation_input_tokens), sub: Usage.fmtCost(c.cache_write), color: 'color-cache-write',
        tip: 'Input tokens written to the prompt cache on first use. Slightly more expensive than regular input, but enables cheaper cache reads on subsequent turns.' },
      { label: 'Cache Hits & Refreshes', value: fmtTokens(t.cache_read_input_tokens), sub: Usage.fmtCost(c.cache_read), color: 'color-cache-read',
        tip: 'Input tokens served from cache instead of being re-processed. 10x cheaper than regular input. Typically the largest number — Claude Code aggressively caches conversation context.' },
      { label: 'Total Cost', value: Usage.fmtCost(c.total), sub: data.sessionCount + ' sessions / ' + data.projectCount + ' projects', color: 'color-cost',
        tip: 'Estimated total based on actual model pricing per message. Each message is costed using the model that generated it.' }
    ];
    document.getElementById('usage-summary').innerHTML = items.map(i => `
      <div class="stat-card ${i.color} has-tooltip">
        <div class="stat-card-value">${escapeHtml(i.value)}</div>
        <div class="stat-card-label">${escapeHtml(i.label)}</div>
        <div class="stat-card-sub">${escapeHtml(i.sub)}</div>
        <div class="stat-tooltip">${escapeHtml(i.tip)}</div>
      </div>
    `).join('');
  },

  renderByModel(byModel, modelPricing) {
    const el = document.getElementById('usage-by-model');
    if (!el) return;
    if (!byModel || Object.keys(byModel).length === 0) {
      el.innerHTML = '<div class="empty-state"><p>No usage data</p></div>';
      return;
    }
    const cols = [
      { label: 'Model' },
      { label: 'Input', cls: 'col-input' },
      { label: 'Output', cls: 'col-output' },
      { label: 'Cache Write', cls: 'col-cache-write' },
      { label: 'Cache Hits', cls: 'col-cache-read' },
      { label: 'Cost', cls: 'col-cost' }
    ];
    const rows = Object.entries(byModel).map(([model, tokens]) => {
      const r = matchPricing(model, modelPricing) || {};
      const cost = (tokens.input_tokens || 0) * (r.input || 0) / 1e6
        + (tokens.output_tokens || 0) * (r.output || 0) / 1e6
        + (tokens.cache_creation_input_tokens || 0) * (r.cache_write || 0) / 1e6
        + (tokens.cache_read_input_tokens || 0) * (r.cache_read || 0) / 1e6;
      return [
        Usage.fmtModel(model),
        fmtTokens(tokens.input_tokens),
        fmtTokens(tokens.output_tokens),
        fmtTokens(tokens.cache_creation_input_tokens),
        fmtTokens(tokens.cache_read_input_tokens),
        Usage.fmtCost(cost)
      ];
    });
    el.innerHTML = buildTable(cols, rows);
  },

  renderPricing(modelPricing, byModel, pricingUpdated, pricingSource) {
    const el = document.getElementById('usage-pricing');
    const cols = [
      { label: 'Model' },
      { label: 'Input', cls: 'col-input' },
      { label: 'Output', cls: 'col-output' },
      { label: 'Cache Write', cls: 'col-cache-write' },
      { label: 'Cache Hits', cls: 'col-cache-read' }
    ];
    const pricingKeys = ['input', 'output', 'cache_write', 'cache_read'];
    const models = Object.keys(byModel || {}).filter(m => matchPricing(m, modelPricing));
    const rows = models.map(m => {
      const r = matchPricing(m, modelPricing);
      return [Usage.fmtModel(m), ...pricingKeys.map(k => '$' + r[k].toFixed(2))];
    });

    const updatedStr = pricingUpdated ? `Last fetched: <strong>${new Date(pricingUpdated).toLocaleString()}</strong>.` : 'No pricing data fetched yet.';
    const sourceStr = pricingSource ? ` <a href="${escapeHtml(pricingSource)}" target="_blank" class="usage-project-link">Verify on Anthropic</a>` : '';

    el.innerHTML = buildTable(cols, rows) + `
    <div class="info-note" style="margin-top:8px">
      Rates per 1M tokens (5-minute cache writes). Costs are calculated per message using the actual model.
      Subscription plans may differ from API pricing.<br>
      ${updatedStr}${sourceStr}
    </div>`;
  },

  async fetchPricing() {
    try {
      const result = await api('/api/pricing/fetch', { method: 'POST' });
      toast(result.changed ? 'Pricing updated — changes detected' : 'Pricing checked — no changes');
      if (result.changed) Usage.refresh();
    } catch (e) {
      toast('Failed to fetch pricing: ' + e.message, 'error');
    }
  },

  renderPeriods(periods) {
    const el = document.getElementById('usage-periods');
    if (!periods.length) {
      el.innerHTML = '<div class="empty-state"><p>No usage data</p></div>';
      return;
    }
    const maxCost = Math.max(...periods.map(p => p.cost)) || 1;
    const cols = [
      { label: 'Period' },
      { label: 'Input', cls: 'col-input' },
      { label: 'Output', cls: 'col-output' },
      { label: 'Cache Write', cls: 'col-cache-write' },
      { label: 'Cache Hits', cls: 'col-cache-read' },
      { label: 'Cost', cls: 'col-cost' }
    ];
    const rows = periods.map(p => [
      escapeHtml(p.label),
      fmtTokens(p.input_tokens),
      fmtTokens(p.output_tokens),
      fmtTokens(p.cache_creation_input_tokens),
      fmtTokens(p.cache_read_input_tokens),
      Usage.fmtCost(p.cost) + `<div class="usage-bar" style="width:${(p.cost / maxCost * 100).toFixed(1)}%"></div>`
    ]);
    el.innerHTML = buildTable(cols, rows);
  },

  renderProjects(projects) {
    const el = document.getElementById('usage-projects');
    if (!projects.length) {
      el.innerHTML = '<div class="empty-state"><p>No usage data</p></div>';
      return;
    }
    const maxCost = Math.max(...projects.map(p => p.cost)) || 1;
    const cols = [
      { label: 'Project' },
      { label: 'Sessions' },
      { label: 'Input', cls: 'col-input' },
      { label: 'Output', cls: 'col-output' },
      { label: 'Cost', cls: 'col-cost' }
    ];
    const rows = projects.map(p => [
      `<a href="#project-detail/${escapeHtml(p.slug)}" class="usage-project-link" title="${escapeHtml(p.name)}">${escapeHtml(Usage.basename(p.name))}</a>`,
      p.sessionCount,
      fmtTokens(p.input_tokens),
      fmtTokens(p.output_tokens),
      Usage.fmtCost(p.cost) + `<div class="usage-bar" style="width:${(p.cost / maxCost * 100).toFixed(1)}%"></div>`
    ]);
    el.innerHTML = buildTable(cols, rows);
  },

  fmtCost(n) {
    if (!n) return '$0.00';
    return '$' + n.toFixed(2);
  },

  fmtModel(model) {
    return shortModel(model) || model;
  },

  initTooltips() {
    document.getElementById('usage-summary').addEventListener('mousemove', e => {
      const card = e.target.closest('.has-tooltip');
      if (!card) return;
      const tip = card.querySelector('.stat-tooltip');
      if (!tip) return;
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top = (e.clientY + 12) + 'px';
    });
    document.getElementById('usage-summary').addEventListener('mouseleave', e => {
      document.querySelectorAll('.stat-tooltip').forEach(t => t.style.display = 'none');
    }, true);
    document.getElementById('usage-summary').addEventListener('mouseout', e => {
      const card = e.target.closest('.has-tooltip');
      const related = e.relatedTarget?.closest?.('.has-tooltip');
      if (card && card !== related) {
        const tip = card.querySelector('.stat-tooltip');
        if (tip) tip.style.display = 'none';
      }
    });
  }
};

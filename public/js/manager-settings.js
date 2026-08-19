const ManagerSettings = {
  pricing: {},
  history: [],
  activeIdx: -1,
  SECTION_KEY: 'claude-manager-settings-section',
  _navBound: false,

  async load() {
    ManagerSettings.bindNav();
    ManagerSettings.restoreSection();
    ManagerSettings.renderThemePicker();
    try {
      const [config, pricingData, history] = await Promise.all([
        api('/api/pricing/config'),
        api('/api/pricing'),
        api('/api/pricing/history')
      ]);
      document.getElementById('pricing-fetch-url').value = config.url;
      ManagerSettings.history = history || [];
      ManagerSettings.activeIdx = ManagerSettings.history.length - 1;
      ManagerSettings.pricing = pricingData.current || {};
      ManagerSettings.renderHistory();
      ManagerSettings.renderTable();
      ManagerSettings.loadRefreshRate();
      ManagerSettings.loadAutosave();
    } catch (e) {
      toast('Failed to load manager settings: ' + e.message, 'error');
    }
  },

  renderThemePicker() {
    const sel = document.getElementById('theme-select');
    if (!sel || typeof Theme === 'undefined') return;
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    sel.innerHTML = Theme.themes.map(t =>
      `<option value="${t}"${t === current ? ' selected' : ''}>${Theme.labels[t]}</option>`
    ).join('');
  },

  onThemeChange(name) {
    if (typeof Theme === 'undefined' || !Theme.themes.includes(name)) return;
    Theme.apply(name);
    try { localStorage.setItem('claude-manager-theme', name); } catch (_) {}
  },

  bindNav() {
    if (ManagerSettings._navBound) return;
    document.querySelectorAll('#settings-nav .settings-nav-item').forEach(item => {
      item.addEventListener('click', () => ManagerSettings.selectSection(item.dataset.section));
    });
    ManagerSettings._navBound = true;
  },

  selectSection(name) {
    const navItems = document.querySelectorAll('#settings-nav .settings-nav-item');
    const panels = document.querySelectorAll('#view-manager-settings .settings-panel');
    let matched = false;
    navItems.forEach(n => {
      const active = n.dataset.section === name;
      n.classList.toggle('active', active);
      if (active) matched = true;
    });
    panels.forEach(p => p.classList.toggle('active', p.dataset.section === name));
    if (matched) try { localStorage.setItem(ManagerSettings.SECTION_KEY, name); } catch (_) {}
  },

  restoreSection() {
    let name = '';
    try { name = localStorage.getItem(ManagerSettings.SECTION_KEY) || ''; } catch (_) {}
    if (name && document.querySelector(`#settings-nav .settings-nav-item[data-section="${name}"]`)) {
      ManagerSettings.selectSection(name);
    } else {
      ManagerSettings.selectSection('general');
    }
  },

  renderHistory() {
    const el = document.getElementById('manager-pricing-history');
    const entries = ManagerSettings.history;
    if (!entries.length) {
      el.innerHTML = '<div class="empty-state"><p>No pricing history. Fetch from Anthropic or add manually.</p></div>';
      return;
    }
    el.innerHTML = `<table class="usage-table">
      <thead><tr><th>Date</th><th>Source</th><th>Models</th><th>Changes</th><th></th></tr></thead>
      <tbody>${[...entries].map((entry, i) => ({entry, i})).reverse().map(({entry, i}) => {
        const date = new Date(entry.fetchedAt).toLocaleString();
        const source = entry.source === 'manual' ? 'Manual' : 'Fetched';
        const modelCount = Object.keys(entry.models || {}).length;
        const prev = i > 0 ? entries[i - 1].models : null;
        const changes = ManagerSettings.diffSummary(prev, entry.models);
        const active = i === ManagerSettings.activeIdx ? ' class="model-active"' : '';
        return `<tr${active} style="cursor:pointer" onclick="ManagerSettings.selectEntry(${i})">
          <td style="white-space:nowrap">${escapeHtml(date)}</td>
          <td>${escapeHtml(source)}</td>
          <td>${modelCount}</td>
          <td>${i === 0 ? 'Initial' : (changes || 'No changes')}</td>
          <td><button class="btn btn-sm" onclick="event.stopPropagation(); ManagerSettings.selectEntry(${i})">Load</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  },

  diffSummary(prev, current) {
    if (!prev) return '';
    const changes = [];
    const allModels = new Set([...Object.keys(prev), ...Object.keys(current)]);
    for (const model of allModels) {
      const p = prev[model], c = current[model];
      if (!p && c) { changes.push(`+${shortModel(model)}`); continue; }
      if (p && !c) { changes.push(`-${shortModel(model)}`); continue; }
      for (const f of ['input', 'output', 'cache_write', 'cache_read']) {
        if (p[f] !== c[f]) { changes.push(`${shortModel(model)}`); break; }
      }
    }
    return changes.length ? escapeHtml(changes.join(', ')) : '';
  },

  selectEntry(idx) {
    ManagerSettings.activeIdx = idx;
    ManagerSettings.pricing = JSON.parse(JSON.stringify(ManagerSettings.history[idx].models));
    ManagerSettings.renderHistory();
    ManagerSettings.renderTable();
  },

  getEntryDateValue() {
    const entry = ManagerSettings.history[ManagerSettings.activeIdx];
    if (!entry) return '';
    const d = new Date(entry.fetchedAt);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  },

  renderTable() {
    const el = document.getElementById('manager-pricing-table');
    const models = Object.entries(ManagerSettings.pricing);
    if (!models.length) {
      el.innerHTML = '<div class="empty-state"><p>No pricing data. Fetch from Anthropic or add manually.</p></div>';
      return;
    }
    const dateVal = ManagerSettings.getEntryDateValue();
    el.innerHTML = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
      <label style="font-size:12px;color:var(--text-muted);white-space:nowrap">Entry Date</label>
      <input type="datetime-local" id="pricing-entry-date" class="pricing-input" value="${dateVal}">
    </div>
    <table class="usage-table">
      <thead><tr>
        <th>Model ID</th>
        <th>Input</th>
        <th>Output</th>
        <th>Cache Write</th>
        <th>Cache Hits</th>
        <th></th>
      </tr></thead>
      <tbody>${models.map(([id, r], i) => `<tr>
        <td><input type="text" class="pricing-input pricing-id" data-idx="${i}" value="${escapeHtml(id)}"></td>
        <td><input type="number" class="pricing-input pricing-num" data-idx="${i}" data-field="input" value="${r.input}" step="0.01"></td>
        <td><input type="number" class="pricing-input pricing-num" data-idx="${i}" data-field="output" value="${r.output}" step="0.01"></td>
        <td><input type="number" class="pricing-input pricing-num" data-idx="${i}" data-field="cache_write" value="${r.cache_write}" step="0.01"></td>
        <td><input type="number" class="pricing-input pricing-num" data-idx="${i}" data-field="cache_read" value="${r.cache_read}" step="0.01"></td>
        <td><button class="btn btn-sm btn-danger" onclick="ManagerSettings.removeModel(${i})">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="info-note" style="margin-top:8px">Prices per 1M tokens. Model IDs should match Claude API format (e.g. claude-opus-4-6). Click a history entry to load it for editing.</div>`;
  },

  addModel() {
    ManagerSettings.pricing['claude-new-model'] = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    ManagerSettings.renderTable();
    const inputs = document.querySelectorAll('.pricing-id');
    if (inputs.length) inputs[inputs.length - 1].select();
  },

  removeModel(idx) {
    const keys = Object.keys(ManagerSettings.pricing);
    if (keys[idx]) {
      delete ManagerSettings.pricing[keys[idx]];
      ManagerSettings.renderTable();
    }
  },

  readTableInputs() {
    const rows = document.querySelectorAll('#manager-pricing-table tbody tr');
    const models = {};
    for (const row of rows) {
      const id = row.querySelector('.pricing-id').value.trim();
      if (!id) continue;
      const nums = row.querySelectorAll('.pricing-num');
      const r = {};
      for (const n of nums) r[n.dataset.field] = parseFloat(n.value) || 0;
      models[id] = r;
    }
    return models;
  },

  getEntryDate() {
    const input = document.getElementById('pricing-entry-date');
    return input && input.value ? new Date(input.value).toISOString() : new Date().toISOString();
  },

  async savePricing() {
    const models = ManagerSettings.readTableInputs();
    if (!Object.keys(models).length) return toast('No models to save', 'error');
    try {
      await api('/api/pricing/manual', { method: 'POST', body: { models, fetchedAt: ManagerSettings.getEntryDate() } });
      ManagerSettings.pricing = models;
      const history = await api('/api/pricing/history');
      ManagerSettings.history = history || [];
      ManagerSettings.activeIdx = ManagerSettings.history.length - 1;
      ManagerSettings.renderHistory();
      ManagerSettings.renderTable();
      toast('Pricing saved as new entry');
    } catch (e) {
      toast('Failed to save pricing: ' + e.message, 'error');
    }
  },

  async updateEntry() {
    const idx = ManagerSettings.activeIdx;
    if (idx < 0 || idx >= ManagerSettings.history.length) return toast('No entry selected', 'error');
    const models = ManagerSettings.readTableInputs();
    if (!Object.keys(models).length) return toast('No models to save', 'error');
    const fetchedAt = ManagerSettings.getEntryDate();
    try {
      await api(`/api/pricing/history/${idx}`, { method: 'PUT', body: { models, fetchedAt } });
      // Reload from server (server re-sorts by date)
      const history = await api('/api/pricing/history');
      ManagerSettings.history = history || [];
      // Find the updated entry by matching fetchedAt
      ManagerSettings.activeIdx = ManagerSettings.history.findIndex(e => e.fetchedAt === fetchedAt);
      if (ManagerSettings.activeIdx < 0) ManagerSettings.activeIdx = ManagerSettings.history.length - 1;
      ManagerSettings.pricing = models;
      ManagerSettings.renderHistory();
      ManagerSettings.renderTable();
      toast('Entry updated');
    } catch (e) {
      toast('Failed to update entry: ' + e.message, 'error');
    }
  },

  async saveUrl() {
    const url = document.getElementById('pricing-fetch-url').value.trim();
    if (!url) return toast('URL cannot be empty', 'error');
    try {
      await api('/api/pricing/config', { method: 'PUT', body: { url } });
      toast('Fetch URL saved');
    } catch (e) {
      toast('Failed to save URL: ' + e.message, 'error');
    }
  },

  async resetUrl() {
    try {
      const defaultUrl = 'https://platform.claude.com/docs/en/docs/about-claude/pricing';
      document.getElementById('pricing-fetch-url').value = defaultUrl;
      await api('/api/pricing/config', { method: 'PUT', body: { url: defaultUrl } });
      toast('URL reset to default');
    } catch (e) {
      toast('Failed to reset URL: ' + e.message, 'error');
    }
  },

  loadRefreshRate() {
    const input = document.getElementById('conversation-refresh-rate');
    if (!input) return;
    const ms = (typeof Sessions !== 'undefined') ? Sessions.refreshIntervalMs() : 5000;
    input.value = String(Math.round(ms / 1000));
  },

  saveRefreshRate() {
    const input = document.getElementById('conversation-refresh-rate');
    if (!input) return;
    const seconds = parseFloat(input.value);
    if (!Number.isFinite(seconds) || seconds < 1) { toast('Refresh rate must be at least 1 second', 'error'); return; }
    const ms = Math.round(seconds * 1000);
    if (typeof Sessions === 'undefined' || !Sessions.setRefreshIntervalMs(ms)) { toast('Failed to save refresh rate', 'error'); return; }
    toast('Refresh rate saved');
  },

  resetRefreshRate() {
    const input = document.getElementById('conversation-refresh-rate');
    if (!input) return;
    if (typeof Sessions !== 'undefined') Sessions.setRefreshIntervalMs(Sessions.REFRESH_INTERVAL_DEFAULT_MS);
    input.value = String(Math.round((typeof Sessions !== 'undefined' ? Sessions.REFRESH_INTERVAL_DEFAULT_MS : 5000) / 1000));
    toast('Refresh rate reset to default');
  },

  loadAutosave() {
    const toggle = document.getElementById('editor-autosave-enabled');
    const delay = document.getElementById('editor-autosave-delay');
    if (!toggle || !delay || typeof SessionFiles === 'undefined') return;
    toggle.checked = SessionFiles.autosaveEnabled();
    delay.value = String(SessionFiles.autosaveDelayMs() / 1000);
  },

  saveAutosaveEnabled(on) {
    if (typeof SessionFiles === 'undefined') return;
    SessionFiles.setAutosaveEnabled(on);
    toast(on ? 'Autosave enabled' : 'Autosave disabled');
  },

  saveAutosaveDelay() {
    const input = document.getElementById('editor-autosave-delay');
    if (!input || typeof SessionFiles === 'undefined') return;
    const ms = Math.round(parseFloat(input.value) * 1000);
    if (!SessionFiles.setAutosaveDelayMs(ms)) {
      toast('Autosave delay must be at least 0.5 seconds', 'error');
      return;
    }
    toast('Autosave delay saved');
  },

  resetAutosaveDelay() {
    const input = document.getElementById('editor-autosave-delay');
    if (!input || typeof SessionFiles === 'undefined') return;
    SessionFiles.setAutosaveDelayMs(SessionFiles.AUTOSAVE_DEFAULT_DELAY_MS);
    input.value = String(SessionFiles.AUTOSAVE_DEFAULT_DELAY_MS / 1000);
    toast('Autosave delay reset to default');
  }
};

// --- Usage Insights ---
// Asks the user's own local `claude` CLI to review the filtered usage stats (and marks)
// for efficiency gaps and suggestions. No API key — it runs on the user's Claude login.

const UsageInsights = {
  MODELS: [
    { value: 'default', label: 'Default (your claude setting)' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' }
  ],
  EFFORTS: [
    { value: 'default', label: 'Default (your claude setting)' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' }
  ],
  running: false,

  optionsHtml(id, options) {
    return `<select id="${id}">${options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}</select>`;
  },

  /** Confirm step: tell the user AI will be used, and let them pick model and effort. */
  open() {
    if (UsageInsights.running) return;
    const body = `
      <div class="info-note usage-insights-notice">
        <strong>This uses AI.</strong> The aggregated usage stats for the current filters
        (token counts, costs, models, project names, session ids and your marks — no prompts or code)
        are sent to Claude through your local <code>claude</code> CLI. It runs on your Claude login
        and counts toward your Claude usage. It can take a minute.
      </div>
      <div class="usage-insights-criteria">
        <div class="usage-insights-criteria-title">Analyzed with the current filters</div>
        ${UsageInsights.criteriaHtml()}
      </div>
      ${formRow(
        formGroup('Model', UsageInsights.optionsHtml('insights-model', UsageInsights.MODELS)),
        formGroup('Effort', UsageInsights.optionsHtml('insights-effort', UsageInsights.EFFORTS))
      )}`;
    openModal({
      title: 'Analyze Efficiency with AI',
      body,
      buttons: [{
        label: 'Analyze',
        primary: true,
        onClick: () => {
          const model = document.getElementById('insights-model').value;
          const effort = document.getElementById('insights-effort').value;
          UsageInsights.showResult(model, effort);
        }
      }]
    });
  },

  showResult(model, effort) {
    openModal({
      title: 'Efficiency Insights',
      width: 760,
      cls: 'usage-insights-modal',
      resizable: { minWidth: 480, minHeight: 320 },
      cancelLabel: 'Close',
      body: '<div id="usage-insights-body"></div>',
      buttons: [{ label: 'Analyze again', onClick: () => { if (UsageInsights.running) return false; UsageInsights.open(); } }]
    });
    UsageInsights.run(model, effort);
  },

  projectsText() {
    return Usage.currentProjects.size === 0
      ? 'All projects'
      : Array.from(Usage.currentProjects.values()).map(n => Usage.basename(n)).join(', ');
  },

  modelsText() {
    return Usage.currentModels.size === 0
      ? 'All models'
      : Array.from(Usage.currentModels).map(m => Usage.fmtModel(m)).join(', ');
  },

  periodText() {
    const preset = document.getElementById('filter-date-preset');
    const name = preset && preset.selectedOptions[0] ? preset.selectedOptions[0].textContent : '';
    const df = Usage._df;
    const from = df.fromDate ? df.fromDate + (df.fromTime ? ' ' + df.fromTime : '') : '';
    const to = df.toDate ? df.toDate + (df.toTime ? ' ' + df.toTime : '') : '';
    const range = from || to ? (from || 'beginning') + ' → ' + (to || 'now') : '';
    return range ? name + ' (' + range + ')' : name;
  },

  /** Marks the analysis will include: those shown for the current projects, dated inside the period. */
  marksCount() {
    const df = Usage._df;
    return UsageMarks.marks.filter(m => (!df.fromDate || m.date >= df.fromDate) && (!df.toDate || m.date <= df.toDate)).length;
  },

  criteriaHtml() {
    const rows = [
      ['Projects', UsageInsights.projectsText()],
      ['Models', UsageInsights.modelsText()],
      ['Period', UsageInsights.periodText()],
      ['Marks', String(UsageInsights.marksCount())]
    ];
    return '<dl class="usage-insights-criteria-list">' +
      rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') +
      '</dl>';
  },

  scopeText() {
    return UsageInsights.projectsText() + ' · ' + UsageInsights.modelsText() + ' · ' + UsageInsights.periodText();
  },

  label(list, value) {
    const o = list.find(x => x.value === value);
    return o ? o.label : value;
  },

  async run(model, effort) {
    const el = document.getElementById('usage-insights-body');
    if (!el || UsageInsights.running) return;
    UsageInsights.running = true;
    const meta = `Scope: <strong>${escapeHtml(UsageInsights.scopeText())}</strong> · Model: <strong>${escapeHtml(UsageInsights.label(UsageInsights.MODELS, model))}</strong> · Effort: <strong>${escapeHtml(UsageInsights.label(UsageInsights.EFFORTS, effort))}</strong>`;
    el.innerHTML = `<div class="info-note">${meta}</div>`;
    showLoading(el.appendChild(document.createElement('div')), 'Analyzing with your local claude...');
    const q = Usage.buildQuery();
    try {
      const data = await api('/api/usage/insights?_=1' + q, { method: 'POST', body: { model, effort } });
      const target = document.getElementById('usage-insights-body');
      if (!target) return;
      target.innerHTML = `<div class="info-note">${meta} · generated ${escapeHtml(new Date(data.generatedAt).toLocaleString())}</div>
        <div class="markdown-body usage-insights-report">${renderMarkdown(data.report)}</div>`;
    } catch (e) {
      const target = document.getElementById('usage-insights-body');
      if (target) target.innerHTML = `<div class="info-note">${meta}</div><div class="empty-state"><p>${escapeHtml(e.message)}</p></div>`;
      toast('Insights failed: ' + e.message, 'error');
    } finally {
      UsageInsights.running = false;
    }
  }
};

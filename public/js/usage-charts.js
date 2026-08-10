// --- Token Usage Charts (Chart.js) ---
// Renders three charts that mirror the existing tables:
//   1. Cost & tokens over time   (stacked bars + cost line, by period)
//   2. Cost by model             (doughnut)
//   3. Top projects by cost      (horizontal bar)
// All three react to the same filters as the table view via Usage.refresh().

const UsageCharts = {
  charts: { period: null, models: null, projects: null },
  lastData: null,

  cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  },

  hexToRgba(color, alpha) {
    if (!color) return `rgba(88, 166, 255, ${alpha})`;
    const c = color.trim();
    if (c.startsWith('rgb')) {
      return c.replace(/rgba?\(([^)]+)\)/, (_, inner) => {
        const parts = inner.split(',').map(p => p.trim()).slice(0, 3);
        return `rgba(${parts.join(', ')}, ${alpha})`;
      });
    }
    let hex = c.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  },

  palette() {
    return {
      input: this.cssVar('--token-input') || '#58a6ff',
      output: this.cssVar('--token-output') || '#f0883e',
      cacheWrite: this.cssVar('--token-cache-write') || '#bc8cff',
      cacheRead: this.cssVar('--token-cache-read') || '#3fb950',
      cost: this.cssVar('--token-cost') || '#f85149',
      accent: this.cssVar('--accent') || '#58a6ff',
      text: this.cssVar('--text-primary') || '#e6edf3',
      muted: this.cssVar('--text-muted') || '#6e7681',
      border: this.cssVar('--border') || '#30363d',
      bg: this.cssVar('--bg-secondary') || '#161b22',
    };
  },

  modelColor(idx, p) {
    const ring = [p.input, p.cacheWrite, p.output, p.cacheRead, p.accent, p.cost,
      '#7ee787', '#d2a8ff', '#ffa657', '#79c0ff', '#ff7b72', '#a5d6ff'];
    return ring[idx % ring.length];
  },

  fmtCost(n) {
    if (!n) return '$0.00';
    if (n >= 1000) return '$' + n.toFixed(0);
    return '$' + n.toFixed(2);
  },

  fmtTokensShort(n) {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  },

  destroyAll() {
    for (const k of Object.keys(this.charts)) {
      if (this.charts[k]) { this.charts[k].destroy(); this.charts[k] = null; }
    }
  },

  setEmpty(idSuffix, isEmpty) {
    const wrap = document.querySelector(`#chart-${idSuffix}`).closest('.chart-canvas-wrap');
    const empty = document.getElementById(`chart-${idSuffix}-empty`);
    if (wrap) wrap.style.display = isEmpty ? 'none' : '';
    if (empty) empty.hidden = !isEmpty;
  },

  render(summary, periods, projects) {
    if (typeof Chart === 'undefined') return;
    this.lastData = { summary, periods, projects };

    const p = this.palette();

    Chart.defaults.color = p.muted;
    Chart.defaults.borderColor = p.border;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

    this.renderPeriod(periods, p);
    this.renderModels(summary, p);
    this.renderProjects(projects, p, summary);
  },

  modelColorMap(summary, p) {
    const byModel = summary && summary.byModel ? summary.byModel : {};
    const pricing = summary && summary.modelPricing ? summary.modelPricing : {};
    const models = Object.entries(byModel).map(([model, t]) => {
      const r = matchPricing(model, pricing) || {};
      const cost = (t.input_tokens || 0) * (r.input || 0) / 1e6
        + (t.output_tokens || 0) * (r.output || 0) / 1e6
        + (t.cache_creation_input_tokens || 0) * (r.cache_write || 0) / 1e6
        + (t.cache_read_input_tokens || 0) * (r.cache_read || 0) / 1e6;
      return { model, cost };
    }).sort((a, b) => b.cost - a.cost);
    const map = {};
    models.forEach((m, i) => { map[m.model] = this.modelColor(i, p); });
    return map;
  },

  renderPeriod(periods, p) {
    const canvas = document.getElementById('chart-period');
    if (!canvas) return;
    if (this.charts.period) { this.charts.period.destroy(); this.charts.period = null; }

    if (!periods || !periods.length) { this.setEmpty('period', true); return; }
    this.setEmpty('period', false);

    // API returns descending; reverse for natural left-to-right time progression.
    const ordered = [...periods].reverse();
    const labels = ordered.map(x => x.label);

    const tooltipBg = this.hexToRgba(p.bg, 0.96);

    const stacks = [
      { key: 'input_tokens',                label: 'Input',       color: p.input },
      { key: 'cache_read_input_tokens',     label: 'Cache Hits',  color: p.cacheRead },
      { key: 'cache_creation_input_tokens', label: 'Cache Write', color: p.cacheWrite },
      { key: 'output_tokens',               label: 'Output',      color: p.output },
    ];

    const tokenDatasets = stacks.map(s => ({
      type: 'bar',
      label: s.label,
      yAxisID: 'y',
      data: ordered.map(o => o[s.key] || 0),
      backgroundColor: this.hexToRgba(s.color, 0.85),
      hoverBackgroundColor: s.color,
      borderColor: 'transparent',
      borderWidth: 0,
      borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
      borderSkipped: false,
      stack: 'tokens',
      maxBarThickness: 56,
    }));

    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 320);
    grad.addColorStop(0, this.hexToRgba(p.cost, 0.35));
    grad.addColorStop(1, this.hexToRgba(p.cost, 0));

    const costDataset = {
      type: 'line',
      label: 'Cost',
      yAxisID: 'y2',
      data: ordered.map(o => o.cost || 0),
      borderColor: p.cost,
      backgroundColor: grad,
      pointBackgroundColor: p.cost,
      pointBorderColor: p.bg,
      pointBorderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 2.5,
      tension: 0.35,
      fill: true,
      cubicInterpolationMode: 'monotone',
      order: 0,
    };

    this.charts.period = new Chart(canvas, {
      data: { labels, datasets: [...tokenDatasets, costDataset] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 10, padding: 14, usePointStyle: true, color: p.muted },
          },
          tooltip: {
            backgroundColor: tooltipBg,
            titleColor: p.text,
            bodyColor: p.text,
            borderColor: p.border,
            borderWidth: 1,
            padding: 10,
            usePointStyle: true,
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                if (ctx.dataset.yAxisID === 'y2') return `Cost: ${UsageCharts.fmtCost(v)}`;
                return `${ctx.dataset.label}: ${UsageCharts.fmtTokensShort(v)}`;
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false, drawBorder: false },
            ticks: { color: p.muted, maxRotation: 0, autoSkipPadding: 16 },
          },
          y: {
            stacked: true,
            position: 'left',
            grid: { color: this.hexToRgba(p.border, 0.6), drawBorder: false },
            ticks: { color: p.muted, callback: (v) => UsageCharts.fmtTokensShort(v) },
            title: { display: true, text: 'Tokens', color: p.muted, font: { size: 11 } },
          },
          y2: {
            position: 'right',
            grid: { display: false, drawBorder: false },
            ticks: { color: p.cost, callback: (v) => UsageCharts.fmtCost(v) },
            title: { display: true, text: 'Cost', color: p.cost, font: { size: 11 } },
          },
        },
        animation: { duration: 600, easing: 'easeOutQuart' },
      },
    });
  },

  renderModels(summary, p) {
    const canvas = document.getElementById('chart-models');
    const totalEl = document.getElementById('chart-models-total');
    if (!canvas) return;
    if (this.charts.models) { this.charts.models.destroy(); this.charts.models = null; }

    const byModel = summary && summary.byModel ? summary.byModel : {};
    const pricing = summary && summary.modelPricing ? summary.modelPricing : {};

    const rows = Object.entries(byModel).map(([model, t]) => {
      const r = matchPricing(model, pricing) || {};
      const cost = (t.input_tokens || 0) * (r.input || 0) / 1e6
        + (t.output_tokens || 0) * (r.output || 0) / 1e6
        + (t.cache_creation_input_tokens || 0) * (r.cache_write || 0) / 1e6
        + (t.cache_read_input_tokens || 0) * (r.cache_read || 0) / 1e6;
      return { model, cost };
    }).filter(r => r.cost > 0).sort((a, b) => b.cost - a.cost);

    if (!rows.length) {
      if (totalEl) totalEl.textContent = '';
      this.setEmpty('models', true);
      return;
    }
    this.setEmpty('models', false);

    const total = rows.reduce((s, r) => s + r.cost, 0);
    if (totalEl) totalEl.textContent = 'Total ' + this.fmtCost(total);

    const labels = rows.map(r => shortModel(r.model) || r.model);
    const data = rows.map(r => r.cost);
    const colors = rows.map((_, i) => this.modelColor(i, p));

    const tooltipBg = this.hexToRgba(p.bg, 0.96);

    this.charts.models = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors.map(c => this.hexToRgba(c, 0.9)),
          hoverBackgroundColor: colors,
          borderColor: p.bg,
          borderWidth: 2,
          hoverBorderColor: p.bg,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, color: p.muted },
          },
          tooltip: {
            backgroundColor: tooltipBg,
            titleColor: p.text,
            bodyColor: p.text,
            borderColor: p.border,
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed;
                const pct = total ? ((v / total) * 100).toFixed(1) : '0.0';
                return `${ctx.label}: ${UsageCharts.fmtCost(v)} (${pct}%)`;
              },
            },
          },
        },
        animation: { animateRotate: true, duration: 700, easing: 'easeOutQuart' },
      },
    });
  },

  renderProjects(projects, p, summary) {
    const canvas = document.getElementById('chart-projects');
    const subEl = document.getElementById('chart-projects-sub');
    if (!canvas) return;
    if (this.charts.projects) { this.charts.projects.destroy(); this.charts.projects = null; }

    const list = (projects || []).filter(x => x.cost > 0).slice(0, 10);
    if (!list.length) {
      if (subEl) subEl.textContent = '';
      this.setEmpty('projects', true);
      return;
    }
    this.setEmpty('projects', false);

    const total = (projects || []).reduce((s, r) => s + (r.cost || 0), 0);
    if (subEl) subEl.textContent = `Top ${list.length} of ${(projects || []).length} • ${this.fmtCost(total)} total`;

    const labels = list.map(x => Usage.basename(x.name));
    const pricing = summary && summary.modelPricing ? summary.modelPricing : {};
    const colorMap = this.modelColorMap(summary, p);

    const models = new Set();
    list.forEach(proj => Object.keys(proj.byModel || {}).forEach(m => models.add(m)));
    const modelList = Array.from(models).sort((a, b) => {
      const order = Object.keys(colorMap);
      return order.indexOf(a) - order.indexOf(b);
    });

    const costForModel = (proj, model) => {
      const t = (proj.byModel || {})[model];
      if (!t) return 0;
      const r = matchPricing(model, pricing) || {};
      return (t.input_tokens || 0) * (r.input || 0) / 1e6
        + (t.output_tokens || 0) * (r.output || 0) / 1e6
        + (t.cache_creation_input_tokens || 0) * (r.cache_write || 0) / 1e6
        + (t.cache_read_input_tokens || 0) * (r.cache_read || 0) / 1e6;
    };

    const lastNonZeroModelIndex = list.map(proj => {
      let last = -1;
      modelList.forEach((m, i) => { if (costForModel(proj, m) > 0) last = i; });
      return last;
    });

    const roundedCap = { topLeft: 0, bottomLeft: 0, topRight: 6, bottomRight: 6 };
    const square = { topLeft: 0, bottomLeft: 0, topRight: 0, bottomRight: 0 };

    const datasets = modelList.map((model, mi) => {
      const color = colorMap[model] || p.accent;
      return {
        label: shortModel(model) || model,
        data: list.map(proj => costForModel(proj, model)),
        backgroundColor: this.hexToRgba(color, 0.85),
        hoverBackgroundColor: color,
        borderColor: 'transparent',
        borderRadius: (ctx) => lastNonZeroModelIndex[ctx.dataIndex] === mi ? roundedCap : square,
        borderSkipped: false,
        stack: 'projects',
        maxBarThickness: 22,
      };
    });

    const tooltipBg = this.hexToRgba(p.bg, 0.96);

    this.charts.projects = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 10, padding: 12, usePointStyle: true, color: p.muted },
          },
          tooltip: {
            backgroundColor: tooltipBg,
            titleColor: p.text,
            bodyColor: p.text,
            borderColor: p.border,
            borderWidth: 1,
            padding: 10,
            callbacks: {
              title: (items) => {
                const item = list[items[0].dataIndex];
                return item ? item.name : '';
              },
              label: (ctx) => `${ctx.dataset.label}: ${UsageCharts.fmtCost(ctx.parsed.x)}`,
              footer: (items) => {
                const item = list[items[0].dataIndex];
                if (!item) return '';
                return [
                  `Total: ${UsageCharts.fmtCost(item.cost)}`,
                  `Sessions: ${item.sessionCount}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { color: UsageCharts.hexToRgba(p.border, 0.6), drawBorder: false },
            ticks: { color: p.muted, callback: (v) => UsageCharts.fmtCost(v) },
          },
          y: {
            stacked: true,
            grid: { display: false, drawBorder: false },
            ticks: { color: p.text, autoSkip: false },
          },
        },
        animation: { duration: 600, easing: 'easeOutQuart' },
      },
    });
  },

  // Re-render with last data on theme change.
  rerenderForTheme() {
    if (!this.lastData) return;
    const { summary, periods, projects } = this.lastData;
    this.render(summary, periods, projects);
  },

  observeTheme() {
    if (this._themeBound) return;
    this._themeBound = true;
    const obs = new MutationObserver(() => this.rerenderForTheme());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  },
};

if (typeof window !== 'undefined') {
  window.UsageCharts = UsageCharts;
  document.addEventListener('DOMContentLoaded', () => UsageCharts.observeTheme());
}

// --- Usage Marks ---
// Dated notes ("added a code optimization skill") drawn as vertical lines on the
// "Cost & Tokens over Time" chart, with average daily usage before vs after each mark.

const UsageMarks = {
  marks: [],

  suggestions: [],

  /** Changes worth marking (CLAUDE.md edits, skills, plugins, model switches) in the current filters. */
  async fetchSuggestions() {
    const data = await api('/api/usage/mark-suggestions?_=1' + Usage.buildQuery());
    UsageMarks.suggestions = data.suggestions || [];
    return UsageMarks.suggestions;
  },

  renderSuggestButtons() {
    const n = UsageMarks.suggestions.length;
    document.querySelectorAll('.usage-suggest-btn').forEach(btn => {
      btn.hidden = n === 0;
      btn.textContent = '\u{1F4A1} ' + n + ' suggested';
    });
  },

  openSuggestions() {
    const rows = UsageMarks.suggestions.map((s, i) => `
      <div class="mark-suggestion-row">
        <div class="mark-suggestion-meta">
          <div><strong>${escapeHtml(s.date)}</strong> <span class="${s.project ? 'mark-tip-scope' : 'mark-tip-scope mark-tip-global'}">${escapeHtml(UsageMarks.scopeName(s))}</span> ${escapeHtml(s.title)}</div>
          <div class="mark-suggestion-desc">${escapeHtml(s.description || '')}</div>
        </div>
        <div class="mark-suggestion-actions">
          <button class="btn btn-sm btn-primary" onclick="UsageMarks.addFromSuggestion(${i})">Add mark</button>
          <button class="btn btn-sm" onclick="UsageMarks.dismissSuggestion(${i}, this)">Dismiss</button>
        </div>
      </div>`).join('');
    openModal({
      title: 'Suggested Marks',
      width: 680,
      cls: 'usage-insights-modal',
      cancelLabel: 'Close',
      body: `<div class="info-note">Changes found in your Claude Code setup and usage for the current filters. Add one as a mark to compare usage before and after it.</div>
        <div class="mark-suggestion-list">${rows || '<div class="empty-state"><p>No suggestions.</p></div>'}</div>`
    });
  },

  addFromSuggestion(i) {
    const s = UsageMarks.suggestions[i];
    if (!s) return;
    document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
    UsageMarks.openEditor(null, { date: s.date, title: s.title, description: s.description, project: s.project });
  },

  async dismissSuggestion(i, btn) {
    const s = UsageMarks.suggestions[i];
    if (!s) return;
    try {
      await api('/api/usage/mark-suggestions/dismiss', { method: 'POST', body: { key: s.key } });
      const row = btn.closest('.mark-suggestion-row');
      if (row) row.remove();
      UsageMarks.suggestions = UsageMarks.suggestions.map(x => x === s ? null : x).filter(Boolean);
      UsageMarks.renderSuggestButtons();
    } catch (e) {
      toast('Could not dismiss: ' + e.message, 'error');
    }
  },

  async fetch() {
    const data = await api('/api/usage/marks?_=1' + Usage.buildQuery());
    UsageMarks.marks = data.marks || [];
    return UsageMarks.marks;
  },

  async reload() {
    try {
      await Promise.all([UsageMarks.fetch(), UsageMarks.fetchSuggestions()]);
      UsageMarks.render();
      UsageMarks.renderSuggestButtons();
      if (typeof UsageCharts !== 'undefined' && UsageCharts.lastData && Usage.viewMode === 'charts') {
        UsageCharts.renderPeriod(UsageCharts.lastData.periods, UsageCharts.palette());
      }
    } catch (e) {
      toast('Could not load marks: ' + e.message, 'error');
    }
  },

  isoWeek(day) {
    const d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
  },

  /** The period key a mark's date falls into, in the same format as the chart's labels. */
  periodKey(date, group) {
    if (group === 'hour') return date + ' 00:00';
    if (group === 'week') return UsageMarks.isoWeek(date);
    if (group === 'month') return date.slice(0, 7);
    if (group === 'year') return date.slice(0, 4);
    return date;
  },

  /**
   * Index of the chart label a mark belongs to: the first period on or after the mark's
   * period (a mark on a day without usage lands on the next active period). -1 when the
   * mark is outside the charted range. `labels` must be ascending.
   */
  labelIndex(date, group, labels) {
    if (!labels.length) return -1;
    const key = UsageMarks.periodKey(date, group);
    const sameFirstDay = group === 'hour' && labels[0].startsWith(date);
    if (key < labels[0] && !sameFirstDay) return -1;
    return labels.findIndex(l => l >= key);
  },

  /** Marks grouped by chart label index: { idx: [mark, ...] }. */
  byLabelIndex(group, labels) {
    const out = {};
    for (const m of UsageMarks.marks) {
      const idx = UsageMarks.labelIndex(m.date, group, labels);
      if (idx < 0) continue;
      (out[idx] = out[idx] || []).push(m);
    }
    return out;
  },

  /** "Global", or the project folder name for a project mark. */
  scopeName(m) {
    if (!m.project) return 'Global';
    const full = m.projectName || m.project;
    const match = String(full).match(/[^\\\/]+$/);
    return match ? match[0] : full;
  },

  /** Always-visible label on the chart: flag, scope, title — cut to keep the flag compact. */
  flagText(m) {
    const text = '\u2691 ' + UsageMarks.scopeName(m) + ' \u00b7 ' + m.title;
    return text.length > 40 ? text.slice(0, 39) + '\u2026' : text;
  },

  MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],

  /** "2026-10-03" -> "Oct 3". */
  fmtDay(day) {
    return UsageMarks.MONTHS[Number(day.slice(5, 7)) - 1] + ' ' + Number(day.slice(8, 10));
  },

  /** "Oct 3 \u2013 Oct 9", with "(so far)" while the window is still running. */
  fmtRange(w) {
    return UsageMarks.fmtDay(w.from) + ' \u2013 ' + UsageMarks.fmtDay(w.to) + (w.partial ? ' (so far)' : '');
  },

  /**
   * The before/after comparison as a grid with Before / After / Change columns. Efficiency rows
   * come first and are colored (green = better); volume rows follow uncolored, since they mostly
   * reflect how much you worked rather than how efficiently.
   */
  impactHtml(i) {
    const b = i.before;
    const a = i.after;
    const dash = '—';
    const cost = v => v == null ? dash : Usage.fmtCost(v);
    const pct = v => v == null ? dash : v.toFixed(0) + '%';
    const tok = v => v == null ? dash : fmtTokens(Math.round(v));
    const row = (label, before, after, change) =>
      `<span class="mark-impact-label">${label}</span><span>${before}</span><span>${after}</span><span>${change}</span>`;
    return `<div class="mark-impact">
        <div class="mark-impact-title">${i.window} days before vs ${i.window} days from the mark</div>
        <div class="mark-impact-grid">
          ${row('', 'Before', 'After', 'Change').replace(/<span>/g, '<span class="mark-impact-head">')}
          ${row('Days', escapeHtml(UsageMarks.fmtRange(b)), escapeHtml(UsageMarks.fmtRange(a)), '')}
          <span class="mark-impact-section">Efficiency</span>
          ${row('Cost / session', cost(b.costPerSession), cost(a.costPerSession), UsageMarks.fmtPct(i.costPerSessionChangePct))}
          ${row('Cache hit', pct(b.cacheHitPct), pct(a.cacheHitPct), UsageMarks.fmtPts(i.cacheHitChangePts))}
          ${row('Tokens / request', tok(b.tokensPerRequest), tok(a.tokensPerRequest), UsageMarks.fmtPct(i.tokensPerRequestChangePct))}
          <span class="mark-impact-section">Volume per active day (depends on how much you worked)</span>
          ${row('Tokens / day', tok(b.avgTokensPerDay), tok(a.avgTokensPerDay), UsageMarks.fmtPct(i.tokensChangePct, 'neutral'))}
          ${row('Cost / day', cost(b.avgCostPerDay), cost(a.avgCostPerDay), UsageMarks.fmtPct(i.costChangePct, 'neutral'))}
        </div>
      </div>`;
  },

  /** Chart tooltip block for the marks on a hovered period: date, scope badge and title, the description, then the comparison. */
  tooltipHtml(marks) {
    return marks.map(m => {
      const desc = m.description ? `<div class="mark-tip-desc">${escapeHtml(m.description)}</div>` : '';
      const impact = m.impact ? UsageMarks.impactHtml(m.impact) : '';
      const scopeCls = m.project ? 'mark-tip-scope' : 'mark-tip-scope mark-tip-global';
      return `<div class="mark-tip">
          <div class="mark-tip-head">\u2691 ${escapeHtml(m.date)} <span class="${scopeCls}">${escapeHtml(UsageMarks.scopeName(m))}</span> ${escapeHtml(m.title)}</div>
          ${desc}${impact}
        </div>`;
    }).join('');
  },

  /** Change in %; lower is better (green) unless mode is 'neutral' (no color). */
  fmtPct(pct, mode) {
    if (pct === null || pct === undefined) return '<span class="mark-delta">n/a</span>';
    const cls = mode === 'neutral' ? '' : pct < 0 ? 'mark-delta-good' : pct > 0 ? 'mark-delta-bad' : '';
    const sign = pct > 0 ? '+' : '';
    return `<span class="mark-delta ${cls}">${sign}${pct.toFixed(0)}%</span>`;
  },

  /** Change in percentage points, where higher is better (cache hit). */
  fmtPts(pts) {
    if (pts === null || pts === undefined) return '<span class="mark-delta">n/a</span>';
    const rounded = Math.round(pts);
    const cls = rounded > 0 ? 'mark-delta-good' : rounded < 0 ? 'mark-delta-bad' : '';
    const sign = rounded > 0 ? '+' : '';
    return `<span class="mark-delta ${cls}">${sign}${rounded} pts</span>`;
  },

  render() {
    const el = document.getElementById('usage-marks-list');
    if (!el) return;
    if (!UsageMarks.marks.length) {
      el.innerHTML = '<div class="empty-state"><p>No marks in the selected period. Add one to see how a change affected your usage.</p></div>';
      return;
    }
    const cols = [
      { label: 'Date' },
      { label: 'Mark' },
      { label: 'Scope' },
      { label: 'Usage before vs after' },
      { label: '' }
    ];
    const rows = [...UsageMarks.marks].reverse().map(m => {
      const scope = m.project
        ? `<span title="${escapeHtml(m.projectName || m.project)}">${escapeHtml(Usage.basename(m.projectName || m.project))}</span>`
        : '<span class="mark-scope-global">Global</span>';
      const desc = m.description ? `<div class="mark-desc">${escapeHtml(m.description)}</div>` : '';
      return [
        escapeHtml(m.date),
        `<strong>${escapeHtml(m.title)}</strong>${desc}`,
        scope,
        UsageMarks.impactHtml(m.impact),
        `<div class="action-menu">
          <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="More actions">&#8942;</button>
          <div class="action-menu-panel">
            <button class="action-menu-item" onclick="event.stopPropagation(); UsageMarks.openEditor('${escapeHtml(m.id)}')">Edit</button>
            <button class="action-menu-item" onclick="event.stopPropagation(); UsageMarks.confirmDelete('${escapeHtml(m.id)}')">Delete</button>
          </div>
        </div>`
      ];
    });
    el.innerHTML = buildTable(cols, rows);
  },

  /** Opens the Add/Edit Mark dialog: edits mark `id`, or adds a new one (optionally prefilled from a suggestion). */
  openEditor(id, prefill) {
    const mark = id ? UsageMarks.marks.find(m => m.id === id) : null;
    const init = mark || prefill || null;
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const selected = init ? init.project : (Usage.currentProjects.size === 1 ? Array.from(Usage.currentProjects.keys())[0] : '');
    const projectOptions = ['<option value="">Global (all projects)</option>']
      .concat(Usage.allProjects
        .map(p => ({ slug: p.slug, base: Usage.basename(p.name), name: p.name }))
        .sort((a, b) => a.base.localeCompare(b.base))
        .map(p => `<option value="${escapeHtml(p.slug)}" title="${escapeHtml(p.name)}"${p.slug === selected ? ' selected' : ''}>${escapeHtml(p.base)}</option>`))
      .join('');
    const body =
      formRow(
        formGroup('Date', `<input type="date" id="mark-date" value="${escapeHtml(init ? init.date : todayStr)}">`),
        formGroup('Scope', `<select id="mark-project">${projectOptions}</select>`)
      ) +
      formGroup('Title', `<input type="text" id="mark-title" maxlength="80" placeholder="e.g. Added code optimization skill" value="${escapeHtml(init ? init.title : '')}">`) +
      formGroup('Description', `<textarea id="mark-description" rows="3" placeholder="What changed?">${escapeHtml(init ? init.description || '' : '')}</textarea>`) +
      formGroup('Compare', `<select id="mark-window" onchange="UsageMarks.updateWindowHint()">${[7, 14, 30].map(d =>
        `<option value="${d}"${d === (mark && mark.window || 7) ? ' selected' : ''}>${d} days</option>`).join('')}</select>
        <div class="mark-window-hint" id="mark-window-hint"></div>`);

    const deleteButton = mark
      ? [{ label: 'Delete', danger: true, onClick: () => { UsageMarks.confirmDelete(mark.id); } }]
      : [];
    openModal({
      title: mark ? 'Edit Mark' : 'Add Mark',
      body,
      buttons: deleteButton.concat([{
        label: mark ? 'Save' : 'Add',
        primary: true,
        onClick: async () => {
          const payload = {
            date: document.getElementById('mark-date').value,
            title: document.getElementById('mark-title').value,
            description: document.getElementById('mark-description').value,
            project: document.getElementById('mark-project').value || null,
            window: Number(document.getElementById('mark-window').value)
          };
          try {
            await api(mark ? '/api/usage/marks/' + encodeURIComponent(mark.id) : '/api/usage/marks', {
              method: mark ? 'PUT' : 'POST',
              body: payload
            });
            toast(mark ? 'Mark updated' : 'Mark added');
            UsageMarks.reload();
          } catch (e) {
            toast('Could not save mark: ' + e.message, 'error');
            return false;
          }
        }
      }])
    });
    document.getElementById('mark-date').addEventListener('change', UsageMarks.updateWindowHint);
    UsageMarks.updateWindowHint();
    setTimeout(() => { const t = document.getElementById('mark-title'); if (t) t.focus(); }, 0);
  },

  /** Spells out in the dialog which days the chosen window will compare. */
  updateWindowHint() {
    const hint = document.getElementById('mark-window-hint');
    const date = document.getElementById('mark-date').value;
    const days = Number(document.getElementById('mark-window').value);
    if (!hint) return;
    if (!date) { hint.textContent = ''; return; }
    hint.textContent = UsageMarks.windowHint(date, days);
  },

  /** "Average usage per day on Oct 3 – Oct 9 (7 days before) vs Oct 10 – Oct 16 (7 days from this date)." */
  windowHint(date, days) {
    const shift = (d, n) => {
      const x = new Date(d + 'T00:00:00Z');
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
    const before = { from: shift(date, -days), to: shift(date, -1) };
    const after = { from: date, to: shift(date, days - 1) };
    return 'Average usage per day on ' + UsageMarks.fmtRange(before) + ' (' + days + ' days before) vs ' +
      UsageMarks.fmtRange(after) + ' (' + days + ' days from this date).';
  },

  confirmDelete(id) {
    const mark = UsageMarks.marks.find(m => m.id === id);
    if (!mark) return;
    openModal({
      title: 'Delete Mark',
      body: `<p>Delete mark <strong>${escapeHtml(mark.title)}</strong> (${escapeHtml(mark.date)})?</p>`,
      buttons: [{
        label: 'Delete',
        danger: true,
        onClick: async () => {
          try {
            await api('/api/usage/marks/' + encodeURIComponent(id), { method: 'DELETE' });
            toast('Mark deleted');
            UsageMarks.reload();
          } catch (e) {
            toast('Could not delete mark: ' + e.message, 'error');
            return false;
          }
        }
      }]
    });
  }
};

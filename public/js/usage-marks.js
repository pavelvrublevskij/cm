// --- Usage Marks ---
// Dated notes ("added a code optimization skill") drawn as vertical lines on the
// "Cost & Tokens over Time" chart, with average daily usage before vs after each mark.

const UsageMarks = {
  marks: [],

  async fetch() {
    const data = await api('/api/usage/marks?_=1' + Usage.buildQuery());
    UsageMarks.marks = data.marks || [];
    return UsageMarks.marks;
  },

  async reload() {
    try {
      await UsageMarks.fetch();
      UsageMarks.render();
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
   * The before/after comparison as a small grid: which days were compared, average tokens and
   * cost per day in each, and the change (green when usage dropped, red when it rose).
   */
  impactHtml(i) {
    return `<div class="mark-impact">
        <div class="mark-impact-title">Avg per day, ${i.window} days before vs after (days with usage only)</div>
        <div class="mark-impact-grid">
          <span>Before</span><span>${escapeHtml(UsageMarks.fmtRange(i.before))}</span><span>${fmtTokens(Math.round(i.before.avgTokensPerDay))}</span><span>${Usage.fmtCost(i.before.avgCostPerDay)}</span>
          <span>After</span><span>${escapeHtml(UsageMarks.fmtRange(i.after))}</span><span>${fmtTokens(Math.round(i.after.avgTokensPerDay))}</span><span>${Usage.fmtCost(i.after.avgCostPerDay)}</span>
          <span>Change</span><span></span><span>${UsageMarks.fmtPct(i.tokensChangePct)}</span><span>${UsageMarks.fmtPct(i.costChangePct)}</span>
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

  fmtPct(pct) {
    if (pct === null || pct === undefined) return '<span class="mark-delta">n/a</span>';
    const cls = pct < 0 ? 'mark-delta-good' : pct > 0 ? 'mark-delta-bad' : '';
    const sign = pct > 0 ? '+' : '';
    return `<span class="mark-delta ${cls}">${sign}${pct.toFixed(0)}%</span>`;
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

  openEditor(id) {
    const mark = id ? UsageMarks.marks.find(m => m.id === id) : null;
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const selected = mark ? mark.project : (Usage.currentProjects.size === 1 ? Array.from(Usage.currentProjects.keys())[0] : '');
    const projectOptions = ['<option value="">Global (all projects)</option>']
      .concat(Usage.allProjects
        .map(p => ({ slug: p.slug, base: Usage.basename(p.name), name: p.name }))
        .sort((a, b) => a.base.localeCompare(b.base))
        .map(p => `<option value="${escapeHtml(p.slug)}" title="${escapeHtml(p.name)}"${p.slug === selected ? ' selected' : ''}>${escapeHtml(p.base)}</option>`))
      .join('');
    const body =
      formRow(
        formGroup('Date', `<input type="date" id="mark-date" value="${escapeHtml(mark ? mark.date : todayStr)}">`),
        formGroup('Scope', `<select id="mark-project">${projectOptions}</select>`)
      ) +
      formGroup('Title', `<input type="text" id="mark-title" maxlength="80" placeholder="e.g. Added code optimization skill" value="${escapeHtml(mark ? mark.title : '')}">`) +
      formGroup('Description', `<textarea id="mark-description" rows="3" placeholder="What changed?">${escapeHtml(mark ? mark.description : '')}</textarea>`) +
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

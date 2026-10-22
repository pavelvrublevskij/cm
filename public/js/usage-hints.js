// --- Usage Hints ---
// Free, rule-based efficiency checks for the filtered usage (no AI): low cache hit, heavy Opus
// share, expensive or very long sessions. Click a chip to read what it means and what to do.

const UsageHints = {
  hints: [],
  openId: null,

  async fetch() {
    const data = await api('/api/usage/hints?_=1' + Usage.buildQuery());
    UsageHints.hints = data.hints || [];
    return UsageHints.hints;
  },

  render() {
    const el = document.getElementById('usage-hints');
    if (!el) return;
    if (!UsageHints.hints.some(h => h.id === UsageHints.openId)) UsageHints.openId = null;
    el.innerHTML = UsageHints.html(UsageHints.hints, UsageHints.openId);
  },

  /** Chips plus the detail of the open one. Pure, so it is testable without a DOM. */
  html(hints, openId) {
    const label = '<span class="usage-hints-label">Quick checks</span>';
    if (!hints.length) {
      return label + '<span class="usage-hint usage-hint-ok">✓ No efficiency warnings for this selection</span>';
    }
    const chips = hints.map(h => {
      const icon = h.level === 'warn' ? '⚠' : 'ℹ';
      const open = h.id === openId ? ' usage-hint-open' : '';
      return `<button type="button" class="btn btn-sm usage-hint usage-hint-${escapeHtml(h.level)}${open}" onclick="UsageHints.toggle('${escapeHtml(h.id)}')">${icon} ${escapeHtml(h.title)}</button>`;
    }).join('');
    const open = hints.find(h => h.id === openId);
    const detail = open ? `<div class="usage-hint-detail">${escapeHtml(open.detail)}</div>` : '';
    return label + chips + detail;
  },

  toggle(id) {
    UsageHints.openId = UsageHints.openId === id ? null : id;
    UsageHints.render();
  }
};

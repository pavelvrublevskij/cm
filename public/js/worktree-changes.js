// --- Worktree changes ---
// What a git worktree holds that its base branch does not, shown on Task Board cards, the session
// header and the active sessions bar.

/** Whether a worktree status ({ files, unmerged, unmergedCount }) holds anything not yet in its base. */
function worktreeHasChanges(st) {
  return !!st && !st.missing && ((st.files || []).length > 0 || st.unmergedCount > 0);
}

/**
 * What a worktree holds that its base branch does not: "3 uncommitted · 2 unmerged into <base>",
 * with the files and commits in the tooltip, or "all merged into <base>" when nothing is left.
 * With opts.slug the counts open the worktree's git panel in a new tab.
 */
function worktreeChangesHtml(st, opts = {}) {
  if (!st) return '';
  if (st.missing) return '<span class="wt-changes wt-changes--missing">worktree removed</span>';
  const files = st.files || [];
  const commits = st.unmerged || [];
  const count = st.unmergedCount || 0;
  const base = st.base ? ` into ${st.base}` : '';
  const tip = [];
  if (files.length) tip.push('Uncommitted:', ...files.slice(0, 20).map(f => `  ${f.label}: ${f.path}`), ...(files.length > 20 ? [`  … ${files.length - 20} more`] : []));
  if (count) tip.push(`Not merged${base}:`, ...commits.map(c => `  ${c.sha} ${c.subject}`), ...(count > commits.length ? [`  … ${count - commits.length} more`] : []));
  let text;
  if (!worktreeHasChanges(st)) {
    if (st.unmergedCount === null || st.unmergedCount === undefined) return '';
    text = `&#10003; all merged${escapeHtml(base)}`;
  } else {
    const parts = [];
    if (files.length) parts.push(`${files.length} uncommitted`);
    if (count) parts.push(`${count} unmerged${escapeHtml(base)}`);
    text = '&#9679; ' + parts.join(' · ');
  }
  const cls = 'wt-changes' + (worktreeHasChanges(st) ? ' wt-changes--pending' : ' wt-changes--clean');
  const click = opts.slug
    ? ` role="button" data-slug="${escapeAttr(opts.slug)}" onclick="event.stopPropagation(); window.open('/git-window.html?slug=' + encodeURIComponent(this.dataset.slug), '_blank')"`
    : '';
  const title = tip.length ? tip.join('\n') : `Everything in this worktree is in ${st.base}`;
  return `<span class="${cls}" title="${escapeAttr(title + (opts.slug ? '\n\nClick to open its git panel' : ''))}"${click}>${text}</span>`;
}

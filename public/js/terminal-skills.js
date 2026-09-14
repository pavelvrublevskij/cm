// --- TerminalSkills ---
// The Skills popover in the session terminal header. Lists what the project itself provides —
// skills (.claude/skills/) and custom slash commands (.claude/commands/) — pinning the ones clicked
// most often at the top, and types the chosen `/name ` into the running claude without a newline,
// so the user finishes the line themselves.

const TerminalSkills = {
  TOP_COUNT: 5,

  _open: false,
  _skills: [],
  _slug: null,
  _filter: '',
  _outsideHandler: null,

  isOpen() { return TerminalSkills._open; },

  toggle() {
    if (TerminalSkills._open) TerminalSkills.close();
    else TerminalSkills.open();
  },

  async open() {
    const state = (typeof TerminalPanel !== 'undefined') ? TerminalPanel.state : null;
    if (!state || !state.slug) { toast('No active session', 'error'); return; }

    const pop = document.getElementById('terminal-skills-popover');
    if (!pop) return;

    TerminalSkills._open = true;
    TerminalSkills._slug = state.slug;
    TerminalSkills._filter = '';
    pop.style.display = 'block';
    pop.innerHTML = '<div class="terminal-skills-empty">Loading skills...</div>';
    TerminalSkills._bindOutside();

    try {
      TerminalSkills._skills = await api(`/api/skills/palette/${TerminalSkills._slug}`);
    } catch (e) {
      TerminalSkills._skills = [];
      pop.innerHTML = `<div class="terminal-skills-empty">Could not load skills: ${escapeHtml(e.message)}</div>`;
      return;
    }
    TerminalSkills.render();
    const input = document.getElementById('terminal-skills-filter');
    if (input) input.focus();
  },

  close() {
    TerminalSkills._open = false;
    const pop = document.getElementById('terminal-skills-popover');
    if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; }
    if (TerminalSkills._outsideHandler) {
      document.removeEventListener('mousedown', TerminalSkills._outsideHandler, true);
      document.removeEventListener('keydown', TerminalSkills._outsideHandler, true);
      TerminalSkills._outsideHandler = null;
    }
  },

  setFilter(value) {
    TerminalSkills._filter = (value || '').trim().toLowerCase();
    TerminalSkills.renderLists();
  },

  /** Skills matching the current filter, by name or description. */
  matching() {
    const f = TerminalSkills._filter;
    if (!f) return TerminalSkills._skills.slice();
    return TerminalSkills._skills.filter(s =>
      (s.name || '').toLowerCase().includes(f) || (s.description || '').toLowerCase().includes(f));
  },

  /** Clicked-at-least-once skills, most used first, capped at TOP_COUNT. */
  mostUsed(list) {
    return list
      .filter(s => (s.usageCount || 0) > 0)
      .sort((a, b) => (b.usageCount - a.usageCount) || a.name.localeCompare(b.name))
      .slice(0, TerminalSkills.TOP_COUNT);
  },

  alphabetical(list) {
    return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  },

  render() {
    const pop = document.getElementById('terminal-skills-popover');
    if (!pop) return;
    pop.innerHTML = `
      <input type="text" class="terminal-skills-filter" id="terminal-skills-filter"
             placeholder="Filter skills and commands..." oninput="TerminalSkills.setFilter(this.value)">
      <div class="terminal-skills-body" id="terminal-skills-body"></div>`;
    TerminalSkills.renderLists();
  },

  renderLists() {
    const body = document.getElementById('terminal-skills-body');
    if (!body) return;

    if (!TerminalSkills._skills.length) {
      body.innerHTML = '<div class="terminal-skills-empty">No project skills or commands in <code>.claude/</code></div>';
      return;
    }

    const list = TerminalSkills.matching();
    if (!list.length) {
      body.innerHTML = '<div class="terminal-skills-empty">Nothing matches that filter</div>';
      return;
    }

    const top = TerminalSkills.mostUsed(list);
    const topHtml = top.length
      ? `<div class="terminal-skills-section">Most used</div>${top.map(TerminalSkills._rowHtml).join('')}`
      : '';
    body.innerHTML = topHtml
      + `<div class="terminal-skills-section">All</div>`
      + TerminalSkills.alphabetical(list).map(TerminalSkills._rowHtml).join('');
  },

  _rowHtml(item) {
    const count = item.usageCount || 0;
    const badge = count ? `<span class="terminal-skills-count">${count}&times;</span>` : '';
    const kind = item.kind === 'command'
      ? '<span class="terminal-skills-kind">command</span>'
      : '<span class="terminal-skills-kind">skill</span>';
    const desc = item.description
      ? `<span class="terminal-skills-desc">${escapeHtml(item.description)}</span>` : '';
    return `<button class="terminal-skills-item" onclick="TerminalSkills.useFrom(this)"
        data-skill="${escapeAttr(item.name)}" title="Type /${escapeAttr(item.name)} into the terminal">
        <span class="terminal-skills-name">/${escapeHtml(item.name)}</span>${kind}${badge}${desc}
      </button>`;
  },

  useFrom(btn) {
    const name = btn && btn.getAttribute('data-skill');
    if (name) TerminalSkills.use(name);
  },

  /** Type `/name ` into the session terminal — no newline, so the user can add arguments. */
  use(name) {
    const view = (typeof TerminalPanel !== 'undefined') && TerminalPanel.state && TerminalPanel.state.view;
    if (!view || !view.isConnected()) { toast('Open the terminal first', 'error'); return; }
    view.send({ t: 'i', d: '/' + name + ' ' });
    view.focus();
    TerminalSkills.close();
    TerminalSkills._countUse(name);
  },

  async _countUse(name) {
    const skill = TerminalSkills._skills.find(s => s.name === name);
    if (skill) skill.usageCount = (skill.usageCount || 0) + 1;
    try {
      await api(`/api/skills/usage/${TerminalSkills._slug}/${encodeURIComponent(name)}`, { method: 'POST' });
    } catch (_) { /* the paste already happened; a lost count is not worth a toast */ }
  },

  _bindOutside() {
    if (TerminalSkills._outsideHandler) return;
    TerminalSkills._outsideHandler = ev => {
      if (ev.type === 'keydown') {
        if (ev.key === 'Escape') TerminalSkills.close();
        return;
      }
      const pop = document.getElementById('terminal-skills-popover');
      const btn = document.getElementById('terminal-skills-btn');
      if (pop && pop.contains(ev.target)) return;
      if (btn && btn.contains(ev.target)) return;
      TerminalSkills.close();
    };
    document.addEventListener('mousedown', TerminalSkills._outsideHandler, true);
    document.addEventListener('keydown', TerminalSkills._outsideHandler, true);
  },
};

window.TerminalSkills = TerminalSkills;

// --- Task Board ---
// Kanban of tickets across projects: one swimlane per project. ToDo, Ready, Move to PR and Done are
// fixed in every lane; the project's workflow stages sit between Ready and Move to PR.

const TaskBoard = {
  HIDDEN_KEY: 'claude-manager-task-board-hidden',
  COMPACT_KEY: 'claude-manager-task-board-compact',
  COLUMN_TITLES: { todo: 'ToDo', ready: 'Ready', 'move-to-pr': 'Move to PR', done: 'Done' },
  DELETABLE: ['todo', 'done'],
  USER_MOVES: { todo: ['ready'], ready: ['todo'], 'move-to-pr': ['done'] },
  board: { cards: [], projects: {}, status: {} },
  _drag: null,
  _wf: null,

  async load() {
    const el = document.getElementById('task-board-body');
    if (!el) return;
    if (!TaskBoard.board.cards.length) showLoading(el, 'Loading board...');
    try {
      TaskBoard.board = await api('/api/task-board');
      TaskBoard.render();
    } catch (e) {
      el.innerHTML = '';
      toast('Failed to load the board: ' + e.message, 'error');
    }
  },

  render() {
    const el = document.getElementById('task-board-body');
    if (el) el.innerHTML = TaskBoard.html(TaskBoard.board, TaskBoard.hidden(), TaskBoard.compact());
    const btn = document.getElementById('task-board-compact-btn');
    if (btn) btn.classList.toggle('btn-active', TaskBoard.compact());
  },

  compact() {
    try { return localStorage.getItem(TaskBoard.COMPACT_KEY) === '1'; }
    catch (_) { return false; }
  },

  toggleCompact() {
    try { localStorage.setItem(TaskBoard.COMPACT_KEY, TaskBoard.compact() ? '0' : '1'); } catch (_) {}
    TaskBoard.render();
  },

  hidden() {
    try { return JSON.parse(localStorage.getItem(TaskBoard.HIDDEN_KEY) || '[]'); }
    catch (_) { return []; }
  },

  toggleLaneVisible(key) {
    const hidden = TaskBoard.hidden();
    const next = hidden.includes(key) ? hidden.filter(k => k !== key) : hidden.concat([key]);
    try { localStorage.setItem(TaskBoard.HIDDEN_KEY, JSON.stringify(next)); } catch (_) {}
    TaskBoard.render();
  },

  /** Project lanes by name. */
  laneKeys(board) {
    return Object.keys(board.projects || {}).sort((a, b) => decodeName(a).localeCompare(decodeName(b)));
  },

  /**
   * A lane's columns: fixed ones around its workflow stages, or a placeholder while it has none.
   * Compact mode folds the stages into one "In progress" column.
   */
  laneColumns(board, key, compact) {
    const lane = (board.projects || {})[key];
    const stages = (lane && lane.stages) || [];
    let middle;
    if (!stages.length) middle = [{ id: '', title: 'Workflow', placeholder: true }];
    else if (compact) middle = [{ id: '', title: 'In progress', inProgress: true }];
    else middle = stages.map(s => ({ id: s.id, title: s.title || s.id, stage: true }));
    const fixed = id => ({ id, title: TaskBoard.COLUMN_TITLES[id] });
    return [fixed('todo'), fixed('ready')].concat(middle, [fixed('move-to-pr'), fixed('done')]);
  },

  canMove(card, column) {
    return card.column === column || (TaskBoard.USER_MOVES[card.column] || []).includes(column);
  },

  /** Compact card: one line with the heading, and the current stage as dots (its name on hover). */
  lineCardHtml(card, heading, stages) {
    const at = stages ? stages.findIndex(s => s.id === card.column) : -1;
    const dots = at === -1 ? '' : `<span class="tb-line-steps" title="${escapeAttr(`${stages[at].title} (${at + 1}/${stages.length})`)}">${
      stages.map((s, i) => `<span class="tb-dot${i < at ? ' tb-step--done' : i === at ? ' tb-step--current' : ''}"></span>`).join('')
    }</span>`;
    return `<div class="tb-card tb-card--line${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}" title="${escapeAttr(heading)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openEditor('${escapeAttr(card.id)}')">
        <span class="tb-line-text">${escapeHtml(heading)}</span>
        ${card.closed ? '<span class="tb-badge tb-badge--closed">closed</span>' : ''}
        ${dots}
      </div>`;
  },

  /** Title, or the first line of the description when there is no title. Compact: a one-line card with stage dots. */
  cardHtml(card, stages, compact) {
    const lines = (card.notes || '').trim().split('\n');
    const heading = card.title || lines[0];
    if (compact) return TaskBoard.lineCardHtml(card, heading, stages);
    const notes = card.title ? lines[0] : lines[1];
    return `<div class="tb-card${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openEditor('${escapeAttr(card.id)}')">
        ${card.closed ? '<div class="tb-card-head"><span class="tb-badge tb-badge--closed">closed</span></div>' : ''}
        ${heading ? `<div class="tb-card-title">${escapeHtml(heading)}</div>` : ''}
        ${notes ? `<div class="tb-card-notes">${escapeHtml(notes)}</div>` : ''}
      </div>`;
  },

  laneHtml(board, key, compact) {
    const columns = TaskBoard.laneColumns(board, key, compact);
    const cards = (board.cards || []).filter(c => c.project === key);
    const lane = board.projects[key];
    const stages = lane.stages || [];
    const status = (board.status || {})[key] || {};
    const k = escapeAttr(key);
    const flags = (status.missing && status.missing.length ? '<span class="tb-flag tb-flag--error" title="A stage uses a skill or agent this project no longer has">Missing skill</span>' : '')
      + (status.skillsChanged ? '<span class="tb-flag" title="Skills or agents changed since the workflow was saved">Skills changed</span>' : '');
    const head = `<div class="tb-lane-head">
        <span class="tb-lane-name">${escapeHtml(decodeName(key))}</span>
        <span class="git-count-badge">${cards.length}</span>
        <button class="btn btn-sm tb-workflow-btn" onclick="TaskBoard.openWorkflow('${k}')">Workflow${stages.length ? ' · ' + stages.length : ''}</button>
        ${flags}
        <label class="tb-parallel" title="Run this project's tickets in parallel, each in its own git worktree">
          <input type="checkbox"${lane.parallel ? ' checked' : ''} onchange="TaskBoard.setParallel('${escapeAttr(key)}', this.checked)"> Parallel
        </label>
        ${!cards.length ? `<button class="btn btn-sm tb-lane-remove" onclick="TaskBoard.removeLane('${escapeAttr(key)}')" title="Remove lane">&times;</button>` : ''}
      </div>`;
    const cols = columns.map(col => {
      if (col.placeholder) {
        return `<div class="tb-col tb-col--placeholder"><div class="tb-col-head">${escapeHtml(col.title)}</div>
            <div class="tb-col-empty">No workflow yet</div>
            <button class="btn btn-sm tb-add" onclick="TaskBoard.openWorkflow('${k}')">Set up</button></div>`;
      }
      const list = col.inProgress
        ? cards.filter(c => stages.some(s => s.id === c.column))
        : cards.filter(c => c.column === col.id);
      const add = col.id === 'todo'
        ? `<button class="btn btn-sm tb-add" onclick="TaskBoard.openEditor(null, '${escapeAttr(key)}')">+ Ticket</button>`
        : '';
      return `<div class="tb-col${col.stage ? ' tb-col--stage' : ''}" data-lane="${escapeAttr(key)}" data-column="${escapeAttr(col.id)}"
          ondragover="TaskBoard.onDragOver(event)" ondragleave="TaskBoard.onDragLeave(event)" ondrop="TaskBoard.onDrop(event)">
          <div class="tb-col-head">${escapeHtml(col.title)} <span class="tb-col-count">${list.length}</span></div>
          <div class="tb-col-cards">${list.map(c => TaskBoard.cardHtml(c, col.inProgress ? stages : null, compact)).join('')}</div>
          ${add}
        </div>`;
    }).join('');
    return `<section class="tb-lane" data-lane="${escapeAttr(key)}">${head}<div class="tb-cols" style="--tb-cols:${columns.length}">${cols}</div></section>`;
  },

  /** The whole board: lane filter chips, then each visible lane. Pure, for tests. */
  html(board, hidden, compact) {
    const keys = TaskBoard.laneKeys(board);
    if (!keys.length) return '<div class="empty-state"><p>No tickets yet. Add a project lane or a new ticket to start.</p></div>';
    const chips = keys.map(k => `<button class="tb-chip${hidden.includes(k) ? '' : ' active'}" onclick="TaskBoard.toggleLaneVisible('${escapeAttr(k)}')">${escapeHtml(decodeName(k))}</button>`).join('');
    const lanes = keys.filter(k => !hidden.includes(k)).map(k => TaskBoard.laneHtml(board, k, compact)).join('');
    return `<div class="tb-chips">${chips}</div>${lanes || '<div class="empty-state"><p>All lanes are hidden.</p></div>'}`;
  },

  findCard(id) {
    return TaskBoard.board.cards.find(c => c.id === id);
  },

  projectOptions() {
    return (Projects.data || []).map(p => [p.slug, decodeName(p.slug)]);
  },

  /** New card (id null, optionally preset to a lane) or edit an existing one. */
  openEditor(id, lane) {
    const card = id ? TaskBoard.findCard(id) : null;
    if (id && !card) return;
    const options = TaskBoard.projectOptions();
    if (!card && !options.length) {
      toast('No projects found', 'error');
      return;
    }
    const projectField = card
      ? formGroup('Project', `<div class="tb-editor-project">${escapeHtml(decodeName(card.project))}</div>`)
      : formGroup('Project', frontmatterSelectHtml('tb-project', options, lane || options[0][0]));
    const body = projectField
      + formGroup('Title (optional)', `<input type="text" id="tb-title" value="${escapeAttr(card ? card.title : '')}">`)
      + formGroup('Description / ticket number', `<textarea id="tb-notes" rows="8" placeholder="What Claude should do — this becomes your first message in the session">${escapeHtml(card ? card.notes : '')}</textarea>`);
    const buttons = [];
    if (card && TaskBoard.DELETABLE.includes(card.column)) {
      buttons.push({ label: 'Delete', danger: true, onClick: () => TaskBoard.confirmDelete(card.id) });
    }
    buttons.push({ label: card ? 'Save' : 'Add', primary: true, onClick: () => TaskBoard.save(card) });
    openModal({ title: card ? 'Edit ticket' : 'New ticket', width: 560, body, buttons });
    setTimeout(() => { const t = document.getElementById('tb-notes'); if (t) t.focus(); }, 0);
  },

  async save(card) {
    const payload = {
      title: document.getElementById('tb-title').value,
      notes: document.getElementById('tb-notes').value
    };
    if (!card) payload.project = document.getElementById('tb-project').value;
    try {
      if (card) await api('/api/task-board/cards/' + encodeURIComponent(card.id), { method: 'PUT', body: payload });
      else await api('/api/task-board/cards', { method: 'POST', body: payload });
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    await TaskBoard.load();
  },

  confirmDelete(id) {
    openModal({
      title: 'Delete ticket?',
      body: '<p>The ticket is removed from the board. Its session, if any, stays in the session history.</p>',
      buttons: [{ label: 'Delete', danger: true, onClick: async () => {
        try {
          await api('/api/task-board/cards/' + encodeURIComponent(id), { method: 'DELETE' });
        } catch (e) {
          toast(e.message, 'error');
          return;
        }
        await TaskBoard.load();
      } }]
    });
    return true;
  },

  async setParallel(slug, parallel) {
    try {
      await api('/api/task-board/lanes/' + encodeURIComponent(slug), { method: 'PUT', body: { parallel } });
      TaskBoard.board.projects[slug].parallel = parallel;
    } catch (e) {
      toast(e.message, 'error');
      TaskBoard.render();
    }
  },

  // --- Workflow editor ---

  async openWorkflow(slug) {
    let data;
    try {
      data = await api('/api/task-board/lanes/' + encodeURIComponent(slug) + '/workflow');
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    TaskBoard._wf = Object.assign({ slug, diff: false }, data, { stages: data.stages.map(s => Object.assign({}, s)) });
    openModal({
      title: 'Workflow — ' + decodeName(slug),
      width: 820,
      body: '<div id="tb-wf"></div>',
      buttons: [{ label: 'Save', primary: true, onClick: () => TaskBoard.saveWorkflow() }],
      onClose: () => { TaskBoard._wf = null; }
    });
    TaskBoard.renderWorkflow();
  },

  renderWorkflow() {
    const el = document.getElementById('tb-wf');
    if (el && TaskBoard._wf) el.innerHTML = TaskBoard.workflowHtml(TaskBoard._wf);
  },

  stageLabel(s) {
    return s.type === 'prompt' ? 'prompt: ' + s.prompt.split('\n')[0] : s.type + ': ' + s.ref;
  },

  refOptions(available, stage) {
    const list = available.filter(a => a.kind === stage.type)
      .map(a => [a.name, a.name + ' · ' + a.source]);
    if (stage.ref && !list.some(([v]) => v === stage.ref)) list.unshift([stage.ref, stage.ref + ' (missing)']);
    return list;
  },

  stageRowHtml(wf, s, i) {
    const missing = (wf.missing || []).includes(s.id);
    const ref = s.type === 'prompt'
      ? ''
      : `<select class="tb-wf-ref${missing ? ' tb-wf-ref--missing' : ''}" onchange="TaskBoard.wfSet(${i}, 'ref', this.value)">${
          TaskBoard.refOptions(wf.available, s).map(([v, label]) => `<option value="${escapeAttr(v)}"${v === s.ref ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')
        }</select>`;
    const types = [['skill', 'Skill'], ['agent', 'Agent'], ['prompt', 'Prompt']]
      .map(([v, label]) => `<option value="${v}"${v === s.type ? ' selected' : ''}>${label}</option>`).join('');
    const last = wf.stages.length - 1;
    return `<div class="tb-wf-row">
        <span class="tb-wf-num">${i + 1}</span>
        <div class="tb-wf-fields">
          <div class="tb-wf-line">
            <input type="text" class="tb-wf-title" value="${escapeAttr(s.title)}" placeholder="Stage name" oninput="TaskBoard.wfSet(${i}, 'title', this.value, true)">
            <select class="tb-wf-type" onchange="TaskBoard.wfSet(${i}, 'type', this.value)">${types}</select>
            ${ref}
          </div>
          <textarea rows="2" placeholder="${s.type === 'prompt' ? 'What Claude should do in this stage' : 'Extra instructions (optional)'}" oninput="TaskBoard.wfSet(${i}, 'prompt', this.value, true)">${escapeHtml(s.prompt)}</textarea>
        </div>
        <div class="tb-wf-actions">
          <button class="btn btn-sm" onclick="TaskBoard.wfMove(${i}, -1)"${i === 0 ? ' disabled' : ''} title="Move up">&uarr;</button>
          <button class="btn btn-sm" onclick="TaskBoard.wfMove(${i}, 1)"${i === last ? ' disabled' : ''} title="Move down">&darr;</button>
          <button class="btn btn-sm" onclick="TaskBoard.wfRemove(${i})" title="Remove stage">&times;</button>
        </div>
      </div>`;
  },

  diffHtml(wf) {
    const list = stages => stages.length
      ? stages.map((s, i) => `<li><strong>${i + 1}. ${escapeHtml(s.title)}</strong> <span class="tb-wf-dim">${escapeHtml(TaskBoard.stageLabel(s))}</span></li>`).join('')
      : '<li class="tb-wf-dim">No stages</li>';
    return `<div class="tb-wf-diff">
        <div><h4>Current</h4><ol>${list(wf.stages)}</ol></div>
        <div><h4>Recommended</h4><ol>${list(wf.recommended)}</ol></div>
      </div>
      <div class="tb-wf-diff-actions">
        <button class="btn btn-sm btn-primary" onclick="TaskBoard.wfApplyRecommended()">Use recommended</button>
        <button class="btn btn-sm" onclick="TaskBoard.wfKeepCurrent()">Keep current</button>
      </div>`;
  },

  /** The editor body: skill-change banner or diff, the stage rows, add/recommend. Pure, for tests. */
  workflowHtml(wf) {
    let top = '';
    if (wf.diff) top = TaskBoard.diffHtml(wf);
    else if (wf.skillsChanged) {
      top = `<div class="tb-wf-banner">Skills or agents in this project changed since the workflow was saved.
          <button class="btn btn-sm" onclick="TaskBoard.wfShowDiff()">Compare with recommended</button></div>`;
    }
    const rows = wf.stages.length
      ? wf.stages.map((s, i) => TaskBoard.stageRowHtml(wf, s, i)).join('')
      : '<div class="tb-col-empty">No stages yet — use Recommend, or add a stage.</div>';
    return `${top}
      <div class="tb-wf-hint">After Ready the stages run in this order, each one starting by itself when the previous one is done. Then the ticket waits in Move to PR.</div>
      <div class="tb-wf-rows">${rows}</div>
      <div class="tb-wf-footer">
        <button class="btn btn-sm" onclick="TaskBoard.wfAdd()"${wf.stages.length >= 10 ? ' disabled' : ''}>+ Add stage</button>
        <button class="btn btn-sm" onclick="TaskBoard.wfRecommend()" title="Pick stages from this project's skills by name and description — no AI">Recommend</button>
      </div>`;
  },

  /** Update one field; typing (quiet) keeps focus, so it does not re-render. */
  wfSet(i, field, value, quiet) {
    const s = TaskBoard._wf.stages[i];
    s[field] = value;
    if (field === 'type') {
      const first = TaskBoard._wf.available.find(a => a.kind === value);
      s.ref = value === 'prompt' ? '' : (first ? first.name : '');
    }
    if (!quiet) TaskBoard.renderWorkflow();
  },

  wfMove(i, delta) {
    const stages = TaskBoard._wf.stages;
    const [s] = stages.splice(i, 1);
    stages.splice(i + delta, 0, s);
    TaskBoard.renderWorkflow();
  },

  wfRemove(i) {
    TaskBoard._wf.stages.splice(i, 1);
    TaskBoard.renderWorkflow();
  },

  wfAdd() {
    TaskBoard._wf.stages.push({ title: '', type: 'prompt', ref: '', prompt: '' });
    TaskBoard.renderWorkflow();
  },

  wfRecommend() {
    TaskBoard._wf.stages = TaskBoard._wf.recommended.map(s => Object.assign({}, s));
    TaskBoard.renderWorkflow();
    toast('Recommended stages loaded — review them and Save');
  },

  wfShowDiff() {
    TaskBoard._wf.diff = true;
    TaskBoard.renderWorkflow();
  },

  wfApplyRecommended() {
    TaskBoard._wf.diff = false;
    TaskBoard._wf.skillsChanged = false;
    TaskBoard.wfRecommend();
  },

  async wfKeepCurrent() {
    const wf = TaskBoard._wf;
    try {
      await api('/api/task-board/lanes/' + encodeURIComponent(wf.slug) + '/workflow/dismiss', { method: 'POST' });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    wf.diff = false;
    wf.skillsChanged = false;
    TaskBoard.renderWorkflow();
    TaskBoard.load();
  },

  async saveWorkflow() {
    const wf = TaskBoard._wf;
    try {
      await api('/api/task-board/lanes/' + encodeURIComponent(wf.slug) + '/workflow', { method: 'PUT', body: { stages: wf.stages } });
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    toast('Workflow saved');
    TaskBoard.load();
  },

  openAddLane() {
    const taken = Object.keys(TaskBoard.board.projects || {});
    const options = (Projects.data || []).filter(p => !taken.includes(p.slug)).map(p => [p.slug, decodeName(p.slug)]);
    if (!options.length) {
      toast('Every project already has a lane', 'error');
      return;
    }
    openModal({
      title: 'Add project lane',
      body: formGroup('Project', frontmatterSelectHtml('tb-lane-project', options, options[0][0])),
      buttons: [{ label: 'Add', primary: true, onClick: async () => {
        const slug = document.getElementById('tb-lane-project').value;
        try {
          await api('/api/task-board/lanes/' + encodeURIComponent(slug), { method: 'PUT', body: {} });
        } catch (e) {
          toast(e.message, 'error');
          return false;
        }
        await TaskBoard.load();
      } }]
    });
  },

  async removeLane(slug) {
    try {
      await api('/api/task-board/lanes/' + encodeURIComponent(slug), { method: 'DELETE' });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    await TaskBoard.load();
  },

  onDragStart(e) {
    const el = e.target.closest('.tb-card');
    TaskBoard._drag = el ? TaskBoard.findCard(el.dataset.id) : null;
    if (!TaskBoard._drag) return;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', TaskBoard._drag.id); } catch (_) {}
    el.classList.add('tb-card--dragging');
  },

  onDragEnd(e) {
    const el = e.target.closest('.tb-card');
    if (el) el.classList.remove('tb-card--dragging');
    document.querySelectorAll('.tb-col--over').forEach(c => c.classList.remove('tb-col--over'));
    TaskBoard._drag = null;
  },

  dropAllowed(col) {
    const card = TaskBoard._drag;
    return !!card && card.project === col.dataset.lane && TaskBoard.canMove(card, col.dataset.column);
  },

  onDragOver(e) {
    const col = e.currentTarget;
    if (!TaskBoard.dropAllowed(col)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('tb-col--over');
  },

  onDragLeave(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('tb-col--over');
  },

  /** Index among the column's cards to insert before: the first card whose middle is below the pointer. */
  dropIndex(col, clientY) {
    const cards = Array.from(col.querySelectorAll('.tb-card')).filter(c => !TaskBoard._drag || c.dataset.id !== TaskBoard._drag.id);
    const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return clientY < r.top + r.height / 2; });
    return i === -1 ? cards.length : i;
  },

  async onDrop(e) {
    const col = e.currentTarget;
    col.classList.remove('tb-col--over');
    if (!TaskBoard.dropAllowed(col)) return;
    e.preventDefault();
    const card = TaskBoard._drag;
    const index = TaskBoard.dropIndex(col, e.clientY);
    try {
      await api('/api/task-board/cards/' + encodeURIComponent(card.id) + '/move', { method: 'POST', body: { column: col.dataset.column, index } });
    } catch (err) {
      toast(err.message, 'error');
    }
    await TaskBoard.load();
  }
};

// --- Task Board ---
// Kanban of tickets across projects: one swimlane per project. ToDo, Ready, Move to PR and Done are
// fixed in every lane; the project's workflow stages sit between Ready and Move to PR.

const TaskBoard = {
  HIDDEN_KEY: 'claude-manager-task-board-hidden',
  COLUMN_TITLES: { todo: 'ToDo', ready: 'Ready', 'move-to-pr': 'Move to PR', done: 'Done' },
  DELETABLE: ['todo', 'done'],
  USER_MOVES: { todo: ['ready'], ready: ['todo'], 'move-to-pr': ['done'] },
  board: { cards: [], projects: {} },
  _drag: null,

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
    if (el) el.innerHTML = TaskBoard.html(TaskBoard.board, TaskBoard.hidden());
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

  /** A lane's columns: fixed ones around its workflow stages, or a placeholder while it has none. */
  laneColumns(board, key) {
    const lane = (board.projects || {})[key];
    const stages = (lane && lane.stages) || [];
    const middle = stages.length
      ? stages.map(s => ({ id: s.id, title: s.title || s.id, stage: true }))
      : [{ id: '', title: 'Workflow', placeholder: true }];
    const fixed = id => ({ id, title: TaskBoard.COLUMN_TITLES[id] });
    return [fixed('todo'), fixed('ready')].concat(middle, [fixed('move-to-pr'), fixed('done')]);
  },

  canMove(card, column) {
    return card.column === column || (TaskBoard.USER_MOVES[card.column] || []).includes(column);
  },

  /** Title, or the first line of the description when there is no title. */
  cardHtml(card) {
    const lines = (card.notes || '').trim().split('\n');
    const heading = card.title || lines[0];
    const notes = card.title ? lines[0] : lines[1];
    return `<div class="tb-card${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openEditor('${escapeAttr(card.id)}')">
        ${card.closed ? '<div class="tb-card-head"><span class="tb-badge tb-badge--closed">closed</span></div>' : ''}
        ${heading ? `<div class="tb-card-title">${escapeHtml(heading)}</div>` : ''}
        ${notes ? `<div class="tb-card-notes">${escapeHtml(notes)}</div>` : ''}
      </div>`;
  },

  laneHtml(board, key) {
    const columns = TaskBoard.laneColumns(board, key);
    const cards = (board.cards || []).filter(c => c.project === key);
    const lane = board.projects[key];
    const head = `<div class="tb-lane-head">
        <span class="tb-lane-name">${escapeHtml(decodeName(key))}</span>
        <span class="git-count-badge">${cards.length}</span>
        <label class="tb-parallel" title="Run this project's tickets in parallel, each in its own git worktree">
          <input type="checkbox"${lane.parallel ? ' checked' : ''} onchange="TaskBoard.setParallel('${escapeAttr(key)}', this.checked)"> Parallel
        </label>
        ${!cards.length ? `<button class="btn btn-sm tb-lane-remove" onclick="TaskBoard.removeLane('${escapeAttr(key)}')" title="Remove lane">&times;</button>` : ''}
      </div>`;
    const cols = columns.map(col => {
      if (col.placeholder) {
        return `<div class="tb-col tb-col--placeholder"><div class="tb-col-head">${escapeHtml(col.title)}</div>
            <div class="tb-col-empty">No workflow yet</div></div>`;
      }
      const list = cards.filter(c => c.column === col.id);
      const add = col.id === 'todo'
        ? `<button class="btn btn-sm tb-add" onclick="TaskBoard.openEditor(null, '${escapeAttr(key)}')">+ Ticket</button>`
        : '';
      return `<div class="tb-col${col.stage ? ' tb-col--stage' : ''}" data-lane="${escapeAttr(key)}" data-column="${escapeAttr(col.id)}"
          ondragover="TaskBoard.onDragOver(event)" ondragleave="TaskBoard.onDragLeave(event)" ondrop="TaskBoard.onDrop(event)">
          <div class="tb-col-head">${escapeHtml(col.title)} <span class="tb-col-count">${list.length}</span></div>
          <div class="tb-col-cards">${list.map(TaskBoard.cardHtml).join('')}</div>
          ${add}
        </div>`;
    }).join('');
    return `<section class="tb-lane" data-lane="${escapeAttr(key)}">${head}<div class="tb-cols" style="--tb-cols:${columns.length}">${cols}</div></section>`;
  },

  /** The whole board: lane filter chips, then each visible lane. Pure, for tests. */
  html(board, hidden) {
    const keys = TaskBoard.laneKeys(board);
    if (!keys.length) return '<div class="empty-state"><p>No tickets yet. Add a project lane or a new ticket to start.</p></div>';
    const chips = keys.map(k => `<button class="tb-chip${hidden.includes(k) ? '' : ' active'}" onclick="TaskBoard.toggleLaneVisible('${escapeAttr(k)}')">${escapeHtml(decodeName(k))}</button>`).join('');
    const lanes = keys.filter(k => !hidden.includes(k)).map(k => TaskBoard.laneHtml(board, k)).join('');
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

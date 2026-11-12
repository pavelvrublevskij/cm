// --- Task Board ---
// Kanban of tickets across projects: one swimlane per project. ToDo, Ready and Done are fixed in
// every lane; the project's workflow stages sit between Ready and Done.

const TaskBoard = {
  HIDDEN_KEY: 'claude-manager-task-board-hidden',
  COMPACT_KEY: 'claude-manager-task-board-compact',
  COLUMN_TITLES: { todo: 'ToDo', ready: 'Ready', finalize: 'Finalize', done: 'Done' },
  DELETABLE: ['todo', 'done'],
  USER_MOVES: { todo: ['ready'], ready: ['todo'], done: ['todo'] },
  RUN_LABELS: { starting: 'starting', running: 'running', needs_input: 'needs input', conflict: 'conflict' },
  board: { cards: [], projects: {}, status: {} },
  attention: [],
  _progress: null,
  _drag: null,
  _wf: null,
  _poll: null,

  /**
   * Tickets waiting for the user, watched from every view at the conversation refresh rate: the
   * sidebar count, a toast for a newly waiting ticket while the board is not open, and a badge on
   * its session in the active sessions bar.
   */
  watchAttention() {
    TaskBoard.refreshAttention().finally(() => setTimeout(TaskBoard.watchAttention, Sessions.refreshIntervalMs()));
  },

  async refreshAttention() {
    let data;
    try { data = await api('/api/task-board/attention'); } catch (_) { return; }
    const list = data.waiting;
    const known = new Set(TaskBoard.attention.map(a => a.id));
    const fresh = list.some(a => !known.has(a.id));
    if (TaskBoard.allDone(TaskBoard._progress, data)) toast('Task Board: all tickets are done');
    TaskBoard._progress = { active: data.active, done: data.done };
    TaskBoard.attention = list;
    const badge = document.getElementById('nav-task-board-attention');
    if (badge) {
      badge.textContent = list.length;
      badge.style.display = list.length ? '' : 'none';
    }
    const progress = document.getElementById('nav-task-board-progress');
    if (progress) {
      progress.textContent = data.inProgress;
      progress.style.display = data.inProgress ? '' : 'none';
    }
    ActiveSessionsBar._render();
    ActiveSessionsBar._renderSidebar();
    if (fresh && App.currentView !== 'task-board') toast(TaskBoard.attentionMessage(list.length), 'warning');
  },

  /** The last running or waiting ticket just finished, and it (or another) reached Done. */
  allDone(before, now) {
    return !!before && before.active > 0 && now.active === 0 && now.done > before.done;
  },

  attentionMessage(count) {
    return `Task Board: ${count} ${count === 1 ? 'ticket needs' : 'tickets need'} your input`;
  },

  /** The needs input / conflict badge for a ticket's session, or '' when it is not waiting. */
  attentionBadgeHtml(sessionId) {
    const a = TaskBoard.attention.find(x => x.sessionId === sessionId);
    if (!a) return '';
    return `<span class="tb-badge tb-badge--${a.status}" title="${escapeAttr(a.message)}">${TaskBoard.RUN_LABELS[a.status]}</span>`;
  },

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
    TaskBoard.startPolling();
  },

  /** Keep running tickets current while the board is open (at the conversation refresh rate); stops once another view is shown. */
  startPolling() {
    const ms = Sessions.refreshIntervalMs();
    setFooterStatus(`Live · refresh ${Math.round(ms / 1000)}s`, true);
    if (TaskBoard._poll) return;
    TaskBoard._poll = setInterval(async () => {
      if (App.currentView !== 'task-board') {
        clearInterval(TaskBoard._poll);
        TaskBoard._poll = null;
        if (App.currentView !== 'session-detail') setFooterStatus('Idle', false);
        return;
      }
      if (TaskBoard._drag) return;
      try {
        TaskBoard.board = await api('/api/task-board');
        TaskBoard.render();
      } catch (_) { /* the next tick tries again */ }
    }, ms);
  },

  /** Inside the workflow: past Ready, not yet Done (its stages, then Finalize). */
  inWorkflow(card) {
    return card.column === 'finalize' || !TaskBoard.COLUMN_TITLES[card.column];
  },

  /**
   * The closed mark (with why, on hover), the countdown of a ticket waiting in Ready, or the live
   * run status of a ticket in the workflow.
   */
  badgeHtml(card, now = Date.now(), delay = TaskBoard.board.readyDelayMs || 30000) {
    const run = card.run || {};
    if (card.closed) return `<span class="tb-badge tb-badge--closed" title="${escapeAttr(run.message || '')}">closed</span>`;
    if (card.column === 'ready') {
      const left = Math.ceil(((Date.parse(card.readyAt) || 0) + delay - now) / 1000);
      return left > 0
        ? `<span class="tb-badge tb-badge--starting" title="Move it back to ToDo to cancel">starts in ${left}s</span>`
        : '<span class="tb-badge tb-badge--starting" title="Starts when the ticket before it is done">queued</span>';
    }
    const label = TaskBoard.inWorkflow(card) && TaskBoard.RUN_LABELS[run.status];
    if (!label) return '';
    return `<span class="tb-badge tb-badge--${run.status}" title="${escapeAttr(run.message || '')}">${label}</span>`;
  },

  /** A ticket in the workflow opens its session (live terminal); any other opens the editor. */
  openCard(id) {
    const card = TaskBoard.findCard(id);
    if (!card) return;
    if (TaskBoard.inWorkflow(card) && card.sessionId) {
      TaskBoard.openSession(card);
      return;
    }
    TaskBoard.openEditor(id);
  },

  /** A ticket's session runs hidden; opening it lists it like any running session from then on. */
  async openSession(card) {
    try { await api('/api/task-board/cards/' + encodeURIComponent(card.id) + '/reveal', { method: 'POST' }); }
    catch (e) { toast(e.message, 'error'); }
    location.hash = '#session-detail/' + (card.sessionSlug || card.project) + '/' + card.sessionId;
    ActiveSessionsBar.poll();
  },

  /** In session-detail: a banner naming the ticket and stage when the open session runs a Task Board ticket. */
  async renderSessionInfo(sessionId) {
    const el = document.getElementById('session-board-info');
    if (!el) return;
    let info = { card: null };
    try { info = await api('/api/task-board/session/' + encodeURIComponent(sessionId)); } catch (_) { /* no banner */ }
    if (Sessions.detailState.sessionId !== sessionId) return;
    el.innerHTML = info.card ? TaskBoard.sessionInfoHtml(info.card, info.stage) : '';
    el.style.display = info.card ? '' : 'none';
  },

  sessionInfoHtml(card, stage) {
    const name = card.title || (card.notes || '').trim().split('\n')[0];
    const where = !stage ? '' : stage.finalize ? ' · Finalize' : ` · stage ${stage.index + 1}/${stage.total}: ${escapeHtml(stage.title)}`;
    const gitBranch = TaskBoard.gitBranchOf(card);
    const onBranch = gitBranch ? ` on branch <code>${escapeHtml(gitBranch)}</code>` : '';
    return `&#9638; This session runs the Task Board ticket <strong>${escapeHtml(name)}</strong>${where}${onBranch}. ${TaskBoard.badgeHtml(card)}`;
  },

  render() {
    const el = document.getElementById('task-board-body');
    if (el) el.innerHTML = TaskBoard.html(TaskBoard.board, TaskBoard.hidden(), TaskBoard.compact());
    const btn = document.getElementById('task-board-compact-btn');
    if (btn) btn.classList.toggle('btn-active', TaskBoard.compact());
  },

  compact() {
    try { return localStorage.getItem(TaskBoard.COMPACT_KEY) !== '0'; }
    catch (_) { return true; }
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
    return [fixed('todo'), fixed('ready')].concat(middle, [fixed('finalize'), fixed('done')]);
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
    const gitBranch = TaskBoard.gitBranchOf(card);
    const tip = heading + (gitBranch ? '\nBranch: ' + gitBranch : '');
    return `<div class="tb-card tb-card--line${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}" title="${escapeAttr(tip)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openCard('${escapeAttr(card.id)}')">
        <span class="tb-line-text">${escapeHtml(heading)}</span>
        ${TaskBoard.badgeHtml(card)}
        ${dots}
        ${TaskBoard.deleteIconHtml(card)}
      </div>`;
  },

  deleteIconHtml(card) {
    if (!TaskBoard.DELETABLE.includes(card.column)) return '';
    return `<button class="icon-btn tb-card-delete" draggable="false" title="Delete ticket" aria-label="Delete ticket"
        onclick="event.stopPropagation(); TaskBoard.confirmDelete('${escapeAttr(card.id)}')"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.5 1.75a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 .25.25V3h-3ZM11 3V1.75A1.75 1.75 0 0 0 9.25 0h-2.5A1.75 1.75 0 0 0 5 1.75V3H2.75a.75.75 0 0 0 0 1.5h.67l.83 9.41A1.75 1.75 0 0 0 6 15.5h4a1.75 1.75 0 0 0 1.74-1.59l.84-9.41h.67a.75.75 0 0 0 0-1.5Zm-6.08 1.5h6.16l-.83 9.28a.25.25 0 0 1-.25.22H6a.25.25 0 0 1-.25-.22Z"/></svg></button>`;
  },

  /** Title, or the first line of the description when there is no title. Compact: a one-line card with stage dots. */
  cardHtml(card, stages, compact) {
    const lines = (card.notes || '').trim().split('\n');
    const heading = card.title || lines[0];
    if (compact) return TaskBoard.lineCardHtml(card, heading, stages);
    const notes = card.title ? lines[0] : lines[1];
    const badge = TaskBoard.badgeHtml(card);
    const message = card.run && card.run.message && TaskBoard.inWorkflow(card) ? card.run.message : '';
    const branch = card.branch && TaskBoard.inWorkflow(card)
      ? `<div class="tb-card-branch" title="Condition taken after ${escapeAttr(card.branch.from)}">If ${escapeHtml(card.branch.when)}</div>` : '';
    const gitBranch = TaskBoard.gitBranchOf(card);
    return `<div class="tb-card${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openCard('${escapeAttr(card.id)}')">
        ${TaskBoard.deleteIconHtml(card)}
        ${badge ? `<div class="tb-card-head">${badge}</div>` : ''}
        ${heading ? `<div class="tb-card-title">${escapeHtml(heading)}</div>` : ''}
        ${notes ? `<div class="tb-card-notes">${escapeHtml(notes)}</div>` : ''}
        ${gitBranch ? `<div class="tb-card-git" title="Worktree branch">&#5833; ${escapeHtml(gitBranch)}</div>` : ''}
        ${branch}
        ${message ? `<div class="tb-card-run">${escapeHtml(message)}</div>` : ''}
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
        <label class="tb-parallel" title="Run several of this project's tickets at once (limit in CM Settings); in a git project each gets its own worktree, otherwise they share the project folder">
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
        + (TaskBoard.gitBranchOf(card) ? formGroup('Branch', `<div class="tb-editor-project tb-card-git">${escapeHtml(TaskBoard.gitBranchOf(card))}</div>`) : '')
      : formGroup('Project', frontmatterSelectHtml('tb-project', options, lane || options[0][0]));
    const editable = !card || card.column === 'todo';
    const ro = editable ? '' : ' readonly';
    const body = projectField
      + formGroup('Title (optional)', `<input type="text" id="tb-title" value="${escapeAttr(card ? card.title : '')}"${ro}>`)
      + formGroup('Description / ticket number', `<textarea id="tb-notes" rows="8" placeholder="What Claude should do — this becomes your first message in the session"${ro}>${escapeHtml(card ? card.notes : '')}</textarea>`);
    const buttons = [];
    if (card && card.sessionId) {
      buttons.push({ label: 'Open session', onClick: () => TaskBoard.openSession(card) });
    }
    if (card && TaskBoard.inWorkflow(card)) {
      buttons.push({ label: 'Stop', danger: true, onClick: () => TaskBoard.stop(card.id) });
    }
    if (card && TaskBoard.DELETABLE.includes(card.column)) {
      buttons.push({ label: 'Delete', danger: true, onClick: () => TaskBoard.confirmDelete(card.id) });
    }
    if (editable) buttons.push({ label: card ? 'Save' : 'Add', primary: true, onClick: () => TaskBoard.save(card) });
    openModal({ title: !card ? 'New ticket' : editable ? 'Edit ticket' : 'Ticket', width: 560, body, buttons });
    if (editable) setTimeout(() => { const t = document.getElementById('tb-notes'); if (t) t.focus(); }, 0);
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

  async stop(id) {
    try {
      await api('/api/task-board/cards/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    await TaskBoard.load();
  },

  /**
   * Before closing a session: when it runs a Task Board ticket, ask whether to keep it running.
   * Closing stops the workflow and sends the ticket back to ToDo, closed. Resolves true to go on closing.
   */
  async confirmCloseSession(sessionId) {
    let card;
    try { card = (await api('/api/task-board/session/' + encodeURIComponent(sessionId))).card; }
    catch (_) { return true; }
    if (!card) return true;
    const name = card.title || (card.notes || '').trim().split('\n')[0];
    return new Promise(resolve => {
      let answered = false;
      openModal({
        title: 'Close Task Board session?',
        body: `<p>This session runs the ticket <strong>${escapeHtml(name)}</strong>. Hide it to let the ticket keep running in the background, or close it to stop the workflow and move the ticket back to ToDo, marked closed.</p>`,
        buttons: [
          { label: 'Close', danger: true, onClick: async () => {
            answered = true;
            try { await api('/api/task-board/cards/' + encodeURIComponent(card.id) + '/stop', { method: 'POST' }); }
            catch (e) { toast(e.message, 'error'); }
            resolve(true);
          } },
          { label: 'Hide and keep running', primary: true, onClick: async () => {
            answered = true;
            try { await api('/api/task-board/cards/' + encodeURIComponent(card.id) + '/hide', { method: 'POST' }); }
            catch (e) { toast(e.message, 'error'); }
            ActiveSessionsBar._removeFromBar(s => s.sessionId === sessionId);
            resolve(false);
            App.navigate('task-board');
          } }
        ],
        onClose: () => { if (!answered) resolve(false); }
      });
    });
  },

  confirmDelete(id) {
    openModal({
      title: 'Delete ticket?',
      body: TaskBoard.deleteMessageHtml(TaskBoard.findCard(id) || {}),
      buttons: [{ label: 'Delete', danger: true, onClick: async () => {
        let res;
        try {
          res = await api('/api/task-board/cards/' + encodeURIComponent(id), { method: 'DELETE' });
        } catch (e) {
          toast(e.message, 'error');
          return;
        }
        if (res.warning) toast(res.warning, 'warning');
        await TaskBoard.load();
      } }]
    });
    return true;
  },

  /** The ticket's own branch once it has a worktree (named when the worktree was created). */
  gitBranchOf(card) {
    return card.gitBranch || (card.worktree ? 'worktree-' + card.worktree : '');
  },

  /** A Done ticket with a worktree takes its worktree and branch with it; the session always stays. */
  deleteMessageHtml(card) {
    const worktree = card.column === 'done' && card.worktree
      ? ` Its worktree <code>.claude/worktrees/${escapeHtml(card.worktree)}</code> and branch <code>${escapeHtml(TaskBoard.gitBranchOf(card))}</code> are removed too.`
      : '';
    return `<p>The ticket is removed from the board.${worktree} Its session, if any, stays in the session history.</p>`;
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
          ${TaskBoard.branchesHtml(wf, s, i)}
        </div>
        <div class="tb-wf-actions">
          <button class="btn btn-sm" onclick="TaskBoard.wfMove(${i}, -1)"${i === 0 ? ' disabled' : ''} title="Move up">&uarr;</button>
          <button class="btn btn-sm" onclick="TaskBoard.wfMove(${i}, 1)"${i === last ? ' disabled' : ''} title="Move down">&darr;</button>
          <button class="btn btn-sm" onclick="TaskBoard.wfRemove(${i})" title="Remove stage">&times;</button>
        </div>
      </div>`;
  },

  /**
   * A stage's conditions: "If <text> go to <stage | Done>", checked in order by Claude when the
   * stage is finished. Without a matching condition the ticket goes on to the next stage.
   */
  branchesHtml(wf, s, i) {
    const branches = s.branches || [];
    const targets = wf.stages.map((t, n) => [t.id, `${n + 1}. ${t.title || 'Untitled'}`]).concat([['done', 'Done']]);
    const rows = branches.map((b, j) => `<div class="tb-wf-branch">
        <span class="tb-wf-dim">If</span>
        <input type="text" value="${escapeAttr(b.when)}" placeholder="condition, e.g. the ticket is a bug" oninput="TaskBoard.wfSetBranch(${i}, ${j}, 'when', this.value, true)">
        <span class="tb-wf-dim">go to</span>
        <select onchange="TaskBoard.wfSetBranch(${i}, ${j}, 'to', this.value)">${
          targets.map(([v, label]) => `<option value="${escapeAttr(v)}"${v === b.to ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')
        }</select>
        <button class="btn btn-sm" onclick="TaskBoard.wfRemoveBranch(${i}, ${j})" title="Remove condition">&times;</button>
      </div>`).join('');
    const add = branches.length < 4
      ? `<button class="btn btn-sm tb-wf-branch-add" onclick="TaskBoard.wfAddBranch(${i})" title="Jump to another stage when a condition holds">+ Condition</button>`
      : '';
    const otherwise = branches.length ? `<div class="tb-wf-dim tb-wf-branch-else">Otherwise: ${i === wf.stages.length - 1 ? 'Done' : 'next stage'}</div>` : '';
    return `<div class="tb-wf-branches">${rows}${otherwise}${add}</div>`;
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
      <div class="tb-wf-hint">After Ready the stages run in this order, each one starting by itself when the previous one is done. Then it goes through Finalize (commit and merge in its branch when it runs in a worktree, run the tests) to Done. A condition lets Claude jump to another stage instead; one ticket runs the same stage at most 3 times.</div>
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

  /** Conditions jumping to a removed stage go with it. */
  wfRemove(i) {
    const [gone] = TaskBoard._wf.stages.splice(i, 1);
    for (const s of TaskBoard._wf.stages) s.branches = (s.branches || []).filter(b => b.to !== gone.id);
    TaskBoard.renderWorkflow();
  },

  /** A new stage gets its id here, so conditions can point at it before the workflow is saved. */
  newStageId() {
    return 's-' + (Math.random().toString(36).slice(2) + '00000000').slice(0, 8);
  },

  wfAdd() {
    TaskBoard._wf.stages.push({ id: TaskBoard.newStageId(), title: '', type: 'prompt', ref: '', prompt: '', branches: [] });
    TaskBoard.renderWorkflow();
  },

  wfAddBranch(i) {
    const s = TaskBoard._wf.stages[i];
    s.branches = (s.branches || []).concat([{ when: '', to: 'done' }]);
    TaskBoard.renderWorkflow();
  },

  wfSetBranch(i, j, field, value, quiet) {
    TaskBoard._wf.stages[i].branches[j][field] = value;
    if (!quiet) TaskBoard.renderWorkflow();
  },

  wfRemoveBranch(i, j) {
    TaskBoard._wf.stages[i].branches.splice(j, 1);
    TaskBoard.renderWorkflow();
  },

  wfRecommend() {
    TaskBoard._wf.stages = TaskBoard._wf.recommended.map(s => Object.assign({ id: TaskBoard.newStageId(), branches: [] }, s));
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

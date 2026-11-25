// --- Task Board ---
// Kanban of tickets across projects: one swimlane per project. ToDo, Ready and Done are fixed in
// every lane; the project's workflow stages sit between Ready and Done.

const TaskBoard = {
  HIDDEN_KEY: 'claude-manager-task-board-hidden',
  COMPACT_KEY: 'claude-manager-task-board-compact',
  VIEW_KEY: 'claude-manager-task-board-view',
  VIEWS: [{ id: 'board', label: 'Board' }, { id: 'compact', label: 'Compact' }, { id: 'pipeline', label: 'Pipeline' }, { id: 'radar', label: 'Radar' }],
  /** Ticket elements in every view: cards, and the Pipeline/Radar tickets (hover preview, click). */
  CARD_SEL: '.tb-card, .tb-viz-ticket',
  COLUMN_TITLES: { todo: 'ToDo', ready: 'Ready', finalize: 'Finalize', done: 'Done' },
  DELETABLE: ['todo', 'done'],
  MEMO_COLUMNS: ['finalize', 'done'],
  USER_MOVES: { todo: ['ready'], ready: ['todo'], done: ['todo'] },
  RUN_LABELS: { starting: 'starting', running: 'running', needs_input: 'needs input', conflict: 'conflict' },
  ATTENTION_TOAST_MS: 15000,
  board: { cards: [], projects: {}, status: {} },
  attention: [],
  _progress: null,
  _drag: null,
  _wf: null,
  _poll: null,
  PREVIEW_DELAY_MS: 1000,
  PREVIEW_MESSAGES: 20,
  PREVIEW_HIDE_MS: 600,
  PREVIEW_SENT_RETRY_MS: 500,
  PREVIEW_SENT_TRIES: 10,
  _preview: { id: null },
  _pointer: null,

  /**
   * Tickets waiting for the user, watched from every view at the conversation refresh rate: the
   * sidebar count, a toast for a newly waiting ticket while the board is not open, a badge on
   * its session in the active sessions bar, and (with browser-terminal sessions waiting) the tab badge.
   */
  watchAttention() {
    TaskBoard.refreshAttention().finally(() => setTimeout(TaskBoard.watchAttention, Sessions.refreshIntervalMs()));
  },

  async refreshAttention() {
    let sessions = 0;
    try { sessions = (await api('/api/terminal/attention')).waiting; } catch (_) { /* the tab shows the tickets only */ }
    let data;
    try { data = await api('/api/task-board/attention'); } catch (_) { data = null; }
    // Without a fresh ticket list the tab counts the last known waiting tickets.
    if (typeof TabBadge !== 'undefined') TabBadge.set((data ? data.waiting.length : TaskBoard.attention.length) + sessions);
    if (!data) return;
    const list = data.waiting;
    const known = new Set(TaskBoard.attention.map(a => a.id));
    const fresh = list.find(a => !known.has(a.id));
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
    if (fresh && App.currentView !== 'task-board') {
      toast(TaskBoard.attentionMessage(list.length), 'warning', {
        duration: TaskBoard.ATTENTION_TOAST_MS,
        onClick: fresh.sessionId ? () => TaskBoard.openSession(fresh) : undefined
      });
    }
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

  /** A refresh would redraw the board under a drag, an open lane menu (New Session) or branch picker, so it waits. */
  pollPaused() {
    return !!TaskBoard._drag || !!document.querySelector('#task-board-body .action-menu-panel.open')
      || !!document.querySelector('#task-board-body .git-branch-picker.open');
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
      if (TaskBoard.pollPaused()) return;
      try {
        TaskBoard.board = await api('/api/task-board');
        TaskBoard.render();
      } catch (_) { /* the next tick tries again */ }
    }, ms);
  },

  /**
   * Inside the workflow: past Ready, not yet Done (its stages, then Finalize). A worktree ticket that
   * passed Finalize waits there to be merged or sent as a PR, no longer running.
   */
  inWorkflow(card) {
    return (card.column === 'finalize' || !TaskBoard.COLUMN_TITLES[card.column]) && !card.finalized;
  },

  /** Not while the ticket is in a running workflow, or in Finalize/Done with an unchecked to-do. */
  canDelete(card) {
    if (TaskBoard.MEMO_COLUMNS.includes(card.column) && (card.todos || []).some(t => !t.done)) return false;
    return TaskBoard.DELETABLE.includes(card.column) || (card.column === 'finalize' && !!card.finalized);
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
    if (card.finalized) return `<span class="tb-badge tb-badge--ready" title="${escapeAttr(run.message || '')}">merge or PR</span>`;
    const label = TaskBoard.inWorkflow(card) && TaskBoard.RUN_LABELS[run.status];
    if (!label) return '';
    return `<span class="tb-badge tb-badge--${run.status}" title="${escapeAttr(run.message || '')}">${label}</span>`;
  },

  /** A ticket in the workflow opens its session (live terminal); any other opens the editor. */
  openCard(id) {
    TaskBoard.hidePreview();
    const card = TaskBoard.findCard(id);
    if (!card) return;
    if (TaskBoard.inWorkflow(card) && card.sessionId) {
      TaskBoard.openSession(card);
      return;
    }
    TaskBoard.openEditor(id);
  },

  /** Hovering a ticket for a second shows its heading and branch, and its latest conversation lines when it has a session. */
  onCardOver(e) {
    const el = e.target.closest(TaskBoard.CARD_SEL);
    if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
    TaskBoard.hoverCard(el.dataset.id, el);
  },

  onPointerMove(e) {
    TaskBoard._pointer = { x: e.clientX, y: e.clientY };
  },

  /** A re-render replaces the cards without a mouseout: keep the preview only while the pointer is still on its card or in it. */
  checkPreview() {
    const p = TaskBoard._preview, at = TaskBoard._pointer;
    if (!p.id) return;
    const under = at && document.elementFromPoint(at.x, at.y);
    const card = under && under.closest(TaskBoard.CARD_SEL);
    if ((card && card.dataset.id === p.id) || (p.el && p.el.contains(under))) {
      const now = p.headOnly && TaskBoard.findCard(p.id);
      if (now && now.sessionId) {
        const anchor = card && card.dataset.id === p.id ? card : p.anchor;
        TaskBoard.hidePreview();
        TaskBoard._preview = { id: now.id, anchor };
        TaskBoard.showPreview(now);
      }
      return;
    }
    if (p.el && p.el.contains(document.activeElement)) return; // a message is being typed
    TaskBoard.hidePreview();
  },

  onCardOut(e) {
    const el = e.target.closest(TaskBoard.CARD_SEL);
    if (!el || (e.relatedTarget && el.contains(e.relatedTarget))) return;
    TaskBoard.leavePreview();
  },

  /** anchor: the hovered ticket element, when known. */
  hoverCard(id, anchor) {
    const p = TaskBoard._preview;
    if (p.id === id) { clearTimeout(p.hide); if (anchor && !p.el) p.anchor = anchor; return; }
    if (p.el) return; // passing over other cards on the way to the open preview
    TaskBoard.hidePreview();
    const card = TaskBoard.findCard(id);
    if (!card || TaskBoard._drag) return;
    TaskBoard._preview = { id, anchor, timer: setTimeout(() => TaskBoard.showPreview(card), TaskBoard.PREVIEW_DELAY_MS) };
  },

  /** Before the preview shows, leaving cancels it; once shown, a short grace lets the pointer move into it. */
  leavePreview() {
    const p = TaskBoard._preview;
    if (!p.el) { TaskBoard.hidePreview(); return; }
    if (p.el.contains(document.activeElement)) return; // a message is being typed
    clearTimeout(p.hide);
    p.hide = setTimeout(() => TaskBoard.previewGraceEnd(), TaskBoard.PREVIEW_HIDE_MS);
  },

  /** Grace over: close, then start the card the pointer has settled on, if any. */
  previewGraceEnd() {
    TaskBoard.hidePreview();
    const at = TaskBoard._pointer;
    const under = at && document.elementFromPoint(at.x, at.y);
    const card = under && under.closest(TaskBoard.CARD_SEL);
    if (card) TaskBoard.hoverCard(card.dataset.id, card);
  },

  hidePreview() {
    const p = TaskBoard._preview;
    clearTimeout(p.timer);
    clearTimeout(p.hide);
    clearInterval(p.refresh);
    if (p.el) p.el.remove();
    TaskBoard._preview = { id: null };
  },

  /**
   * Radar shows a ticket twice (dot and legend): the hovered element while it is still shown, else
   * the ticket's element under the pointer (a re-render replaced it), else its first element.
   */
  previewAnchor(id, hovered) {
    if (hovered && hovered.isConnected === true) return hovered;
    const at = TaskBoard._pointer;
    const under = at && document.elementFromPoint(at.x, at.y);
    const el = under && under.closest(TaskBoard.CARD_SEL);
    if (el && el.dataset.id === id) return el;
    return document.querySelector(`#task-board-body :is(${TaskBoard.CARD_SEL})[data-id="${CSS.escape(id)}"]`);
  },

  async showPreview(card) {
    const p = TaskBoard._preview;
    const anchor = TaskBoard.previewAnchor(card.id, p.anchor);
    if (!anchor) { TaskBoard.hidePreview(); return; }
    const el = document.createElement('div');
    el.className = 'tb-preview';
    el.onmouseenter = () => clearTimeout(p.hide);
    el.onmouseleave = () => TaskBoard.leavePreview();
    el.onmousemove = TaskBoard.onPointerMove;
    document.body.appendChild(el);
    p.timer = null;
    p.el = el;
    const head = TaskBoard.previewHeadHtml(card);
    if (!card.sessionId) {
      p.headOnly = true;
      el.className += ' tb-preview--head';
      el.innerHTML = `<div class="tb-preview-top">${head}</div>`;
      TaskBoard.placePreview(el, anchor.getBoundingClientRect());
      return;
    }
    el.innerHTML = `<div class="tb-preview-top">${head}${TaskBoard.previewInputHtml()}</div><div class="tb-preview-list"></div>`;
    p.list = el.querySelector('.tb-preview-list');
    const text = el.querySelector('.tb-preview-input textarea');
    text.onkeydown = e => TaskBoard.onPreviewKeyDown(p, e);
    text.onblur = () => TaskBoard.checkPreview();
    showLoading(p.list, 'Loading conversation...');
    TaskBoard.placePreview(el, anchor.getBoundingClientRect());
    el.onscroll = () => {
      if (!p.loading && p.hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 300) TaskBoard.loadPreviewPage(p);
    };
    p.card = card;
    p.offset = 0;
    TaskBoard.loadPreviewInput(p);
    // The message box state comes with the held questions, so a question card turns answerable while the preview is open.
    p.refresh = setInterval(() => { const done = TaskBoard.refreshPreview(p); TaskBoard.loadPreviewInput(p); return done; }, Sessions.refreshIntervalMs());
    await TaskBoard.loadPreviewPage(p);
  },

  /** The preview's top: the ticket's heading and its git branch. */
  previewHeadHtml(card) {
    const heading = card.title || (card.notes || '').trim().split('\n')[0];
    const gitBranch = TaskBoard.gitBranchOf(card);
    return `<div class="tb-preview-head"><div class="tb-preview-title">${TaskBoard.kindIconHtml(card)}${escapeHtml(heading)}</div>${
      gitBranch ? `<div class="tb-preview-branch">Branch: ${escapeHtml(gitBranch)}</div>` : ''}</div>`;
  },

  /** The preview's message box: sends to the ticket's session as it runs, hidden or not. */
  previewInputHtml() {
    return '<div class="tb-preview-input"><textarea class="session-input-text" rows="2" disabled ' +
      'placeholder="Message Claude — Enter to send, Shift+Enter for a new line"></textarea>' +
      '<div class="session-input-note"></div></div>';
  },

  previewSessionUrl(card) {
    return `/api/projects/${encodeURIComponent(card.sessionSlug || card.project)}/sessions/${encodeURIComponent(card.sessionId)}`;
  },

  async loadPreviewInput(p) {
    let data = { state: 'none', questions: [] };
    try { data = await api(TaskBoard.previewSessionUrl(p.card) + '/input-state'); } catch (_) {}
    if (TaskBoard._preview !== p) return;
    SessionQuestions.setHeld(TaskBoard.previewSessionUrl(p.card), data.questions);
    TaskBoard.applyPreviewQuestions(p);
    if (p.sending) return;
    TaskBoard.renderPreviewInput(p, data.state);
  },

  /** The preview's AskUserQuestion cards: answerable here while CM's question hook holds them. */
  applyPreviewQuestions(p) {
    if (p.list) SessionQuestions.apply(p.list, TaskBoard.previewSessionUrl(p.card), true);
  },

  renderPreviewInput(p, state) {
    p.inputState = state;
    const box = p.el.querySelector('.tb-preview-input');
    box.querySelector('textarea').disabled = state !== 'ready' && state !== 'busy';
    SessionInput.renderNote(box.querySelector('.session-input-note'), state);
  },

  onPreviewKeyDown(p, e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    TaskBoard.sendPreviewInput(p);
  },

  async sendPreviewInput(p) {
    const text = p.el.querySelector('.tb-preview-input textarea');
    const message = text.value;
    if (p.sending || (p.inputState !== 'ready' && p.inputState !== 'busy') || !message.trim()) return;
    p.sending = true;
    try {
      await api(TaskBoard.previewSessionUrl(p.card) + '/input', { method: 'POST', body: { text: message } });
      text.value = '';
      TaskBoard.followSent(p, p.total || 0, TaskBoard.PREVIEW_SENT_TRIES);
    } catch (e) {
      toast(e.message, 'error');
    }
    p.sending = false;
    TaskBoard.loadPreviewInput(p);
  },

  /** Beside the card: on its right when it fits, else on its left; kept inside the window. */
  placePreview(el, rect) {
    const gap = 8;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = rect.right + gap + w <= window.innerWidth ? rect.right + gap : Math.max(gap, rect.left - gap - w);
    const top = Math.max(gap, Math.min(rect.top, window.innerHeight - h - gap));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  },

  /** The next page of the ticket session's messages, newest first as in Session Details: older ones load while scrolling down. */
  async loadPreviewPage(p) {
    const { card, el, list } = p;
    const first = !p.offset;
    p.loading = true;
    if (!first) list.insertAdjacentHTML('beforeend', '<div class="loading tb-preview-loader"><div class="spinner"></div> Loading...</div>');
    let data = null;
    try {
      data = await api(`${TaskBoard.previewSessionUrl(card)}?offset=${p.offset}&limit=${TaskBoard.PREVIEW_MESSAGES}`);
    } catch (_) { /* shown below */ }
    if (TaskBoard._preview !== p) return;
    p.loading = false;
    const loader = list.querySelector('.tb-preview-loader');
    if (loader) loader.remove();
    if (!data) {
      p.hasMore = false;
      const failed = '<div class="empty-state"><p>Failed to load messages</p></div>';
      if (first) list.innerHTML = failed; else list.insertAdjacentHTML('beforeend', failed);
      return;
    }
    p.total = data.total;
    if (first && !data.total) { list.innerHTML = '<div class="empty-state"><p>No messages in this session</p></div>'; return; }
    const html = data.messages.map(m => Sessions.renderMessage(m)).join('');
    if (first) list.innerHTML = html; else list.insertAdjacentHTML('beforeend', html);
    p.shown = (first ? [] : p.shown).concat(data.messages);
    addCodeCopyButtons(list);
    TaskBoard.applyPreviewQuestions(p);
    p.offset += data.messages.length;
    p.hasMore = data.hasMore;
    el.onscroll(); // hidden tool lines can leave too little to scroll
  },

  /** Reload the newest messages already shown, so a sent message and Claude's replies appear while the preview is open. */
  async refreshPreview(p) {
    if (p.loading) return;
    p.loading = true;
    let data = null;
    try {
      data = await api(`${TaskBoard.previewSessionUrl(p.card)}?offset=0&limit=${Math.max(p.offset, TaskBoard.PREVIEW_MESSAGES)}`);
    } catch (_) { /* the next tick tries again */ }
    if (TaskBoard._preview !== p) return;
    p.loading = false;
    if (!data || !data.total) return;
    p.total = data.total;
    // Compared as data: rendered tool blocks carry random ids, and redrawing would collapse what the user opened.
    if (JSON.stringify(data.messages) !== JSON.stringify(p.shown)) {
      p.list.innerHTML = data.messages.map(m => Sessions.renderMessage(m)).join('');
      addCodeCopyButtons(p.list);
      TaskBoard.applyPreviewQuestions(p);
      p.shown = data.messages;
    }
    p.offset = data.messages.length;
    p.hasMore = data.hasMore;
    p.el.onscroll(); // a scroll to the end during the refresh was ignored
  },

  /** Claude Code logs a sent message a moment after it gets it: refresh shortly until it shows (or the tries run out). */
  followSent(p, before, tries) {
    TaskBoard.refreshPreview(p).then(() => {
      if (TaskBoard._preview !== p || p.total > before || tries <= 1) return;
      setTimeout(() => TaskBoard.followSent(p, before, tries - 1), TaskBoard.PREVIEW_SENT_RETRY_MS);
    });
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
    if (el) {
      // Keep each lane's horizontal scroll across re-renders
      const scroll = {};
      el.querySelectorAll('.tb-lane[data-lane]').forEach(lane => {
        const cols = lane.querySelector('.tb-cols');
        if (cols) scroll[lane.dataset.lane] = cols.scrollLeft;
      });
      el.innerHTML = TaskBoard.viewHtml(TaskBoard.board, TaskBoard.hidden(), TaskBoard.view());
      TaskBoard.checkPreview();
      el.querySelectorAll('.tb-lane[data-lane]').forEach(lane => {
        const cols = lane.querySelector('.tb-cols');
        if (cols && scroll[lane.dataset.lane]) cols.scrollLeft = scroll[lane.dataset.lane];
        TaskBoard.syncTopScroll(lane);
      });
      TaskBoard.observeLaneSizes(el);
    }
    const label = document.getElementById('task-board-view-label');
    if (label) label.textContent = TaskBoard.VIEWS.find(v => v.id === TaskBoard.view()).label;
  },

  /** Size the lane's top scrollbar to its columns, show it only when they overflow, and match their position. */
  syncTopScroll(lane) {
    const cols = lane.querySelector('.tb-cols');
    const top = lane.querySelector('.tb-cols-top');
    if (!cols || !top) return;
    top.firstElementChild.style.width = cols.scrollWidth + 'px';
    top.style.display = cols.scrollWidth > cols.clientWidth ? '' : 'none';
    top.scrollLeft = cols.scrollLeft;
  },

  /** The top scrollbar and the columns scroll together. */
  onColsScroll(el) {
    const lane = el.closest('.tb-lane');
    const other = lane && lane.querySelector(el.classList.contains('tb-cols-top') ? '.tb-cols' : '.tb-cols-top');
    // Tolerance: the two can differ by a fractional pixel, and echoing that back would clamp or jitter
    if (other && Math.abs(other.scrollLeft - el.scrollLeft) > 1) other.scrollLeft = el.scrollLeft;
  },

  /** Re-measure a lane's top scrollbar whenever its columns change width (window, sidebar, any layout change). */
  observeLaneSizes(el) {
    if (typeof ResizeObserver === 'undefined') return;
    if (!TaskBoard._laneResize) {
      TaskBoard._laneResize = new ResizeObserver(entries => entries.forEach(e => {
        const lane = e.target.closest('.tb-lane');
        if (lane) TaskBoard.syncTopScroll(lane);
      }));
    }
    TaskBoard._laneResize.disconnect();
    el.querySelectorAll('.tb-cols').forEach(cols => TaskBoard._laneResize.observe(cols));
  },

  /** The chosen view; before one was chosen, Compact unless the old Compact switch was turned off. */
  view() {
    try {
      const v = localStorage.getItem(TaskBoard.VIEW_KEY);
      if (TaskBoard.VIEWS.some(x => x.id === v)) return v;
      return localStorage.getItem(TaskBoard.COMPACT_KEY) !== '0' ? 'compact' : 'board';
    } catch (_) { return 'compact'; }
  },

  compact() {
    return TaskBoard.view() === 'compact';
  },

  setView(id) {
    document.querySelectorAll('.action-menu-panel.open').forEach(p => p.classList.remove('open'));
    try { localStorage.setItem(TaskBoard.VIEW_KEY, id); } catch (_) {}
    TaskBoard.hidePreview();
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

  /** All chip: shows every lane when any is hidden, else hides them all. */
  toggleAllLanes() {
    const keys = TaskBoard.laneKeys(TaskBoard.board);
    const hidden = TaskBoard.hidden();
    const next = keys.some(k => hidden.includes(k)) ? [] : keys;
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

  /** Ticket types the workflow's first stage recognises: tooltip and icon. */
  KIND_ICONS: {
    bug: { label: 'Bug', path: 'M8 1.5a2.5 2.5 0 0 1 2.45 2H11a.75.75 0 0 1 .53 1.28l-.6.6c.33.47.56 1 .66 1.62h1.66a.75.75 0 0 1 0 1.5h-1.6v1h1.6a.75.75 0 0 1 0 1.5h-1.83A4 4 0 0 1 4.58 11H2.75a.75.75 0 0 1 0-1.5h1.6v-1h-1.6a.75.75 0 0 1 0-1.5h1.66c.1-.61.33-1.15.66-1.62l-.6-.6A.75.75 0 0 1 5 3.5h.55A2.5 2.5 0 0 1 8 1.5Zm-.75 5v6.92a2.5 2.5 0 0 0 1.5 0V6.5Z' },
    feature: { label: 'Feature', path: 'M8 .75a.75.75 0 0 1 .7.48l1.6 4.17 4.17 1.6a.75.75 0 0 1 0 1.4l-4.17 1.6-1.6 4.17a.75.75 0 0 1-1.4 0l-1.6-4.17-4.17-1.6a.75.75 0 0 1 0-1.4l4.17-1.6 1.6-4.17A.75.75 0 0 1 8 .75Z' },
    question: { label: 'Question', path: 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0-8A2.75 2.75 0 0 0 5.25 6.25a.75.75 0 0 0 1.5 0 1.25 1.25 0 1 1 1.92 1.05c-.6.4-1.42 1-1.42 2.2a.75.75 0 0 0 1.5 0c0-.35.2-.55.75-.92A2.75 2.75 0 0 0 8 3.5Z' },
    other: { label: 'Other', path: 'M3.75 1h5.5L13 4.75v9.5A1.75 1.75 0 0 1 11.25 16h-7.5A1.75 1.75 0 0 1 2 14.25V2.75C2 1.78 2.78 1 3.75 1Zm0 1.5a.25.25 0 0 0-.25.25v11.5c0 .14.11.25.25.25h7.5c.14 0 .25-.11.25-.25V5.5H9.25a.75.75 0 0 1-.75-.75V2.5Z' }
  },

  /** The ticket type icon shown before its heading, once the workflow recognised it. */
  kindIconHtml(card) {
    const kind = TaskBoard.KIND_ICONS[card.kind];
    if (!kind) return '';
    return `<span class="tb-card-kind tb-card-kind--${card.kind}" title="${kind.label}" aria-label="${kind.label}"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="${kind.path}"/></svg></span>`;
  },

  /** Compact card: one line with the heading, and the current stage as dots (its name on hover). */
  lineCardHtml(card, heading, stages) {
    const at = stages ? stages.findIndex(s => s.id === card.column) : -1;
    const dots = at === -1 ? '' : `<span class="tb-line-steps" title="${escapeAttr(`${stages[at].title} (${at + 1}/${stages.length})`)}">${
      stages.map((s, i) => `<span class="tb-dot${i < at ? ' tb-step--done' : i === at ? ' tb-step--current' : ''}"></span>`).join('')
    }</span>`;
    return `<div class="tb-card tb-card--line${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openCard('${escapeAttr(card.id)}')">
        <span class="tb-line-text">${TaskBoard.kindIconHtml(card)}${escapeHtml(heading)}</span>
        ${TaskBoard.badgeHtml(card)}
        ${dots}
        ${TaskBoard.memoIconHtml(card)}
        ${TaskBoard.deleteIconHtml(card)}
      </div>`;
  },

  /**
   * To-dos button on a Finalize/Done card: a filled badge with the open count while any is unchecked,
   * done/total once all are checked, faint (shown on hover) when there are none.
   */
  memoIconHtml(card) {
    if (!TaskBoard.MEMO_COLUMNS.includes(card.column)) return '';
    const todos = card.todos || [];
    const open = todos.filter(t => !t.done).length;
    const count = open ? `<span class="tb-memo-count tb-memo-count--open">${open}</span>`
      : todos.length ? `<span class="tb-memo-count">${todos.length}/${todos.length}</span>` : '';
    const tip = open ? `${open} open to-do${open === 1 ? '' : 's'}` : todos.length ? 'All to-dos done' : 'Add to-dos';
    return `<button class="icon-btn tb-card-memo${todos.length ? ' tb-card-memo--has' : ''}${open ? ' tb-card-memo--open' : ''}" draggable="false" title="${escapeAttr(tip)}" aria-label="To-dos"
        onclick="event.stopPropagation(); TaskBoard.openMemo('${escapeAttr(card.id)}')"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.5 1.75v11.5c0 .14.11.25.25.25h3.17a.75.75 0 0 1 0 1.5H2.75A1.75 1.75 0 0 1 1 13.25V1.75C1 .78 1.78 0 2.75 0h8.5C12.22 0 13 .78 13 1.75v7.74a.75.75 0 0 1-1.5 0V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13.06 9.48-4.25 4.25a.75.75 0 0 1-1.06 0l-2.25-2.25a.75.75 0 1 1 1.06-1.06l1.72 1.72 3.72-3.72a.75.75 0 1 1 1.06 1.06ZM4 4.75A.75.75 0 0 1 4.75 4h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 4 4.75Zm0 3A.75.75 0 0 1 4.75 7h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 4 7.75Z"/></svg>${count}</button>`;
  },

  /** index: the to-do's place in the saved list; none for a row added in the dialog. */
  todoRowHtml(todo, index) {
    return `<div class="tb-todo-row"${Number.isInteger(index) ? ` data-index="${index}"` : ''}>
        <input type="checkbox" class="tb-todo-done"${todo.done ? ' checked' : ''}>
        <input type="text" class="tb-todo-text" maxlength="300" value="${escapeAttr(todo.text)}" placeholder="To-do">
        <button class="btn btn-sm" onclick="TaskBoard.todoToTicket(this)" title="Make a new ticket from this to-do" aria-label="Make a ticket">&rarr; Ticket</button>
        <button class="btn btn-sm" onclick="this.parentElement.remove()" title="Remove" aria-label="Remove to-do">&times;</button>
      </div>`;
  },

  /** Own to-do list on a Finalize/Done ticket — for the user only, never sent to Claude. */
  openMemo(id) {
    const card = TaskBoard.findCard(id);
    if (!card) return;
    const heading = card.title || (card.notes || '').trim().split('\n')[0];
    const body = `<div class="tb-editor-project" id="tb-memo-card" data-id="${escapeAttr(card.id)}">${escapeHtml(heading)}</div>`
      + formGroup('To-do', `<div id="tb-todos">${(card.todos || []).map((t, i) => TaskBoard.todoRowHtml(t, i)).join('')}</div>
          <button class="btn btn-sm" onclick="TaskBoard.addTodoRow()">+ To-do</button>`);
    openModal({ title: 'To-dos', width: 560, body, buttons: [{ label: 'Save', primary: true, onClick: () => TaskBoard.saveMemo(card.id) }] });
    if (!(card.todos || []).length) setTimeout(() => { if (document.getElementById('tb-todos')) TaskBoard.addTodoRow(); }, 0);
  },

  addTodoRow() {
    const list = document.getElementById('tb-todos');
    list.insertAdjacentHTML('beforeend', TaskBoard.todoRowHtml({ text: '', done: false }));
    list.lastElementChild.querySelector('.tb-todo-text').focus();
  },

  async saveMemo(id) {
    const todos = Array.from(document.querySelectorAll('#tb-todos .tb-todo-row')).map(row => ({
      text: row.querySelector('.tb-todo-text').value,
      done: row.querySelector('.tb-todo-done').checked
    }));
    try {
      await api('/api/task-board/cards/' + encodeURIComponent(id) + '/memo', { method: 'PUT', body: { todos } });
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    await TaskBoard.load();
  },

  /**
   * A to-do in the open To-dos dialog becomes a new ToDo ticket in the same project. A saved to-do is
   * first removed from the saved list (other unsaved edits in the dialog stay unsaved); the ticket is
   * created only once that succeeds, and the to-do is put back if creating fails.
   */
  async todoToTicket(btn) {
    const row = btn.closest('.tb-todo-row');
    const text = row.querySelector('.tb-todo-text').value.trim();
    const card = TaskBoard.findCard(document.getElementById('tb-memo-card').dataset.id);
    if (!text || !card || btn.disabled) return;
    btn.disabled = true;
    const url = '/api/task-board/cards/' + encodeURIComponent(card.id) + '/memo';
    const saved = card.todos || [];
    const index = row.dataset.index === undefined ? -1 : Number(row.dataset.index);
    try {
      if (index !== -1) await api(url, { method: 'PUT', body: { todos: saved.filter((t, i) => i !== index) } });
    } catch (e) {
      btn.disabled = false;
      toast(e.message, 'error');
      return;
    }
    try {
      await api('/api/task-board/cards', { method: 'POST', body: { project: card.project, notes: text } });
    } catch (e) {
      if (index !== -1) await api(url, { method: 'PUT', body: { todos: saved } }).catch(() => {});
      btn.disabled = false;
      toast(e.message, 'error');
      await TaskBoard.load();
      return;
    }
    row.remove();
    if (index !== -1) {
      document.querySelectorAll('#tb-todos .tb-todo-row[data-index]').forEach(r => {
        if (Number(r.dataset.index) > index) r.dataset.index = Number(r.dataset.index) - 1;
      });
    }
    toast('Ticket created in ToDo');
    await TaskBoard.load();
  },

  deleteIconHtml(card) {
    if (!TaskBoard.canDelete(card)) return '';
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
    const message = card.run && card.run.message && (TaskBoard.inWorkflow(card) || card.finalized) ? card.run.message : '';
    const branch = card.branch && TaskBoard.inWorkflow(card)
      ? `<div class="tb-card-branch" title="Condition taken after ${escapeAttr(card.branch.from)}">If ${escapeHtml(card.branch.when)}</div>` : '';
    const gitBranch = TaskBoard.gitBranchOf(card);
    return `<div class="tb-card${card.closed ? ' tb-card--closed' : ''}" draggable="true" data-id="${escapeAttr(card.id)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openCard('${escapeAttr(card.id)}')">
        ${TaskBoard.deleteIconHtml(card)}
        ${badge ? `<div class="tb-card-head">${badge}</div>` : ''}
        ${heading ? `<div class="tb-card-title" title="${escapeAttr(heading)}">${TaskBoard.kindIconHtml(card)}${escapeHtml(heading)}</div>` : ''}
        ${notes ? `<div class="tb-card-notes">${escapeHtml(notes)}</div>` : ''}
        ${gitBranch ? `<div class="tb-card-git" title="Ticket branch${card.baseBranch ? ', branched from ' + escapeAttr(card.baseBranch) : ''}">&#5833; ${escapeHtml(gitBranch)}${card.baseBranch ? ' &larr; ' + escapeHtml(card.baseBranch) : ''}</div>` : ''}
        ${TaskBoard.worktreeHtml(card)}
        ${branch}
        ${message ? `<div class="tb-card-run">${escapeHtml(message)}</div>` : ''}
        ${TaskBoard.memoIconHtml(card)}
      </div>`;
  },

  /** Switching the project branch is only safe while none of the lane's tickets sits between To Do and Done. */
  canSwitchBranch(cards) {
    return cards.every(c => c.column === 'todo' || c.column === 'done');
  },

  /** The lane's project branch, a button opening the git panel's branch picker for this project. */
  laneBranchHtml(key, projectBranch, cards) {
    const can = TaskBoard.canSwitchBranch(cards);
    const title = can
      ? 'Project branch: worktree tickets merge into it at Finalize. Click to switch branch'
      : "Finish or move the lane's tickets to To Do or Done to switch branch";
    const id = 'tb-branch-picker-' + key;
    return `<div class="git-menu tb-lane-branch git-branch-host">
        <button class="btn btn-sm tb-card-git tb-lane-git" title="${escapeAttr(title)}"${can ? '' : ' disabled'}
          onclick="TaskBoard.openBranchPicker('${escapeAttr(key)}')">&#5833; ${escapeHtml(projectBranch)} <span class="dd-arrow"></span></button>
        <div class="git-menu-panel git-branch-picker" id="${escapeAttr(id)}"></div>
      </div>`;
  },

  /** Opens the branch picker under a lane's branch; its uncommitted file count decides whether switching asks first. */
  async openBranchPicker(key) {
    if (GitBranchPicker.isOpenIn('tb-branch-picker-' + key)) return GitBranchPicker.close();
    const info = await GitApi.info(key) || {};
    const files = (info.files || []).length;
    GitBranchPicker.open({
      slug: key,
      panelId: 'tb-branch-picker-' + key,
      files: () => files,
      label: () => info.branch || '',
      checkout: async (name, remote, stash) => {
        await GitActions.checkoutIn(key, name, remote, stash);
        await TaskBoard.load();
      },
    });
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
    const projectBranch = (board.projectBranches || {})[key];
    const head = `<div class="tb-lane-head">
        <span class="tb-lane-name">${escapeHtml(decodeName(key))}</span>
        ${projectBranch ? TaskBoard.laneBranchHtml(key, projectBranch, cards) : ''}
        <span class="git-count-badge">${cards.length}</span>
        <button class="btn btn-sm tb-workflow-btn" onclick="TaskBoard.openWorkflow('${k}')">Workflow${stages.length ? ' · ' + stages.length : ''}</button>
        <div class="action-menu tb-new-session">
          <button class="btn btn-sm" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)">New Session <span class="dd-arrow"></span></button>
          <div class="action-menu-panel">
            <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.newSessionOS('${k}')">In OS terminal</button>
            <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.newSessionBrowser('${k}')">In browser terminal</button>
          </div>
        </div>
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
    return `<section class="tb-lane" data-lane="${escapeAttr(key)}">${head}`
      + '<div class="tb-cols-top" style="display:none" onscroll="TaskBoard.onColsScroll(this)"><div class="tb-cols-top-inner"></div></div>'
      + `<div class="tb-cols" style="--tb-cols:${columns.length}" onscroll="TaskBoard.onColsScroll(this)">${cols}</div></section>`;
  },

  /** The whole board: lane filter chips, then each visible lane. Pure, for tests. */
  html(board, hidden, compact) {
    const keys = TaskBoard.laneKeys(board);
    if (!keys.length) return '<div class="empty-state"><p>No tickets yet. Add a project lane to start.</p></div>';
    const lanes = keys.filter(k => !hidden.includes(k)).map(k => TaskBoard.laneHtml(board, k, compact)).join('');
    return `${TaskBoard.chipsHtml(keys, hidden)}${lanes || '<div class="empty-state"><p>All lanes are hidden.</p></div>'}`;
  },

  /** Lane filter chips; withAll adds an All chip first (active while no lane is hidden). */
  chipsHtml(keys, hidden, withAll) {
    const all = withAll
      ? `<button class="tb-chip tb-chip--all${keys.some(k => hidden.includes(k)) ? '' : ' active'}" onclick="TaskBoard.toggleAllLanes()">All</button>` : '';
    return `<div class="tb-chips">${all}${keys.map(k => `<button class="tb-chip${hidden.includes(k) ? '' : ' active'}" onclick="TaskBoard.toggleLaneVisible('${escapeAttr(k)}')">${escapeHtml(decodeName(k))}</button>`).join('')}</div>`;
  },

  /** The board in the chosen view: Board / Compact (Kanban), Pipeline (subway map) or Radar (one for the shown projects). Pure, for tests. */
  viewHtml(board, hidden, view) {
    if (view !== 'pipeline' && view !== 'radar') return TaskBoard.html(board, hidden, view === 'compact');
    const keys = TaskBoard.laneKeys(board);
    if (!keys.length) return TaskBoard.html(board, hidden);
    const shown = keys.filter(k => !hidden.includes(k));
    const body = !shown.length ? '<div class="empty-state"><p>All lanes are hidden.</p></div>'
      : view === 'radar' ? TaskBoard.radarHtml(board, shown) : shown.map(k => TaskBoard.pipelineLaneHtml(board, k)).join('');
    return TaskBoard.chipsHtml(keys, hidden, view === 'radar') + body;
  },

  /** A lane's stations in order: ToDo, Ready, its stages, Finalize, Done. */
  stations(board, key) {
    const stages = ((board.projects || {})[key] || {}).stages || [];
    const fixed = id => ({ id, title: TaskBoard.COLUMN_TITLES[id] });
    return [fixed('todo'), fixed('ready')]
      .concat(stages.map(s => ({ id: s.id, title: s.title || s.id, stage: s })), [fixed('finalize'), fixed('done')]);
  },

  /** What a ticket is doing, for its colour: closed, starting (Ready), a run status, ready (merge or PR), done or idle. */
  vizStatus(card) {
    if (card.closed) return 'closed';
    if (card.column === 'ready') return 'starting';
    if (card.finalized) return 'ready';
    const run = card.run || {};
    if (TaskBoard.inWorkflow(card) && TaskBoard.RUN_LABELS[run.status]) return run.status;
    return card.column === 'done' ? 'done' : 'idle';
  },

  vizAlert(status) {
    return status === 'needs_input' || status === 'conflict';
  },

  vizLive(cards) {
    return cards.some(c => ['starting', 'running'].includes(TaskBoard.vizStatus(c)) && c.column !== 'ready');
  },

  headingOf(card) {
    return card.title || (card.notes || '').trim().split('\n')[0];
  },

  /** Pipeline/Radar lane head: name, ticket count, Workflow and + Ticket. */
  vizHeadHtml(board, key, cards) {
    const k = escapeAttr(key);
    const stages = (board.projects[key].stages || []).length;
    return `<div class="tb-lane-head">
        <span class="tb-lane-name">${escapeHtml(decodeName(key))}</span>
        <span class="git-count-badge">${cards.length}</span>
        <button class="btn btn-sm tb-workflow-btn" onclick="TaskBoard.openWorkflow('${k}')">Workflow${stages ? ' · ' + stages : ''}</button>
        <button class="btn btn-sm" onclick="TaskBoard.openEditor(null, '${k}')">+ Ticket</button>
      </div>`;
  },

  PL_STATION_W: 150,

  /**
   * Pipeline view: the lane is a subway line, its stations ToDo → Ready → stages → Finalize → Done.
   * Condition branches and jumps arc over the line; a station glows while a ticket in it runs and
   * blinks while one waits for the user. Tickets are listed under their station.
   */
  pipelineLaneHtml(board, key) {
    const cards = (board.cards || []).filter(c => c.project === key);
    const stations = TaskBoard.stations(board, key);
    const W = TaskBoard.PL_STATION_W, Y = 46, n = stations.length;
    const x = i => i * W + W / 2;
    const index = id => stations.findIndex(s => s.id === (id === 'done' ? 'finalize' : id));
    const at = stations.map(s => cards.filter(c => c.column === s.id));
    const arcs = [];
    stations.forEach((s, i) => {
      if (!s.stage) return;
      const jumps = (s.stage.branches || []).map(b => ({ to: b.to, label: 'If ' + b.when }));
      if (s.stage.next && index(s.stage.next) !== i + 1) jumps.push({ to: s.stage.next, label: 'Next' });
      jumps.forEach(j => {
        const t = index(j.to);
        if (t === -1 || t === i) return;
        const h = Math.min(40, 16 + Math.abs(t - i) * 8);
        arcs.push(`<path class="tb-pl-arc" d="M${x(i)} ${Y} Q${(x(i) + x(t)) / 2} ${Y - h * 2} ${x(t)} ${Y}"><title>${escapeHtml(j.label)}</title></path>`);
      });
    });
    const dots = stations.map((s, i) => {
      const statuses = at[i].map(TaskBoard.vizStatus);
      const cls = statuses.some(TaskBoard.vizAlert) ? ' tb-pl-station--alert'
        : s.id !== 'ready' && statuses.some(st => st === 'running' || st === 'starting') ? ' tb-pl-station--live'
        : at[i].length ? ' tb-pl-station--busy' : '';
      return `<g class="tb-pl-station${s.stage ? ' tb-pl-station--stage' : ''}${cls}">
          <circle cx="${x(i)}" cy="${Y}" r="11"/>${at[i].length ? `<text x="${x(i)}" y="${Y + 4}" text-anchor="middle">${at[i].length}</text>` : ''}
        </g>`;
    }).join('');
    const svg = `<svg class="tb-pl-svg" width="${n * W}" height="${Y + 14}" viewBox="0 0 ${n * W} ${Y + 14}">
        <line class="tb-pl-track${TaskBoard.vizLive(cards) ? ' tb-pl-track--live' : ''}" x1="${x(0)}" y1="${Y}" x2="${x(n - 1)}" y2="${Y}"/>
        ${arcs.join('')}${dots}
      </svg>`;
    const cols = stations.map((s, i) => `<div class="tb-pl-col" data-lane="${escapeAttr(key)}" data-column="${escapeAttr(s.id)}"
          ondragover="TaskBoard.onDragOver(event)" ondragleave="TaskBoard.onDragLeave(event)" ondrop="TaskBoard.onDrop(event)">
        <div class="tb-pl-name" title="${escapeAttr(s.title)}">${escapeHtml(s.title)}</div>
        <div class="tb-pl-tickets">${at[i].map(c => TaskBoard.vizTicketHtml(c)).join('')}</div>
      </div>`).join('');
    const empty = n === 4 ? `<div class="tb-pl-empty">No workflow yet <button class="btn btn-sm" onclick="TaskBoard.openWorkflow('${escapeAttr(key)}')">Set up</button></div>` : '';
    return `<section class="tb-lane tb-pl-lane" data-lane="${escapeAttr(key)}">${TaskBoard.vizHeadHtml(board, key, cards)}${empty}
        <div class="tb-pl-scroll"><div class="tb-pl-map" style="width:${n * W}px">${svg}
          <div class="tb-pl-cols" style="grid-template-columns:repeat(${n}, ${W}px)">${cols}</div>
        </div></div></section>`;
  },

  /**
   * A ticket in the Pipeline view and the Radar legend: a status dot, its heading, the to-do and delete
   * icons; drag moves it, hover previews it, click opens it. tag: optional text after the heading (Radar).
   */
  vizTicketHtml(card, tag) {
    return `<div class="tb-viz-ticket tb-viz--${TaskBoard.vizStatus(card)}" draggable="true" data-id="${escapeAttr(card.id)}"
        ondragstart="TaskBoard.onDragStart(event)" ondragend="TaskBoard.onDragEnd(event)" onclick="TaskBoard.openCard('${escapeAttr(card.id)}')">
        <span class="tb-viz-dot"></span><span class="tb-viz-text">${TaskBoard.kindIconHtml(card)}${escapeHtml(TaskBoard.headingOf(card))}</span>
        ${tag ? `<span class="tb-viz-tag" title="${escapeAttr(tag)}">${escapeHtml(tag)}</span>` : ''}
        ${TaskBoard.memoIconHtml(card)}
        ${TaskBoard.deleteIconHtml(card)}
      </div>`;
  },

  RD_SIZE: 300,

  /**
   * Radar stations over the shown projects: ToDo, Ready, stage positions 1…N (N: the most stages any
   * project has), Finalize, Done. A position takes its stage's title when every project having it
   * agrees, else "Stage k". has(card): the ticket is at that station.
   */
  radarStations(board, keys) {
    const stagesOf = k => ((board.projects || {})[k] || {}).stages || [];
    const n = Math.max(0, ...keys.map(k => stagesOf(k).length));
    const fixed = id => ({ id, title: TaskBoard.COLUMN_TITLES[id], has: c => c.column === id });
    const positions = Array.from({ length: n }, (_, i) => {
      const titles = new Set(keys.filter(k => stagesOf(k)[i]).map(k => stagesOf(k)[i].title || stagesOf(k)[i].id));
      return {
        id: '', title: titles.size === 1 ? Array.from(titles)[0] : `Stage ${i + 1}`, stage: true,
        has: c => stagesOf(c.project).findIndex(s => s.id === c.column) === i
      };
    });
    return [fixed('todo'), fixed('ready')].concat(positions, [fixed('finalize'), fixed('done')]);
  },

  /**
   * Radar view: one disc for the shown projects. Rings from the outside in are ToDo, Ready, the stage
   * positions and Finalize; Done is the centre with its count. Tickets are dots on their ring, a waiting
   * one sends out a beacon, and a sweep turns while any ticket runs. The legend lists each station's
   * tickets (project, and stage when it differs from the row), to drag onto ToDo, Ready or Done.
   */
  radarHtml(board, keys) {
    const cards = (board.cards || []).filter(c => keys.includes(c.project));
    const stations = TaskBoard.radarStations(board, keys);
    const multi = keys.length > 1;
    const rings = stations.slice(0, -1);
    const S = TaskBoard.RD_SIZE, C = S / 2, R0 = 22, OUT = C - 8;
    const step = (OUT - R0) / rings.length;
    const r = k => R0 + (rings.length - k - 0.5) * step;
    const ringEls = rings.map((s, k) => `<circle class="tb-rd-ring${s.stage ? ' tb-rd-ring--stage' : ''}" cx="${C}" cy="${C}" r="${(r(k) + step / 2).toFixed(1)}"/>`).join('');
    const dots = rings.map((s, k) => {
      const list = cards.filter(s.has);
      return list.map((c, j) => {
        const a = -Math.PI / 2 + (j + 0.5) * 2 * Math.PI / list.length + k * 0.7;
        const cx = (C + Math.cos(a) * r(k)).toFixed(1), cy = (C + Math.sin(a) * r(k)).toFixed(1);
        const status = TaskBoard.vizStatus(c);
        return `<g class="tb-viz-ticket tb-viz--${status}" data-id="${escapeAttr(c.id)}" aria-label="${escapeAttr(TaskBoard.headingOf(c))}" onclick="TaskBoard.openCard('${escapeAttr(c.id)}')">
            ${TaskBoard.vizAlert(status) ? `<circle class="tb-rd-beacon" cx="${cx}" cy="${cy}" r="6"/>` : ''}<circle class="tb-rd-dot" cx="${cx}" cy="${cy}" r="6"/>
          </g>`;
      }).join('');
    }).join('');
    const tip = (C + Math.sin(0.5) * OUT).toFixed(1) + ' ' + (C - Math.cos(0.5) * OUT).toFixed(1);
    const sweep = TaskBoard.vizLive(cards)
      ? `<path class="tb-rd-sweep" style="transform-origin:${C}px ${C}px" d="M${C} ${C} L${C} ${C - OUT} A${OUT} ${OUT} 0 0 1 ${tip} Z"/>` : '';
    const done = cards.filter(c => c.column === 'done').length;
    const svg = `<svg class="tb-rd-svg" viewBox="0 0 ${S} ${S}">
        ${ringEls}${sweep}
        <circle class="tb-rd-core" cx="${C}" cy="${C}" r="${R0}"/>
        <text class="tb-rd-core-text" x="${C}" y="${C + 4}" text-anchor="middle">${done}</text>
        ${dots}
      </svg>`;
    const stageName = c => {
      const st = (((board.projects || {})[c.project] || {}).stages || []).find(x => x.id === c.column);
      return st ? st.title || st.id : '';
    };
    const legend = stations.map(s => {
      const list = cards.filter(s.has);
      const alert = list.some(c => TaskBoard.vizAlert(TaskBoard.vizStatus(c)));
      const drop = ['todo', 'ready', 'done'].includes(s.id)
        ? ` data-column="${s.id}" ondragover="TaskBoard.onDragOver(event)" ondragleave="TaskBoard.onDragLeave(event)" ondrop="TaskBoard.onDrop(event)"` : '';
      const tickets = list.map(c => {
        const stage = s.stage && stageName(c) !== s.title ? stageName(c) : '';
        return TaskBoard.vizTicketHtml(c, [multi ? decodeName(c.project) : '', stage].filter(Boolean).join(' · '));
      }).join('');
      return `<li class="${s.stage ? 'tb-rd-leg--stage' : ''}${alert ? ' tb-rd-leg--alert' : ''}"${drop}>
          <div class="tb-rd-leg-head"><span class="tb-rd-leg-name">${escapeHtml(s.title)}</span><span class="tb-col-count">${list.length}</span></div>
          ${tickets ? `<div class="tb-rd-leg-tickets">${tickets}</div>` : ''}
        </li>`;
    }).join('');
    const head = multi
      ? `<div class="tb-lane-head"><span class="tb-lane-name">${keys.length} projects</span><span class="git-count-badge">${cards.length}</span></div>`
      : TaskBoard.vizHeadHtml(board, keys[0], cards);
    return `<section class="tb-lane tb-rd-lane">${head}
        <div class="tb-rd-body">${svg}<ol class="tb-rd-legend" title="Rings from the outside in; Done is the centre">${legend}</ol></div></section>`;
  },

  findCard(id) {
    return TaskBoard.board.cards.find(c => c.id === id);
  },

  /**
   * New card (id null, optionally preset to a lane) or edit an existing one. followUp: the card was
   * just moved back from Done to ToDo, so ask what to change or follow up on, with its notes ready to edit.
   */
  openEditor(id, lane, followUp) {
    const card = id ? TaskBoard.findCard(id) : null;
    if (id && !card) return;
    if (!card && !(Projects.data || []).length) {
      toast('No projects found', 'error');
      return;
    }
    const projectField = card
      ? formGroup('Project', `<div class="tb-editor-project">${escapeHtml(decodeName(card.project))}</div>`)
        + (TaskBoard.gitBranchOf(card) ? formGroup('Branch', `<div class="tb-editor-project tb-card-git">${escapeHtml(TaskBoard.gitBranchOf(card))}${card.baseBranch ? ' &larr; ' + escapeHtml(card.baseBranch) : ''}</div>`) : '')
        + (card.prUrl ? formGroup('Pull request', `<div class="tb-editor-project"><a href="${escapeAttr(card.prUrl)}" target="_blank" rel="noopener">${escapeHtml(card.prUrl)}</a></div>`) : '')
      : formGroup('Project', Projects.selectHtml('tb-project', lane));
    const editable = !card || card.column === 'todo';
    const ro = editable ? '' : ' readonly';
    const question = followUp && editable
      ? '<p class="tb-editor-question">What should change? Edit the notes or add follow-up requirements/questions.</p>'
      : '';
    const body = question + projectField
      + formGroup('Title (optional)', `<input type="text" id="tb-title" value="${escapeAttr(card ? card.title : '')}"${ro}>`)
      + formGroup('Description / ticket number', `<textarea id="tb-notes" rows="8" placeholder="What Claude should do — this becomes your first message in the session"${ro}>${escapeHtml(card ? card.notes : '')}</textarea>`);
    const buttons = [];
    if (card && card.sessionId) {
      buttons.push({ label: 'Open session', onClick: () => TaskBoard.openSession(card) });
    }
    if (card && TaskBoard.inWorkflow(card)) {
      buttons.push({ label: 'Stop', danger: true, onClick: () => TaskBoard.stop(card.id) });
    }
    if (card && TaskBoard.canDelete(card)) {
      buttons.push({ label: 'Delete', danger: true, onClick: () => TaskBoard.confirmDelete(card.id) });
    }
    if (card && card.finalized) {
      buttons.push({ label: 'Create PR', onClick: () => TaskBoard.land(card.id, 'pr') });
      buttons.push({ label: 'Merge into ' + card.baseBranch, primary: true, onClick: () => TaskBoard.land(card.id, 'merge') });
    }
    if (editable) buttons.push({ label: card ? 'Save' : 'Add', primary: true, onClick: () => TaskBoard.save(card) });
    const title = !card ? 'New ticket' : !editable ? 'Ticket' : question ? 'Follow up ticket' : 'Edit ticket';
    openModal({ title, width: 560, body, buttons });
    if (editable) {
      setTimeout(() => {
        const t = document.getElementById('tb-notes');
        if (!t) return;
        t.focus();
        if (question) t.setSelectionRange(t.value.length, t.value.length);
      }, 0);
    }
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

  /** A Finalize ticket waiting on its branch: merge it into its base (action 'merge') or create a PR ('pr'). */
  async land(id, action) {
    try {
      await api('/api/task-board/cards/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
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
        if (res.warning) TaskBoard.offerForceRemove(res);
        await TaskBoard.load();
      } }]
    });
    return true;
  },

  /** The deleted ticket's worktree was kept ({ warning, project, worktree }): offer to force-remove it. */
  offerForceRemove({ warning, project, worktree }) {
    openModal({
      title: 'Worktree kept',
      body: `<p>${escapeHtml(warning)}</p><p>Force remove discards its uncommitted changes; its branch is kept.</p>`,
      buttons: [{ label: 'Force remove', danger: true, onClick: async () => {
        try {
          await api('/api/task-board/worktrees/force-remove', { method: 'POST', body: { project, worktree } });
        } catch (e) {
          toast(e.message, 'error');
        }
      } }]
    });
  },

  /** The worktree ticket's uncommitted files and commits not yet in its base; a click opens the worktree's git panel. */
  worktreeHtml(card) {
    if (!card.worktree) return '';
    const st = (TaskBoard.board.worktreeStatus || {})[card.id];
    const html = worktreeChangesHtml(st, { slug: card.project + '--claude-worktrees-' + card.worktree });
    return html ? `<div class="tb-card-wt">${html}</div>` : '';
  },

  /** The ticket's own branch once it has a worktree (named when the worktree was created). */
  gitBranchOf(card) {
    return card.gitBranch || (card.worktree ? 'worktree-' + card.worktree : '');
  },

  /** A ticket with a worktree takes its worktree with it; its branch and session always stay. */
  deleteMessageHtml(card) {
    const worktree = card.worktree
      ? ` Its worktree <code>.claude/worktrees/${escapeHtml(card.worktree)}</code> is removed; branch <code>${escapeHtml(TaskBoard.gitBranchOf(card))}</code> is kept.`
        + ' If the worktree has uncommitted changes, it is kept and you can force-remove it, which discards them.'
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
    TaskBoard._wf = Object.assign({ slug, diff: false }, data, { stages: JSON.parse(JSON.stringify(data.stages)) });
    TaskBoardFlow.prepare(TaskBoard._wf);
    TaskBoardFlow._zoom = 1;
    openModal({
      title: 'Workflow — ' + decodeName(slug),
      width: 1040,
      maximizable: true,
      headerHtml: TaskBoardFlow.helpIconHtml(),
      body: '<div id="tb-wf"></div>',
      buttons: [{ label: 'Save', primary: true, onClick: () => TaskBoard.saveWorkflow() }],
      onClose: () => { TaskBoard._wf = null; }
    });
    TaskBoard.renderWorkflow();
  },

  renderWorkflow() {
    const el = document.getElementById('tb-wf');
    if (!el || !TaskBoard._wf) return;
    el.innerHTML = TaskBoard.workflowHtml(TaskBoard._wf);
    TaskBoardFlow.bind();
  },

  stageLabel(s) {
    return s.type === 'prompt' || s.type === 'workflow' ? s.type + ': ' + s.prompt.split('\n')[0] : s.type + ': ' + s.ref;
  },

  refOptions(available, stage) {
    const list = available.filter(a => a.kind === stage.type)
      .map(a => [a.name, a.name + ' · ' + a.source]);
    if (stage.ref && !list.some(([v]) => v === stage.ref)) list.unshift([stage.ref, stage.ref + ' (missing)']);
    return list;
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

  /** The editor body: skill-change banner or diff, the toolbar and the diagram. Pure, for tests. */
  workflowHtml(wf) {
    let top = '';
    if (wf.diff) top = TaskBoard.diffHtml(wf);
    else if (wf.skillsChanged) {
      top = `<div class="tb-wf-banner">Skills or agents in this project changed since the workflow was saved.
          <button class="btn btn-sm" onclick="TaskBoard.wfShowDiff()">Compare with recommended</button></div>`;
    }
    const empty = wf.stages.length ? '' : '<div class="tb-col-empty">No stages yet — use Recommend, or add a stage.</div>';
    return `${top}
      <div class="tb-wf-footer">
        <button class="btn btn-sm" onclick="TaskBoard.wfAdd()"${wf.stages.length >= 10 ? ' disabled' : ''}>+ Add stage</button>
        <button class="btn btn-sm" onclick="TaskBoard.wfRecommend()" title="Pick stages from this project's skills by name and description — no AI">Recommend</button>
        <button class="btn btn-sm" onclick="TaskBoard.wfLayout()" title="Arrange the stages from left to right">Auto-layout</button>
        ${TaskBoard.savedMenuHtml(wf)}
        <button class="btn btn-sm" onclick="TaskBoard.wfExport()" title="Download the stages as a JSON file">Export</button>
        <button class="btn btn-sm" onclick="document.getElementById('tb-wf-file').click()" title="Load stages from an exported JSON file">Import</button>
        <input type="file" id="tb-wf-file" accept=".json,application/json" hidden onchange="TaskBoard.wfImportFile(this)">
        ${TaskBoardFlow.zoomHtml()}
      </div>
      ${empty}
      <div class="tbf">
        <div class="tbf-canvas" id="tbf-canvas">${TaskBoardFlow.svgHtml(wf, null)}</div>
        <div class="tbf-panel" id="tbf-panel">${TaskBoardFlow.panelHtml(wf)}</div>
      </div>`;
  },

  /** Whether two stage lists are the same workflow; box positions are ignored. Pure, for tests. */
  sameStages(a, b) {
    const key = stages => JSON.stringify((stages || []).map(s => [s.id, s.title, s.type, s.ref, s.prompt, s.next, s.branches || []]));
    return key(a) === key(b);
  },

  /** Index of the saved workflow the editor's stages match, or -1. */
  activeSavedIndex(wf) {
    return (wf.saved || []).findIndex(w => TaskBoard.sameStages(w.stages, wf.stages));
  },

  /** The Saved dropdown: named workflows of this project to load or delete, and Save as. */
  savedMenuHtml(wf) {
    const saved = wf.saved || [];
    const active = TaskBoard.activeSavedIndex(wf);
    const rows = saved.length
      ? saved.map((w, i) => `<div class="tb-wf-saved-row${i === active ? ' active' : ''}"${i === active ? ' aria-current="true"' : ''}>
          <button class="action-menu-item" onclick="TaskBoard.wfLoad(${i})" title="${i === active ? 'In use' : 'Load into the editor'}">${i === active ? '&#10003; ' : ''}${escapeHtml(w.name)}</button>
          <button class="btn btn-sm" onclick="TaskBoard.wfDeleteSaved(${i})" title="Delete" aria-label="Delete ${escapeAttr(w.name)}">&times;</button>
        </div>`).join('')
      : '<div class="tb-wf-dim tb-wf-saved-empty">No saved workflows</div>';
    return `<div class="action-menu" id="tb-wf-saved-menu" data-active="${active}">
        <button class="btn btn-sm" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)">Saved${active >= 0 ? ': ' + escapeHtml(saved[active].name) : saved.length ? ' · ' + saved.length : ''} <span class="dd-arrow"></span></button>
        <div class="action-menu-panel tb-wf-saved" onclick="event.stopPropagation()">
          ${rows}
          <div class="tb-wf-save-as">
            <input type="text" id="tb-wf-name" placeholder="Name" maxlength="60" aria-label="Workflow name">
            <button class="btn btn-sm" onclick="TaskBoard.wfSaveAs()">Save as</button>
          </div>
        </div>
      </div>`;
  },

  /** Redraw the Saved menu when diagram edits change which saved workflow the stages match. */
  renderSavedMenu() {
    const el = document.getElementById('tb-wf-saved-menu');
    const wf = TaskBoard._wf;
    if (el && wf && el.dataset.active !== String(TaskBoard.activeSavedIndex(wf))) el.outerHTML = TaskBoard.savedMenuHtml(wf);
  },

  /** Saved or imported stages replace the editor's, checked by the server; Save keeps them. */
  async wfApply(stages, message) {
    const wf = TaskBoard._wf;
    let data;
    try {
      data = await api('/api/task-board/lanes/' + encodeURIComponent(wf.slug) + '/workflow/check', { method: 'POST', body: { stages } });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    wf.stages = data.stages;
    wf.missing = data.missing;
    TaskBoardFlow.prepare(wf);
    TaskBoard.renderWorkflow();
    toast(message);
  },

  wfLoad(i) {
    const w = TaskBoard._wf.saved[i];
    TaskBoard.wfApply(w.stages, `"${w.name}" loaded — review it and Save`);
  },

  async wfSaveAs() {
    const wf = TaskBoard._wf;
    const name = document.getElementById('tb-wf-name').value;
    try {
      wf.saved = (await api('/api/task-board/lanes/' + encodeURIComponent(wf.slug) + '/workflows', { method: 'POST', body: { name, stages: wf.stages } })).saved;
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    TaskBoard.renderWorkflow();
    toast(`Saved as "${name.trim()}"`);
  },

  async wfDeleteSaved(i) {
    const wf = TaskBoard._wf;
    const name = wf.saved[i].name;
    try {
      wf.saved = (await api('/api/task-board/lanes/' + encodeURIComponent(wf.slug) + '/workflows/' + encodeURIComponent(name), { method: 'DELETE' })).saved;
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    TaskBoard.renderWorkflow();
    toast(`"${name}" deleted`);
  },

  /** What Export downloads and Import reads. Pure, for tests. */
  exportData(wf) {
    return { name: decodeName(wf.slug), stages: wf.stages.map(({ id, title, type, ref, prompt, next, branches, pos }) => ({ id, title, type, ref, prompt, next, branches, pos })) };
  },

  wfExport() {
    const data = TaskBoard.exportData(TaskBoard._wf);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = data.name.replace(/[^\w.-]+/g, '-') + '-workflow.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  async wfImportFile(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      toast('Not a workflow file', 'error');
      return;
    }
    const stages = data && Array.isArray(data.stages) ? data.stages : null;
    if (!stages) {
      toast('Not a workflow file', 'error');
      return;
    }
    TaskBoard.wfApply(stages, 'Workflow imported — review it and Save');
  },

  /** A new stage gets its id here, so arrows can point at it before the workflow is saved. */
  newStageId() {
    return 's-' + (Math.random().toString(36).slice(2) + '00000000').slice(0, 8);
  },

  wfAdd() {
    TaskBoardFlow.newStage(TaskBoard._wf, TaskBoard.newStageId());
    TaskBoard.renderWorkflow();
  },

  wfLayout() {
    TaskBoardFlow.layout(TaskBoard._wf);
    TaskBoard.renderWorkflow();
  },

  /** Recommended stages in a row, each leading to the next, the last to Done. */
  wfRecommend() {
    const wf = TaskBoard._wf;
    wf.stages = wf.recommended.map(s => Object.assign({ id: TaskBoard.newStageId() }, s));
    TaskBoardFlow.prepare(wf);
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
    const free = slug => !taken.includes(slug) && !slug.includes('--claude-worktrees-');
    if (!(Projects.data || []).some(p => free(p.slug))) {
      toast('Every project already has a lane', 'error');
      return;
    }
    openModal({
      title: 'Add project lane',
      body: formGroup('Project', Projects.selectHtml('tb-lane-project', null, { filter: free })),
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
    TaskBoard.hidePreview();
    const el = e.target.closest(TaskBoard.CARD_SEL);
    TaskBoard._drag = el ? TaskBoard.findCard(el.dataset.id) : null;
    if (!TaskBoard._drag) return;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', TaskBoard._drag.id); } catch (_) {}
    el.classList.add('tb-card--dragging');
  },

  onDragEnd(e) {
    const el = e.target.closest(TaskBoard.CARD_SEL);
    if (el) el.classList.remove('tb-card--dragging');
    document.querySelectorAll('.tb-col--over').forEach(c => c.classList.remove('tb-col--over'));
    TaskBoard._drag = null;
  },

  dropAllowed(col) {
    const card = TaskBoard._drag;
    // Radar legend rows span projects and carry no lane
    return !!card && (!col.dataset.lane || card.project === col.dataset.lane) && TaskBoard.canMove(card, col.dataset.column);
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

  /** Index among the column's cards of the dragged ticket's project to insert before: the first card whose middle is below the pointer. */
  dropIndex(col, clientY) {
    const drag = TaskBoard._drag;
    const cards = Array.from(col.querySelectorAll(TaskBoard.CARD_SEL)).filter(c => !drag
      || (c.dataset.id !== drag.id && (TaskBoard.findCard(c.dataset.id) || {}).project === drag.project));
    const i = cards.findIndex(c => { const r = c.getBoundingClientRect(); return clientY < r.top + r.height / 2; });
    return i === -1 ? cards.length : i;
  },

  async onDrop(e) {
    const col = e.currentTarget;
    col.classList.remove('tb-col--over');
    if (!TaskBoard.dropAllowed(col)) return;
    e.preventDefault();
    const card = TaskBoard._drag;
    const from = card.column;
    const index = TaskBoard.dropIndex(col, e.clientY);
    let moved = false;
    try {
      await api('/api/task-board/cards/' + encodeURIComponent(card.id) + '/move', { method: 'POST', body: { column: col.dataset.column, index } });
      moved = true;
    } catch (err) {
      toast(err.message, 'error');
    }
    await TaskBoard.load();
    if (moved && from === 'done' && col.dataset.column === 'todo') TaskBoard.openEditor(card.id, null, true);
  }
};

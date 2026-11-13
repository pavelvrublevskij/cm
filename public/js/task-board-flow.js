// Task Board workflow diagram: stages as boxes between the fixed Ready and Done nodes, arrows for
// what comes next. Each stage has one default arrow (next) and up to 4 condition arrows (branches);
// the first stage is the one Ready points at. Works on TaskBoard._wf; the render functions are pure.

const TaskBoardFlow = {
  W: 150,
  H: 46,
  READY: { x: 20, y: 150 },
  STEP_X: 190,
  STEP_Y: 80,
  MAX_BRANCHES: 4,

  _drag: null,

  // --- Model ---

  /** Fill what an older workflow lacks: default arrows along the list, and box positions. */
  prepare(wf) {
    wf.stages.forEach((s, i) => {
      if (s.next === undefined || s.next === null) s.next = i === wf.stages.length - 1 ? 'done' : wf.stages[i + 1].id;
      s.branches = s.branches || [];
    });
    if (wf.stages.some(s => !s.pos)) TaskBoardFlow.layout(wf);
    wf.sel = null;
  },

  /** Columns by distance from Ready (default arrows first), stacked around Ready's height. */
  layout(wf) {
    const byId = new Map(wf.stages.map(s => [s.id, s]));
    const level = new Map();
    const queue = wf.stages.length ? [wf.stages[0].id] : [];
    if (queue.length) level.set(queue[0], 1);
    while (queue.length) {
      const s = byId.get(queue.shift());
      for (const to of [s.next, ...s.branches.map(b => b.to)]) {
        if (byId.has(to) && !level.has(to)) { level.set(to, level.get(s.id) + 1); queue.push(to); }
      }
    }
    const last = Math.max(0, ...level.values());
    for (const s of wf.stages) if (!level.has(s.id)) level.set(s.id, last + 1);
    const columns = new Map();
    for (const s of wf.stages) {
      const l = level.get(s.id);
      if (!columns.has(l)) columns.set(l, []);
      columns.get(l).push(s);
    }
    const F = TaskBoardFlow;
    for (const [l, list] of columns) {
      list.forEach((s, k) => {
        s.pos = { x: F.READY.x + l * F.STEP_X, y: Math.max(20, F.READY.y - (list.length - 1) * F.STEP_Y / 2 + k * F.STEP_Y) };
      });
    }
  },

  /** Ready, the stages and Done as boxes: { id, x, y, kind }. Done sits right of the rightmost stage. */
  nodes(wf) {
    const F = TaskBoardFlow;
    const right = Math.max(F.READY.x, ...wf.stages.map(s => s.pos.x));
    return [{ id: 'ready', kind: 'ready', x: F.READY.x, y: F.READY.y }]
      .concat(wf.stages.map(s => ({ id: s.id, kind: 'stage', x: s.pos.x, y: s.pos.y, stage: s })))
      .concat([{ id: 'done', kind: 'done', x: right + F.STEP_X, y: F.READY.y }]);
  },

  /** Every arrow: { key, from, to, kind: start|next|branch, j, label }. */
  edges(wf) {
    const out = [];
    if (wf.stages.length) out.push({ key: 'ready|start', from: 'ready', to: wf.stages[0].id, kind: 'start', label: '' });
    for (const s of wf.stages) {
      if (s.next) out.push({ key: s.id + '|next', from: s.id, to: s.next, kind: 'next', label: s.branches.length ? 'otherwise' : '' });
      s.branches.forEach((b, j) => out.push({ key: s.id + '|' + j, from: s.id, to: b.to, kind: 'branch', j, label: b.when || 'condition?' }));
    }
    return out;
  },

  edgeOf(wf, key) {
    return TaskBoardFlow.edges(wf).find(e => e.key === key) || null;
  },

  stageById(wf, id) {
    return wf.stages.find(s => s.id === id) || null;
  },

  /**
   * Arrow dropped from one box on another: Ready → the stage becomes the first; a stage without a
   * default arrow gets it; otherwise it is a new condition (selected, so its text can be typed).
   */
  connect(wf, from, to) {
    if (to === 'ready' || from === 'done') return false;
    if (from === 'ready') {
      if (to === 'done') return false;
      const i = wf.stages.findIndex(s => s.id === to);
      wf.stages.unshift(wf.stages.splice(i, 1)[0]);
      wf.sel = { edge: 'ready|start' };
      return true;
    }
    const s = TaskBoardFlow.stageById(wf, from);
    if (!s.next) {
      s.next = to;
      wf.sel = { edge: s.id + '|next' };
      return true;
    }
    if (s.branches.length >= TaskBoardFlow.MAX_BRANCHES) return 'limit';
    s.branches.push({ when: '', to });
    wf.sel = { edge: s.id + '|' + (s.branches.length - 1) };
    return true;
  },

  /** Arrows into a removed stage go with it; a default arrow into it is left to be drawn again. */
  removeStage(wf, id) {
    wf.stages = wf.stages.filter(s => s.id !== id);
    for (const s of wf.stages) {
      if (s.next === id) s.next = '';
      s.branches = s.branches.filter(b => b.to !== id);
    }
    wf.sel = null;
  },

  removeEdge(wf, key) {
    const e = TaskBoardFlow.edgeOf(wf, key);
    if (!e || e.kind === 'start') return;
    const s = TaskBoardFlow.stageById(wf, e.from);
    if (e.kind === 'next') s.next = '';
    else s.branches.splice(e.j, 1);
    wf.sel = null;
  },

  /** A condition becomes the default arrow; the old default takes over its condition text. */
  makeDefault(wf, key) {
    const e = TaskBoardFlow.edgeOf(wf, key);
    if (!e || e.kind !== 'branch') return;
    const s = TaskBoardFlow.stageById(wf, e.from);
    const b = s.branches[e.j];
    const old = s.next;
    s.next = b.to;
    if (old) s.branches[e.j] = { when: b.when, to: old };
    else s.branches.splice(e.j, 1);
    wf.sel = { edge: s.id + '|next' };
  },

  setTarget(wf, key, to) {
    const e = TaskBoardFlow.edgeOf(wf, key);
    if (!e) return;
    if (e.kind === 'start') { TaskBoardFlow.connect(wf, 'ready', to); return; }
    const s = TaskBoardFlow.stageById(wf, e.from);
    if (e.kind === 'next') s.next = to;
    else s.branches[e.j].to = to;
  },

  newStage(wf, id) {
    const F = TaskBoardFlow;
    const bottom = Math.max(F.READY.y - F.STEP_Y, ...wf.stages.map(s => s.pos.y));
    const s = { id, title: '', type: 'prompt', ref: '', prompt: '', next: wf.stages.length ? '' : 'done', branches: [],
      pos: { x: F.READY.x + F.STEP_X, y: bottom + F.STEP_Y } };
    wf.stages.push(s);
    wf.sel = { node: id };
    return s;
  },

  // --- Rendering ---

  short(text, n) {
    return text.length > n ? text.slice(0, n - 1) + '…' : text;
  },

  /** Cubic bezier for one arrow; parallel arrows between the same boxes bend apart by `off`. */
  edgePath(a, b, off) {
    const { W, H } = TaskBoardFlow;
    let p;
    if (a === b) {
      const lift = 55 + off * 22;
      p = [[a.x + W * 0.7, a.y], [a.x + W * 0.85, a.y - lift], [a.x + W * 0.15, a.y - lift], [a.x + W * 0.3, a.y]];
    } else if (b.x >= a.x + W + 20) {
      const s = [a.x + W, a.y + H / 2];
      const e = [b.x, b.y + H / 2];
      const dx = (e[0] - s[0]) / 2;
      const bend = off * 34;
      p = [s, [s[0] + dx, s[1] + bend], [e[0] - dx, e[1] + bend], e];
    } else if (Math.abs(a.x - b.x) < W && Math.abs(a.y - b.y) >= H + 20) {
      const down = b.y > a.y;
      const s = [a.x + W / 2 + off * 16, down ? a.y + H : a.y];
      const e = [b.x + W / 2 + off * 16, down ? b.y : b.y + H];
      const dy = (e[1] - s[1]) / 2;
      p = [s, [s[0] + off * 30, s[1] + dy], [e[0] + off * 30, e[1] - dy], e];
    } else {
      const top = Math.min(a.y, b.y) - 50 - off * 26;
      p = [[a.x + W / 2, a.y], [a.x + W / 2, top], [b.x + W / 2, top], [b.x + W / 2, b.y]];
    }
    const d = `M${p[0][0]},${p[0][1]} C${p[1][0]},${p[1][1]} ${p[2][0]},${p[2][1]} ${p[3][0]},${p[3][1]}`;
    const mid = i => (p[0][i] + 3 * p[1][i] + 3 * p[2][i] + p[3][i]) / 8;
    return { d, lx: mid(0), ly: mid(1) };
  },

  edgesSvg(wf, nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const seen = new Map();
    const sel = wf.sel && wf.sel.edge;
    return TaskBoardFlow.edges(wf).map(e => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return '';
      const pair = [e.from, e.to].sort().join('>');
      const off = seen.get(pair) || 0;
      seen.set(pair, off + 1);
      const { d, lx, ly } = TaskBoardFlow.edgePath(a, b, off);
      const cls = 'tbf-edge tbf-edge--' + e.kind + (e.key === sel ? ' tbf-edge--sel' : '');
      const label = e.label
        ? `<text class="tbf-label${e.kind === 'next' ? ' tbf-label--dim' : ''}" x="${lx}" y="${ly + 4}" text-anchor="middle">${escapeHtml(TaskBoardFlow.short(e.label, 26))}<title>${escapeHtml(e.label)}</title></text>`
        : '';
      return `<g class="${cls}" data-edge="${escapeAttr(e.key)}">
          <path class="tbf-edge-hit" d="${d}"/>
          <path class="tbf-edge-line" d="${d}" marker-end="url(#tbf-arrow${e.key === sel ? '-sel' : ''})"/>
          ${label}
        </g>`;
    }).join('');
  },

  nodeSvg(wf, n) {
    const { W, H } = TaskBoardFlow;
    const handle = n.kind === 'done' ? '' : `<circle class="tbf-handle" data-handle="${escapeAttr(n.id)}" cx="${W}" cy="${H / 2}" r="6"><title>Drag to another box to draw an arrow</title></circle>`;
    if (n.kind !== 'stage') {
      const label = n.kind === 'ready' ? 'Ready' : 'Done';
      return `<g class="tbf-node tbf-node--${n.kind}" data-node="${n.id}" transform="translate(${n.x},${n.y})">
          <rect width="${W}" height="${H}" rx="${H / 2}"/>
          <text class="tbf-title" x="${W / 2}" y="${H / 2 + 5}" text-anchor="middle">${label}</text>
          ${handle}
        </g>`;
    }
    const s = n.stage;
    const missing = (wf.missing || []).includes(s.id);
    const cls = 'tbf-node tbf-node--stage'
      + (wf.sel && wf.sel.node === s.id ? ' tbf-node--sel' : '')
      + (missing ? ' tbf-node--missing' : '')
      + (!s.next ? ' tbf-node--open' : '');
    const tip = !s.next ? 'No default arrow yet — drag from the dot to the stage that comes next' : s.title;
    return `<g class="${cls}" data-node="${escapeAttr(s.id)}" transform="translate(${n.x},${n.y})">
        <rect width="${W}" height="${H}" rx="6"/>
        <text class="tbf-title" x="10" y="19">${escapeHtml(TaskBoardFlow.short(s.title || 'Untitled', 19))}</text>
        <text class="tbf-sub" x="10" y="36">${escapeHtml(TaskBoardFlow.short(TaskBoard.stageLabel(s), 24))}</text>
        <title>${escapeHtml(tip)}</title>
        ${handle}
      </g>`;
  },

  /** The whole diagram, plus the arrow being drawn while connecting. */
  svgHtml(wf, drag) {
    const { W, H } = TaskBoardFlow;
    const nodes = TaskBoardFlow.nodes(wf);
    const width = Math.max(...nodes.map(n => n.x)) + W + 30;
    const height = Math.max(320, ...nodes.map(n => n.y)) + H + 40;
    let temp = '';
    if (drag && drag.kind === 'connect') {
      const a = nodes.find(n => n.id === drag.from);
      temp = `<path class="tbf-temp" d="M${a.x + W},${a.y + H / 2} L${drag.x},${drag.y}" marker-end="url(#tbf-arrow-sel)"/>`;
    }
    return `<svg class="tbf-svg" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="tbf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="tbf-arrowhead" d="M0,0 L10,5 L0,10 z"/></marker>
          <marker id="tbf-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="tbf-arrowhead tbf-arrowhead--sel" d="M0,0 L10,5 L0,10 z"/></marker>
        </defs>
        ${TaskBoardFlow.edgesSvg(wf, nodes)}
        ${nodes.map(n => TaskBoardFlow.nodeSvg(wf, n)).join('')}
        ${temp}
      </svg>`;
  },

  targetOptions(wf, selected, withDone) {
    const list = wf.stages.map(s => [s.id, s.title || 'Untitled']);
    if (withDone) list.push(['done', 'Done']);
    return list.map(([v, label]) => `<option value="${escapeAttr(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  },

  /** Side panel: the selected stage's fields, the selected arrow, or how to use the diagram. */
  panelHtml(wf) {
    const sel = wf.sel || {};
    if (sel.node) {
      const s = TaskBoardFlow.stageById(wf, sel.node);
      if (s) return TaskBoardFlow.stagePanelHtml(wf, s);
    }
    if (sel.edge) {
      const e = TaskBoardFlow.edgeOf(wf, sel.edge);
      if (e) return TaskBoardFlow.edgePanelHtml(wf, e);
    }
    return `<div class="tbf-help">
        <p><strong>Click</strong> a stage to edit it, or an arrow to set its condition.</p>
        <p><strong>Drag</strong> a stage to move it. Drag from the <span class="tbf-dot"></span> on its right edge to another stage or Done to draw an arrow.</p>
        <p>The first arrow out of a stage is its default path; more arrows are conditions Claude checks when the stage is done. One ticket runs the same stage at most 3 times.</p>
        <p>An arrow into Done goes through Finalize first: the tests run, and a worktree ticket commits and merges in its branch.</p>
      </div>`;
  },

  stagePanelHtml(wf, s) {
    const id = escapeAttr(s.id);
    const missing = (wf.missing || []).includes(s.id);
    const types = [['skill', 'Skill'], ['agent', 'Agent'], ['prompt', 'Prompt']]
      .map(([v, label]) => `<option value="${v}"${v === s.type ? ' selected' : ''}>${label}</option>`).join('');
    const ref = s.type === 'prompt' ? '' : `<label class="tbf-field">${s.type === 'skill' ? 'Skill' : 'Agent'}
        <select class="${missing ? 'tb-wf-ref--missing' : ''}" onchange="TaskBoardFlow.setStage('${id}', 'ref', this.value)">${
          TaskBoard.refOptions(wf.available, s).map(([v, label]) => `<option value="${escapeAttr(v)}"${v === s.ref ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')
        }</select></label>`;
    return `<div class="tbf-form">
        <label class="tbf-field">Stage name
          <input type="text" value="${escapeAttr(s.title)}" maxlength="40" placeholder="e.g. Plan" oninput="TaskBoardFlow.setStage('${id}', 'title', this.value, true)"></label>
        <label class="tbf-field">Type
          <select onchange="TaskBoardFlow.setStage('${id}', 'type', this.value)">${types}</select></label>
        ${ref}
        <label class="tbf-field">${s.type === 'prompt' ? 'What Claude should do' : 'Extra instructions (optional)'}
          <textarea rows="5" oninput="TaskBoardFlow.setStage('${id}', 'prompt', this.value, true)">${escapeHtml(s.prompt)}</textarea></label>
        ${!s.next ? '<div class="tbf-warn">Draw its default arrow: drag from the dot on its right edge.</div>' : ''}
        <button class="btn btn-sm btn-danger" onclick="TaskBoardFlow.act('removeStage', '${id}')">Delete stage</button>
      </div>`;
  },

  edgePanelHtml(wf, e) {
    const key = escapeAttr(e.key);
    const from = e.from === 'ready' ? 'Ready' : (TaskBoardFlow.stageById(wf, e.from).title || 'Untitled');
    const target = `<label class="tbf-field">Goes to
        <select onchange="TaskBoardFlow.retarget('${key}', this.value)">${TaskBoardFlow.targetOptions(wf, e.to, e.kind !== 'start')}</select></label>`;
    if (e.kind === 'start') {
      return `<div class="tbf-form"><div class="tbf-head">From <strong>Ready</strong></div>${target}
          <div class="tb-wf-dim">The first stage a ticket runs.</div></div>`;
    }
    if (e.kind === 'next') {
      return `<div class="tbf-form"><div class="tbf-head">Default path from <strong>${escapeHtml(from)}</strong></div>${target}
          <div class="tb-wf-dim">Taken when the stage is done and no condition holds.</div>
          <button class="btn btn-sm btn-danger" onclick="TaskBoardFlow.act('removeEdge', '${key}')">Delete arrow</button></div>`;
    }
    const b = TaskBoardFlow.stageById(wf, e.from).branches[e.j];
    return `<div class="tbf-form"><div class="tbf-head">Condition from <strong>${escapeHtml(from)}</strong></div>
        <label class="tbf-field">If
          <input type="text" value="${escapeAttr(b.when)}" maxlength="200" placeholder="e.g. the ticket is a bug" oninput="TaskBoardFlow.setWhen('${key}', this.value)"></label>
        ${target}
        <div class="tbf-row">
          <button class="btn btn-sm" onclick="TaskBoardFlow.act('makeDefault', '${key}')">Make default</button>
          <button class="btn btn-sm btn-danger" onclick="TaskBoardFlow.act('removeEdge', '${key}')">Delete arrow</button>
        </div></div>`;
  },

  // --- DOM ---

  renderSvg() {
    const canvas = document.getElementById('tbf-canvas');
    if (canvas && TaskBoard._wf) canvas.innerHTML = TaskBoardFlow.svgHtml(TaskBoard._wf, TaskBoardFlow._drag);
  },

  renderPanel() {
    const panel = document.getElementById('tbf-panel');
    if (panel && TaskBoard._wf) panel.innerHTML = TaskBoardFlow.panelHtml(TaskBoard._wf);
  },

  render() {
    TaskBoardFlow.renderSvg();
    TaskBoardFlow.renderPanel();
  },

  /** Run a model change on the open workflow and redraw. */
  act(fn, ...args) {
    const result = TaskBoardFlow[fn](TaskBoard._wf, ...args);
    if (result === 'limit') toast(`A stage has at most ${TaskBoardFlow.MAX_BRANCHES} conditions`, 'error');
    TaskBoardFlow.render();
  },

  /** Typing (quiet) only redraws the diagram, so the field keeps focus. */
  setStage(id, field, value, quiet) {
    const wf = TaskBoard._wf;
    const s = TaskBoardFlow.stageById(wf, id);
    s[field] = value;
    if (field === 'type') {
      const first = wf.available.find(a => a.kind === value);
      s.ref = value === 'prompt' ? '' : (first ? first.name : '');
    }
    if (quiet) TaskBoardFlow.renderSvg();
    else TaskBoardFlow.render();
  },

  setWhen(key, value) {
    const wf = TaskBoard._wf;
    const e = TaskBoardFlow.edgeOf(wf, key);
    TaskBoardFlow.stageById(wf, e.from).branches[e.j].when = value;
    TaskBoardFlow.renderSvg();
  },

  retarget(key, to) {
    TaskBoardFlow.setTarget(TaskBoard._wf, key, to);
    TaskBoardFlow.render();
  },

  point(e) {
    const svg = document.querySelector('#tbf-canvas svg');
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },

  /** Pointer handling on the canvas: move a stage, draw an arrow from a dot, select a stage or arrow. */
  bind() {
    const canvas = document.getElementById('tbf-canvas');
    if (!canvas) return;
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const wf = TaskBoard._wf;
      const p = TaskBoardFlow.point(e);
      const handle = e.target.closest('[data-handle]');
      const node = e.target.closest('[data-node]');
      const edge = e.target.closest('[data-edge]');
      if (handle) {
        TaskBoardFlow._drag = { kind: 'connect', from: handle.dataset.handle, x: p.x, y: p.y };
      } else if (node && TaskBoardFlow.stageById(wf, node.dataset.node)) {
        const s = TaskBoardFlow.stageById(wf, node.dataset.node);
        TaskBoardFlow._drag = { kind: 'move', id: s.id, dx: p.x - s.pos.x, dy: p.y - s.pos.y, x0: p.x, y0: p.y, moved: false };
      } else {
        wf.sel = edge ? { edge: edge.dataset.edge } : null;
        TaskBoardFlow.render();
        return;
      }
      e.preventDefault();
      window.addEventListener('pointermove', TaskBoardFlow.onMove);
      window.addEventListener('pointerup', TaskBoardFlow.onUp);
    });
  },

  onMove(e) {
    const drag = TaskBoardFlow._drag;
    const wf = TaskBoard._wf;
    if (!drag || !wf) return;
    const p = TaskBoardFlow.point(e);
    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) < 4) return;
      drag.moved = true;
      const s = TaskBoardFlow.stageById(wf, drag.id);
      s.pos = { x: Math.max(0, Math.round((p.x - drag.dx) / 10) * 10), y: Math.max(0, Math.round((p.y - drag.dy) / 10) * 10) };
    } else {
      drag.x = p.x;
      drag.y = p.y;
    }
    TaskBoardFlow.renderSvg();
  },

  onUp(e) {
    window.removeEventListener('pointermove', TaskBoardFlow.onMove);
    window.removeEventListener('pointerup', TaskBoardFlow.onUp);
    const drag = TaskBoardFlow._drag;
    TaskBoardFlow._drag = null;
    const wf = TaskBoard._wf;
    if (!drag || !wf) return;
    if (drag.kind === 'move') {
      if (!drag.moved) wf.sel = { node: drag.id };
      TaskBoardFlow.render();
      return;
    }
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const target = over && over.closest('#tbf-canvas [data-node]');
    if (target) TaskBoardFlow.act('connect', drag.from, target.dataset.node);
    else TaskBoardFlow.render();
  }
};

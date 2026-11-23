// Claude's AskUserQuestion prompts as cards in the conversation (session detail and the Task Board
// preview). A card is drawn from the session JSONL; its answer comes from the matching tool_result.
// While CM's question hook holds the question (a session CM runs in its terminal), the card takes the
// answer itself; otherwise it only shows that the question waits for an answer in the terminal.
const SessionQuestions = {
  held: new Map(),      // session url -> Map(toolUseId -> questions) held by CM's question hook
  answered: new Map(),  // toolUseId -> answers given here, until the JSONL logs them
  released: new Set(),  // toolUseIds handed to the terminal here: a poll started before that cannot bring them back
  _seq: 0,

  /** The card for an AskUserQuestion tool_use block; apply() fills in its state. */
  cardHtml(block, live) {
    const questions = (block.input && Array.isArray(block.input.questions)) ? block.input.questions : [];
    const id = block.id || '';
    const answers = SessionQuestions.answered.get(id);
    return `<div class="chat-question${live ? ' chat-question--live' : ''}" data-tool-use-id="${escapeHtml(id)}" ` +
      `data-questions="${escapeHtml(JSON.stringify(questions))}">` +
      (answers ? SessionQuestions.answeredHtml(questions, answers) : SessionQuestions.openHtml(questions)) + '</div>';
  },

  /** A hidden marker inside a question's tool_result carrying its answers, for apply() to find. */
  resultMarkerHtml(block) {
    return `<div class="chat-question-answer" hidden data-tool-use-id="${escapeHtml(block.toolUseId || '')}" ` +
      `data-answers="${escapeHtml(JSON.stringify(block.answers || {}))}"></div>`;
  },

  headHtml(q) {
    return `<div class="cq-head">${q.header ? `<span class="cq-chip">${escapeHtml(q.header)}</span>` : ''}` +
      `${q.multiSelect ? '<span class="cq-multi">Multiple choice</span>' : ''}</div>` +
      `<div class="cq-text">${escapeHtml(q.question || '')}</div>`;
  },

  optionText(o) {
    return `<span class="cq-label">${escapeHtml(o.label || '')}</span>` +
      (o.description ? `<span class="cq-desc">${escapeHtml(o.description)}</span>` : '');
  },

  /** Not answered yet, and not answerable here. */
  openHtml(questions, note) {
    return questions.map(q => `<div class="cq-q">${SessionQuestions.headHtml(q)}` +
      (q.options || []).map(o => `<div class="cq-opt">${SessionQuestions.optionText(o)}</div>`).join('') + '</div>').join('') +
      `<div class="cq-note">${escapeHtml(note || 'Waiting for an answer in the terminal')}</div>`;
  },

  /** Which options an answer picked, and its own text (Other). Multi-select answers join labels with ", ". */
  splitAnswer(q, answer) {
    const labels = (q.options || []).map(o => o.label);
    if (labels.includes(answer)) return { chosen: [answer], other: '' };
    const parts = String(answer || '').split(', ');
    return { chosen: parts.filter(p => labels.includes(p)), other: parts.filter(p => !labels.includes(p)).join(', ') };
  },

  answeredHtml(questions, answers) {
    if (!Object.keys(answers).length) {
      return SessionQuestions.openHtml(questions, 'Not answered');
    }
    return questions.map(q => {
      const { chosen, other } = SessionQuestions.splitAnswer(q, answers[q.question]);
      return `<div class="cq-q">${SessionQuestions.headHtml(q)}` +
        (q.options || []).map(o => `<div class="cq-opt${chosen.includes(o.label) ? ' cq-chosen' : ''}">` +
          `${SessionQuestions.optionText(o)}</div>`).join('') +
        (other ? `<div class="cq-opt cq-chosen"><span class="cq-label">Other:</span> <span class="cq-other-answer">${escapeHtml(other)}</span></div>` : '') +
        '</div>';
    }).join('');
  },

  /** The answer form: options as radios (checkboxes for multi-select), an Other text field, Submit. */
  formHtml(questions) {
    const uid = 'cq' + (++SessionQuestions._seq);
    return questions.map((q, i) => {
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const name = `${uid}-${i}`;
      return `<div class="cq-q" data-index="${i}">${SessionQuestions.headHtml(q)}` +
        (q.options || []).map(o => `<label class="cq-opt cq-pick"><input type="${type}" name="${name}" value="${escapeHtml(o.label || '')}">` +
          `${SessionQuestions.optionText(o)}</label>`).join('') +
        `<label class="cq-opt cq-pick cq-other"><input type="${type}" name="${name}" value="" data-other="1">` +
        `<span class="cq-label">Other</span><input type="text" class="cq-other-text" placeholder="Your own answer" ` +
        `oninput="SessionQuestions.pickOther(this)"></label></div>`;
    }).join('') +
      '<div class="cq-actions"><button class="btn btn-sm btn-primary" onclick="SessionQuestions.submit(this)">Submit</button>' +
      '<button class="btn btn-sm" onclick="SessionQuestions.release(this)">Answer in terminal</button></div>';
  },

  pickOther(text) {
    const box = text.parentElement.querySelector('input[data-other]');
    if (box && text.value.trim()) box.checked = true;
  },

  /** Remember the questions CM's hook holds for a session (from its input-state). */
  setHeld(url, list) {
    SessionQuestions.held.set(url, new Map((list || [])
      .filter(h => !SessionQuestions.released.has(h.toolUseId))
      .map(h => [h.toolUseId, h.questions])));
  },

  /**
   * Bring the cards under `root` up to date: answered (from a tool_result in `root` or an answer given
   * here), answerable (held by CM's hook for the session at `url`, when `canAnswer`) or open. A held
   * question not yet in the JSONL gets a live card at the top; it goes once the JSONL one shows.
   */
  apply(root, url, canAnswer) {
    if (!root) return;
    const results = new Map();
    for (const m of root.querySelectorAll('.chat-question-answer[data-tool-use-id]')) {
      try { results.set(m.dataset.toolUseId, JSON.parse(m.dataset.answers)); } catch (_) { /* skip */ }
    }
    const held = SessionQuestions.held.get(url) || new Map();
    const logged = new Set(Array.from(root.querySelectorAll('.chat-question:not(.chat-question--live)')).map(c => c.dataset.toolUseId));
    for (const wrap of root.querySelectorAll('.chat-question-live')) {
      const id = wrap.dataset.toolUseId;
      if (logged.has(id) || !(held.has(id) || SessionQuestions.answered.has(id))) wrap.remove();
    }
    for (const [id, questions] of held) {
      if (logged.has(id) || root.querySelector(`.chat-question-live[data-tool-use-id="${CSS.escape(id)}"]`)) continue;
      root.insertAdjacentHTML('afterbegin', `<div class="chat-msg assistant chat-question-live" data-tool-use-id="${escapeHtml(id)}">` +
        '<div class="chat-role assistant"><span class="chat-role-label">Claude</span></div>' +
        SessionQuestions.cardHtml({ id, input: { questions } }, true) + '</div>');
    }
    for (const card of root.querySelectorAll('.chat-question[data-tool-use-id]')) {
      const id = card.dataset.toolUseId;
      let questions = [];
      try { questions = JSON.parse(card.dataset.questions); } catch (_) { /* none */ }
      const answers = results.get(id) || SessionQuestions.answered.get(id);
      let state, html;
      if (answers) { state = 'answered:' + JSON.stringify(answers); html = () => SessionQuestions.answeredHtml(questions, answers); }
      else if (canAnswer && held.has(id)) { state = 'ask'; html = () => SessionQuestions.formHtml(questions); }
      else { state = 'open'; html = () => SessionQuestions.openHtml(questions); }
      card.dataset.url = url;
      if (card.dataset.state === state) continue;
      card.dataset.state = state;
      card.innerHTML = html();
    }
  },

  /** The answers picked in a card's form: { "<question text>": "<answer>" }, or null when one is missing. */
  collect(card) {
    const questions = JSON.parse(card.dataset.questions);
    const answers = {};
    for (const qEl of card.querySelectorAll('.cq-q[data-index]')) {
      const q = questions[Number(qEl.dataset.index)];
      const picked = [];
      for (const input of qEl.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')) {
        if (input.dataset.other) {
          const own = qEl.querySelector('.cq-other-text').value.trim();
          if (!own) return null;
          picked.push(own);
        } else picked.push(input.value);
      }
      if (!picked.length) return null;
      answers[q.question] = picked.join(', ');
    }
    return answers;
  },

  async submit(btn) {
    const card = btn.closest('.chat-question');
    const answers = SessionQuestions.collect(card);
    if (!answers) { toast('Answer every question', 'error'); return; }
    const id = card.dataset.toolUseId;
    const url = card.dataset.url;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await api(url + '/question/answer', { method: 'POST', body: { toolUseId: id, answers } });
    } catch (e) {
      toast(e.message, 'error');
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      return;
    }
    SessionQuestions.answered.set(id, answers);
    SessionQuestions.done(card, url, id, 'answered:' + JSON.stringify(answers),
      SessionQuestions.answeredHtml(JSON.parse(card.dataset.questions), answers));
  },

  /** Let claude show the question in the terminal instead. */
  async release(btn) {
    const card = btn.closest('.chat-question');
    const id = card.dataset.toolUseId;
    const url = card.dataset.url;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await api(url + '/question/release', { method: 'POST', body: { toolUseId: id } });
    } catch (e) {
      toast(e.message, 'error');
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      return;
    }
    SessionQuestions.released.add(id);
    SessionQuestions.done(card, url, id, 'open', SessionQuestions.openHtml(JSON.parse(card.dataset.questions)));
  },

  done(card, url, id, state, html) {
    const held = SessionQuestions.held.get(url);
    if (held) held.delete(id);
    card.dataset.state = state;
    card.innerHTML = html;
  }
};

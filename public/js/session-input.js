// The message box under the conversation: sends a message to a session CM runs in its terminal.
// The server says whether the session can take one now; the sent message shows up in the
// conversation once claude writes it to the session JSONL.
const SessionInput = {
  state: 'none',
  sending: false,
  seq: 0,   // bumped on every send, so a poll started before it cannot re-enable the box

  NOTES: {
    none: 'Messages can be sent here only to a session running in CM\'s terminal — use the terminal for this one.',
    busy: 'Claude is working — a message sent now waits until it finishes.',
    question: 'Answer the open question in the terminal first.',
    ready: ''
  },

  async refresh() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug) { SessionInput.render('none'); return; }
    // A new session gets its id with its first JSONL line; until then its first message goes
    // through the terminal panel, which runs claude idle at its prompt.
    if (!sessionId) { if (SessionInput.state !== 'busy') SessionInput.render('ready'); return; }
    const seq = SessionInput.seq;
    try {
      const data = await api(`/api/projects/${slug}/sessions/${sessionId}/input-state`);
      const now = Sessions.detailState;
      if (now.slug !== slug || now.sessionId !== sessionId) return;
      if (SessionInput.sending || seq !== SessionInput.seq) return;
      SessionInput.render(data.state);
    } catch (_) {}
  },

  render(state) {
    SessionInput.state = state;
    const wrap = document.getElementById('session-input');
    if (!wrap) return;
    const text = document.getElementById('session-input-text');
    const note = document.getElementById('session-input-note');
    const { slug, readOnly } = Sessions.detailState;
    wrap.style.display = slug && !readOnly ? '' : 'none';
    wrap.dataset.state = state;
    text.disabled = state !== 'ready' && state !== 'busy';
    note.textContent = SessionInput.NOTES[state] || '';
  },

  onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    SessionInput.send();
  },

  async send() {
    const text = document.getElementById('session-input-text');
    const message = text.value;
    const { slug, sessionId, readOnly } = Sessions.detailState;
    if (readOnly || SessionInput.sending || !['ready', 'busy'].includes(SessionInput.state) || !message.trim()) return;
    SessionInput.sending = true;
    SessionInput.seq++;
    SessionInput.render('busy');
    if (!sessionId) {
      SessionInput.sending = false;
      if (typeof TerminalPanel !== 'undefined' && TerminalPanel.sendMessage(message)) { text.value = ''; return; }
      toast('The terminal is not connected yet', 'error');
      SessionInput.render('ready');
      return;
    }
    try {
      await api(`/api/projects/${slug}/sessions/${sessionId}/input`, { method: 'POST', body: { text: message } });
      text.value = '';
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      SessionInput.sending = false;
    }
    SessionInput.refresh();
  }
};

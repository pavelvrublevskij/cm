// The message box under the conversation: sends a message to a session CM runs in its terminal.
// The server says whether the session can take one now; the sent message shows up in the
// conversation once claude writes it to the session JSONL.
const SessionInput = {
  state: 'none',
  sending: false,
  seq: 0,   // bumped on every send, so a poll started before it cannot re-enable the box

  NOTES: {
    none: 'Messages can be sent here only to a session running in CM\'s terminal — use the terminal for this one.',
    busy: 'Claude is working…',
    question: 'Answer the open question in the terminal first.',
    ready: ''
  },

  async refresh() {
    const { slug, sessionId } = Sessions.detailState;
    if (!slug || !sessionId) { SessionInput.render('none'); return; }
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
    const send = document.getElementById('session-input-send');
    const note = document.getElementById('session-input-note');
    const { sessionId, readOnly } = Sessions.detailState;
    wrap.style.display = sessionId && !readOnly ? '' : 'none';
    wrap.dataset.state = state;
    text.disabled = state !== 'ready';
    send.disabled = state !== 'ready';
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
    if (readOnly || SessionInput.sending || SessionInput.state !== 'ready' || !message.trim()) return;
    SessionInput.sending = true;
    SessionInput.seq++;
    SessionInput.render('busy');
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

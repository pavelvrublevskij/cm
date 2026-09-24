const Autostart = {
  async checkFirstRun() {
    try {
      const status = await api('/api/autostart');
      if (status.supported && !status.prompted) Autostart.promptEnable();
    } catch (_) {}
  },

  promptEnable() {
    openModal({
      title: 'Start Claude Manager at login?',
      body: '<div class="info-note">'
        + 'Claude Manager can start automatically in the background when you log in, and open in your browser. '
        + 'You can change this later in Manager Settings.'
        + '</div>',
      cancelLabel: 'Not now',
      buttons: [{
        label: 'Enable', primary: true, onClick: async () => {
          try {
            await api('/api/autostart/enable', { method: 'POST' });
            toast('Claude Manager will start automatically at login');
          } catch (e) {
            toast('Failed to enable autostart: ' + e.message, 'error');
          }
        }
      }],
      onClose: () => { api('/api/autostart/dismiss', { method: 'POST' }).catch(() => {}); }
    });
  }
};

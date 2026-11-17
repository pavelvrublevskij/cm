// --- Compact mode ---

const COMPACT_MODE_KEY = 'claude-manager-compact-mode';

const CompactMode = {
  enabled: false,

  apply(on) {
    this.enabled = on;
    const app = document.querySelector('.app');
    if (app) {
      if (on) app.classList.add('compact-mode');
      else app.classList.remove('compact-mode');
    }
    const input = document.getElementById('compact-mode-switch');
    if (input) input.checked = on;
  },

  init() {
    this.apply(localStorage.getItem(COMPACT_MODE_KEY) === '1');
  },

  toggle() {
    this.apply(!this.enabled);
    localStorage.setItem(COMPACT_MODE_KEY, this.enabled ? '1' : '0');
  },
};

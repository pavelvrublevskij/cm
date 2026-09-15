// --- Sidebar drag-resize ---

const SIDEBAR_WIDTH_KEY = 'claude-manager-sidebar-width';
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;

const SidebarResize = {
  width: SIDEBAR_MIN_WIDTH,
  dragged: false,
  drag: null,

  clamp(px) {
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(px)));
  },

  apply(px) {
    this.width = this.clamp(px);
    document.documentElement.style.setProperty('--sidebar-width', this.width + 'px');
  },

  init() {
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (saved) this.apply(saved);

    const handle = document.getElementById('sidebar-toggle');
    if (!handle) return;
    handle.addEventListener('mousedown', e => this.start(e));
    document.addEventListener('mousemove', e => this.move(e));
    document.addEventListener('mouseup', () => this.end());
  },

  start(e) {
    const app = document.querySelector('.app');
    if (!app || app.classList.contains('sidebar-collapsed')) return;
    const sidebar = document.querySelector('.sidebar');
    this.drag = { startX: e.clientX, startWidth: sidebar ? sidebar.offsetWidth : this.width };
    this.dragged = false;
    e.preventDefault();
  },

  move(e) {
    if (!this.drag) return;
    const delta = e.clientX - this.drag.startX;
    if (!this.dragged) {
      if (Math.abs(delta) < 3) return;
      this.dragged = true;
      document.querySelector('.app').classList.add('sidebar-resizing');
    }
    this.apply(this.drag.startWidth + delta);
  },

  end() {
    if (!this.drag) return;
    this.drag = null;
    if (!this.dragged) return;
    document.querySelector('.app').classList.remove('sidebar-resizing');
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(this.width));
  },

  // A drag ends with a click on the toggle button — swallow it so resizing never collapses
  consumeDrag() {
    const dragged = this.dragged;
    this.dragged = false;
    return dragged;
  },
};

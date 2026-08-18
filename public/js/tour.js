const Tour = {
  STORAGE_KEY: 'claude-manager-tour-minor',
  current: 0,
  active: false,
  _minor: null,

  steps: [
    {
      element: null,
      title: 'Welcome to CM',
      text: 'Your local dashboard for Claude Code — browse sessions, track token usage, manage settings and memory. This tour takes about a minute.',
      position: 'center'
    },
    {
      element: '.sidebar-nav',
      title: 'Navigation',
      text: 'Switch between views here. The sidebar collapses to icon-only mode using the toggle strip on the right edge.',
      position: 'right'
    },
    {
      element: '#theme-toggle',
      title: 'Themes',
      text: 'Cycle through 4 built-in themes — Dark, Light, Matrix, and Default. Click to switch.',
      position: 'top'
    },
    {
      element: '#usage-summary',
      title: 'Usage Summary',
      text: 'Token Usage is your home view — total API consumption and cost across all projects and models at a glance.',
      position: 'bottom',
      view: 'usage'
    },
    {
      element: '#usage-filter-bar',
      title: 'Filters',
      text: 'Filter by model, project, and date range. Combine any filters freely — changes apply instantly.',
      position: 'bottom',
      view: 'usage'
    },
    {
      element: '#usage-view-toggle',
      title: 'Table vs Charts',
      text: 'Toggle between the data table and Charts — visual breakdowns of cost over time, usage by model, and top projects.',
      position: 'bottom',
      view: 'usage'
    },
    {
      element: '#usage-period-tabs-chart',
      title: 'Period Breakdown',
      text: 'Group charts and the usage table by Hour, Day, Week, Month, or Year using these tabs.',
      position: 'bottom',
      view: 'usage'
    },
  ],

  shouldShow(minor) {
    if (!Number.isFinite(minor)) return false;
    const stored = parseInt(localStorage.getItem(Tour.STORAGE_KEY), 10);
    if (!Number.isFinite(stored)) return true;
    return stored < minor;
  },

  markSeen(minor) {
    if (Number.isFinite(minor)) localStorage.setItem(Tour.STORAGE_KEY, String(minor));
  },

  start(minor) {
    if (Tour.active) return;
    Tour.active = true;
    Tour._minor = minor;
    Tour.current = 0;
    Tour.markSeen(minor);
    Tour._createDOM();
    Tour._showStep(0);
  },

  skip() {
    Tour.markSeen(Tour._minor);
    Tour._destroy();
  },

  next() {
    if (Tour.current < Tour.steps.length - 1) {
      Tour.current++;
      Tour._showStep(Tour.current);
    } else {
      Tour.skip();
    }
  },

  prev() {
    if (Tour.current > 0) {
      Tour.current--;
      Tour._showStep(Tour.current);
    }
  },

  reset() {
    localStorage.removeItem(Tour.STORAGE_KEY);
    Tour._minor = null;
  },

  _createDOM() {
    const overlay = document.createElement('div');
    overlay.id = 'tour-overlay';
    overlay.className = 'tour-overlay';
    document.body.appendChild(overlay);

    const spotlight = document.createElement('div');
    spotlight.id = 'tour-spotlight';
    spotlight.className = 'tour-spotlight';
    document.body.appendChild(spotlight);

    const card = document.createElement('div');
    card.id = 'tour-card';
    card.className = 'tour-card';
    document.body.appendChild(card);
  },

  _destroy() {
    document.getElementById('tour-overlay')?.remove();
    document.getElementById('tour-spotlight')?.remove();
    document.getElementById('tour-card')?.remove();
    Tour.active = false;
  },

  _showStep(index) {
    const step = Tour.steps[index];

    if (step.view && typeof App !== 'undefined' && App.currentView !== step.view) {
      App.navigate(step.view);
    }

    const overlay = document.getElementById('tour-overlay');
    const spotlight = document.getElementById('tour-spotlight');
    const card = document.getElementById('tour-card');
    if (!spotlight || !card) return;

    if (!step.element) {
      spotlight.style.display = 'none';
      if (overlay) overlay.classList.add('tour-overlay-dim');
      Tour._renderCard(card, null, step, index);
      return;
    }

    if (overlay) overlay.classList.remove('tour-overlay-dim');

    const el = document.querySelector(step.element);
    if (!el) {
      spotlight.style.display = 'none';
      Tour._renderCard(card, null, step, index);
      return;
    }

    el.scrollIntoView({ behavior: 'instant', block: 'nearest' });

    // rAF x2 ensures layout is settled after scroll
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const pad = 6;
      Object.assign(spotlight.style, {
        display: 'block',
        top:    (rect.top    - pad) + 'px',
        left:   (rect.left   - pad) + 'px',
        width:  (rect.width  + pad * 2) + 'px',
        height: (rect.height + pad * 2) + 'px',
      });
      Tour._renderCard(card, rect, step, index);
    }));
  },

  _renderCard(card, rect, step, index) {
    const total = Tour.steps.length;
    const isFirst = index === 0;
    const isLast = index === total - 1;

    card.classList.remove('tour-card-blink');
    void card.offsetWidth; // force reflow so animation restarts
    card.classList.add('tour-card-blink');

    card.innerHTML = `
      <div class="tour-card-header">
        <span class="tour-step-count">${index + 1} / ${total}</span>
        <button class="tour-skip" onclick="Tour.skip()">Skip tour</button>
      </div>
      <div class="tour-card-title">${step.title}</div>
      <div class="tour-card-text">${step.text}</div>
      <div class="tour-card-footer">
        ${!isFirst
          ? '<button class="tour-btn tour-btn-secondary" onclick="Tour.prev()">Back</button>'
          : '<span></span>'}
        ${isLast
          ? '<button class="tour-btn tour-btn-primary" onclick="Tour.skip()">Done</button>'
          : '<button class="tour-btn tour-btn-primary" onclick="Tour.next()">Next</button>'}
      </div>
    `;

    const CARD_W = 300;
    const GAP = 14;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cardH = 160;

    let top, left;

    if (!rect) {
      top  = (H - cardH) / 2;
      left = (W - CARD_W) / 2;
    } else if (step.position === 'right') {
      top  = Math.max(GAP, Math.min(rect.top, H - cardH - GAP));
      left = rect.right + GAP;
      if (left + CARD_W > W - GAP) left = rect.left - CARD_W - GAP;
    } else if (step.position === 'bottom') {
      top  = rect.bottom + GAP;
      left = Math.max(GAP, Math.min(rect.left, W - CARD_W - GAP));
      if (top + cardH > H - GAP) top = rect.top - cardH - GAP;
    } else if (step.position === 'top') {
      top  = rect.top - cardH - GAP;
      left = Math.max(GAP, Math.min(rect.left, W - CARD_W - GAP));
      if (top < GAP) top = rect.bottom + GAP;
    } else {
      top  = (H - cardH) / 2;
      left = (W - CARD_W) / 2;
    }

    card.style.top  = Math.max(GAP, top)  + 'px';
    card.style.left = Math.max(GAP, left) + 'px';
  }
};

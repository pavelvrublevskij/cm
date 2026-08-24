// --- Shared Utilities ---

/** Escape HTML entities to prevent XSS. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Escape for use inside a double-quoted HTML attribute. escapeHtml goes through textContent, which
 * does not touch quotes, so a value containing one would end the attribute early.
 */
function escapeAttr(str) {
  return escapeHtml(str).split('"').join('&quot;').split("'").join('&#39;');
}

/** Fetch JSON from the API. Throws on non-OK responses. */
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/** Show a toast notification. */
function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function stripAnsi(text) {
  return (text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Drop a leading YAML frontmatter block (--- ... ---) — metadata, not content to render. */
function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
}

/** GitHub-style heading slug, so a markdown link like `#installation` has a matching id to find. */
function slugifyHeading(text) {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

/** marked renders headings with no id by default, so `[text](#heading)` links have nothing to
 *  jump to. Slugify each heading's text into an id, GitHub-style, deduping repeats. */
function addHeadingIds(html) {
  const seen = new Map();
  return html.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/g, (whole, tag, inner) => {
    const plain = inner.replace(/<[^>]+>/g, '');
    let slug = slugifyHeading(plain) || 'section';
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    return `<${tag} id="${slug}">${inner}</${tag}>`;
  });
}

/** Render markdown to HTML using the marked library. */
function renderMarkdown(text) {
  const clean = stripAnsi(stripFrontmatter(text));
  if (typeof marked !== 'undefined') {
    return addHeadingIds(marked.parse(clean, { breaks: true }));
  }
  return clean.replace(/</g, '&lt;').replace(/\n/g, '<br>');
}

/** Render markdown for chat messages, escaping any raw HTML in the source instead of injecting it (chat text is untrusted user/model content, not a document preview). */
function renderChatMarkdown(text) {
  const clean = stripAnsi(text);
  if (typeof marked === 'undefined') {
    return clean.replace(/</g, '&lt;').replace(/\n/g, '<br>');
  }
  if (!renderChatMarkdown._renderer) {
    const r = new marked.Renderer();
    r.html = token => escapeHtml(typeof token === 'string' ? token : (token.raw != null ? token.raw : (token.text || '')));
    renderChatMarkdown._renderer = r;
  }
  return marked.parse(clean, { breaks: true, renderer: renderChatMarkdown._renderer });
}

/** Extract a human-readable short name from a project slug. */
function decodeName(slug) {
  const segments = slug.replace(/^[A-Za-z]--/, '').split('-').filter(Boolean);
  if (segments.length >= 2) {
    return segments.slice(-2).join('/');
  }
  return slug;
}

/** Show a loading spinner in a container element. */
function showLoading(container, text = 'Loading...') {
  if (typeof container === 'string') container = document.getElementById(container);
  container.innerHTML = `<div class="loading"><div class="spinner"></div>${escapeHtml(text)}</div>`;
}

/** Copy text to the clipboard with a toast on success/failure. */
async function copyToClipboard(text, label = 'Copied') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('execCommand failed');
    }
    toast(label);
  } catch (e) {
    toast('Copy failed', 'error');
  }
}

/** Add a hover "Copy" button to each code block within a container. */
function addCodeCopyButtons(container) {
  container.querySelectorAll('.chat-text pre:not(.has-copy-btn), .markdown-body pre:not(.has-copy-btn)').forEach(pre => {
    pre.classList.add('has-copy-btn');
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      copyToClipboard(code ? code.textContent : pre.textContent, 'Code copied');
    });
    pre.appendChild(btn);
  });
}

function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function buildTable(cols, rows) {
  const head = cols.map(c => `<th${c.cls ? ` class="${c.cls}"` : ''}>${c.label}</th>`).join('');
  const body = rows.map(cells =>
    `<tr>${cells.map((v, i) => `<td${cols[i]?.cls ? ` class="${cols[i].cls}"` : ''}>${v}</td>`).join('')}</tr>`
  ).join('');
  return `<table class="usage-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// --- Terminal self-repair ---
// When a browser terminal's pty fails to spawn (e.g. a broken node-pty install on the user's
// machine), the terminal panels offer a "Fix & Restart App" button. It hits this same repair
// flow regardless of which panel (session terminal or git shell) triggered it.
const TerminalRepair = {
  POLL_MS: 1000,
  POLL_MAX_ATTEMPTS: 90,

  /** onUpdate(text, failed) — failed=true means the button should re-enable so the user can retry. */
  async trigger(onUpdate) {
    if (onUpdate) onUpdate('Repairing and restarting the app…', false);
    try {
      await api('/api/terminal/repair', { method: 'POST' });
    } catch (e) {
      if (onUpdate) onUpdate('Repair failed: ' + e.message, true);
      return;
    }
    TerminalRepair._waitForServer(onUpdate, 0);
  },

  _waitForServer(onUpdate, attempt) {
    fetch('/api/version').then(res => {
      if (!res.ok) throw new Error('not ready');
      location.reload();
    }).catch(() => {
      if (attempt >= TerminalRepair.POLL_MAX_ATTEMPTS) {
        if (onUpdate) onUpdate('Still restarting — reload the page in a moment.', true);
        return;
      }
      setTimeout(() => TerminalRepair._waitForServer(onUpdate, attempt + 1), TerminalRepair.POLL_MS);
    });
  }
};

// --- Theme ---

const Theme = {
  themes: ['dark', 'light', 'matrix', 'default', 'terminal', 'dracula', 'sepia'],
  icons: { dark: '&#9790;', light: '&#9728;', matrix: '&#9783;', default: '&#9681;', terminal: '&#9608;', dracula: '&#9760;', sepia: '&#10086;' },
  labels: { dark: 'Dark', light: 'Light', matrix: 'Matrix', default: 'Default', terminal: 'Terminal', dracula: 'Dracula', sepia: 'Sepia' },

  init() {
    const saved = localStorage.getItem('claude-manager-theme') || 'dark';
    Theme.apply(saved);
  },

  toggle() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const idx = Theme.themes.indexOf(current);
    const next = Theme.themes[(idx + 1) % Theme.themes.length];
    Theme.apply(next);
    localStorage.setItem('claude-manager-theme', next);
  },

  apply(theme) {
    if (!Theme.themes.includes(theme)) theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    const link = document.getElementById('theme-stylesheet');
    if (link) link.href = '/css/themes/' + theme + '.css';
    const icon = document.getElementById('theme-icon');
    if (icon) icon.innerHTML = Theme.icons[theme];
    const label = document.getElementById('theme-label');
    if (label) label.textContent = Theme.labels[theme];
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.title = 'Theme: ' + Theme.labels[theme] + ' — click to cycle';
  }
};

// Apply theme immediately (before DOMContentLoaded) to avoid flash
Theme.init();

const ActiveCount = {
  POLL_MS: 15000,
  _timer: null,
  _data: { total: 0, byProject: {} },

  start() {
    ActiveCount.refresh();
    if (ActiveCount._timer) return;
    ActiveCount._timer = setInterval(ActiveCount.refresh, ActiveCount.POLL_MS);
  },

  async refresh() {
    try {
      const data = await api('/api/dashboard/active-count');
      ActiveCount._data = data;
      ActiveCount._apply();
    } catch (_) { /* silent — count is non-critical */ }
  },

  _apply() {
    const { total, byProject } = ActiveCount._data;
    const dash = document.getElementById('nav-dashboard-active');
    if (dash) {
      if (total > 0) { dash.textContent = total; dash.style.display = ''; }
      else dash.style.display = 'none';
    }
    document.querySelectorAll('.nav-active-badge').forEach(el => {
      const slug = el.dataset.slug;
      const count = (byProject && byProject[slug]) || 0;
      if (count > 0) { el.textContent = count; el.style.display = ''; }
      else el.style.display = 'none';
    });
  }
};

const Changelog = {
  async load() {
    const el = document.getElementById('changelog-content');
    el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading changelog...</div>';
    try {
      const { content } = await api('/api/changelog');
      el.innerHTML = renderMarkdown(content);
    } catch (e) {
      el.innerHTML = '<p>Failed to load changelog.</p>';
      toast('Failed to load changelog', 'error');
    }
  }
};

/** Map a full model ID to a short display name. */
function shortModel(model) {
  if (!model) return '';
  // "claude-opus-4-6" -> "Opus 4.6", "claude-haiku-4-5-20251001" -> "Haiku 4.5"
  const m = model.replace(/-\d{8,}$/, '');
  const match = m.match(/claude-(opus|sonnet|haiku)-(.+)/i);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const ver = match[2].replace(/-/g, '.');
    return family + ' ' + ver;
  }
  return model;
}

/** Look up pricing for a model ID with fuzzy matching (strip date suffix, prefix match). */
function matchPricing(modelId, pricingMap) {
  if (!modelId || !pricingMap) return null;
  if (pricingMap[modelId]) return pricingMap[modelId];
  const noDate = modelId.replace(/-\d{8,}$/, '');
  if (pricingMap[noDate]) return pricingMap[noDate];
  let best = null, bestLen = 0;
  for (const key of Object.keys(pricingMap)) {
    if (modelId.startsWith(key) && key.length > bestLen) { best = key; bestLen = key.length; }
  }
  return best ? pricingMap[best] : null;
}

// --- Code highlighting (CodeMirror modes, shared by the editor pane and diff views) ---

const CODE_MODES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'javascript', tsx: 'javascript', json: 'application/json',
  css: 'css', scss: 'css', less: 'css',
  html: 'htmlmixed', htm: 'htmlmixed', vue: 'htmlmixed',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  py: 'python',
  java: 'text/x-java', kt: 'text/x-kotlin', kts: 'text/x-kotlin', scala: 'text/x-scala',
  c: 'text/x-csrc', h: 'text/x-csrc',
  cpp: 'text/x-c++src', cc: 'text/x-c++src', cxx: 'text/x-c++src', hpp: 'text/x-c++src',
  cs: 'text/x-csharp', m: 'text/x-objectivec',
  groovy: 'groovy', gradle: 'groovy',
  sql: 'sql', go: 'go', rs: 'rust', swift: 'swift',
  php: 'php', rb: 'ruby', lua: 'lua',
  ps1: 'powershell', psm1: 'powershell',
  dockerfile: 'dockerfile',
  properties: 'properties', ini: 'properties', env: 'properties', cfg: 'properties', conf: 'properties',
  toml: 'toml',
  diff: 'diff', patch: 'diff'
};

/** CodeMirror mode for a file path, or null when the extension has none. */
function codeModeFor(filePath) {
  if (!filePath) return null;
  const ext = filePath.split('.').pop().toLowerCase();
  return CODE_MODES[ext] || null;
}

/**
 * Tokenize one snippet into CodeMirror `cm-*` spans for static (non-editor) views.
 * Falls back to plain escaped text when CodeMirror or the mode is unavailable.
 * Each call starts in the mode's initial state, so constructs spanning lines
 * (block comments, template literals) are highlighted per line, not per file.
 */
function highlightCode(text, mode) {
  if (!mode || typeof CodeMirror === 'undefined' || !CodeMirror.runMode) return escapeHtml(text);
  let html = '';
  CodeMirror.runMode(text, mode, (token, style) => {
    const escaped = escapeHtml(token);
    html += style ? `<span class="cm-${style.split(' ').join(' cm-')}">${escaped}</span>` : escaped;
  });
  return html;
}

/** Format a byte count to human-readable (e.g. 512 B, 1.4 KB, 2.3 MB). */
function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Format a token count to human-readable (e.g. 1.2B, 1.2M, 3.5K). */
function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/**
 * Render a session card.
 * opts.onclick     - onclick handler string
 * opts.project     - show project badge (pass decoded project name)
 * opts.timeAgo     - show relative time in header (pass formatted string)
 * opts.dates       - show Created/Modified rows
 * opts.snippets    - HTML string for search snippets
 * opts.sidechain   - show sidechain/lastGitBranch indicators
 */
/**
 * Render session stat badges (messages, tokens, cost, models, branch, sidechain).
 * Shared between the session list card and the session detail header.
 * opts.sidechain - show sidechain/lastGitBranch indicators
 */
function renderSessionBadges(s, opts = {}) {
  const parts = [];
  if (s.messageCount != null) {
    parts.push(`<div class="meta-item" title="User messages (prompts you sent)">Messages <span class="meta-value">${s.messageCount}</span></div>`);
  }
  if (s.tokens) {
    const total = (s.tokens.input_tokens || 0) + (s.tokens.output_tokens || 0);
    parts.push(`<span class="token-badge badge-tokens">${fmtTokens(total)} tokens</span>`);
  }
  if (s.cost) {
    parts.push(`<span class="token-badge badge-cost">$${s.cost.toFixed(2)}</span>`);
  }
  if (opts.modelPricing && s.modelCosts && Object.keys(s.modelCosts).length) {
    const rows = Object.entries(s.modelCosts).map(([m, c]) =>
      `<span class="model-pricing-row"><span class="token-badge badge-model">${escapeHtml(shortModel(m))}</span><span class="model-pricing-cost">$${c.total.toFixed(4)}</span></span>`
    );
    parts.push(`<div class="session-branches-row" style="gap:8px">${rows.join('')}</div>`);
  } else {
    (s.models || []).forEach(m => {
      parts.push(`<span class="token-badge badge-model">${escapeHtml(shortModel(m))}</span>`);
    });
  }
  let branches = Array.isArray(s.gitBranches) ? s.gitBranches.filter(Boolean) : [];
  if (!branches.length) {
    const fallback = [s.gitBranch, s.lastGitBranch].filter(Boolean);
    branches = Array.from(new Set(fallback));
  }
  if (branches.length && !opts.skipBranches) {
    const branchParts = [];
    branches.forEach((b, i) => {
      if (i > 0) branchParts.push('<span class="session-branch-arrow">&#8594;</span>');
      branchParts.push(`<span class="session-branch">${escapeHtml(b)}</span>`);
    });
    parts.push(`<div class="session-branches-row">${branchParts.join('')}</div>`);
  }
  if (opts.sidechain && s.isSidechain) {
    parts.push('<span class="session-sidechain">sidechain</span>');
  }
  return parts.join('');
}

function renderSessionCard(s, opts = {}) {
  const slug = opts.slug || s.slug;

  const dotHtml = s.active
    ? `<span class="session-active-dot session-active-dot--${s.activeKind || 'os'}" title="${s.activeKind === 'browser' ? 'Browser terminal active — click to reconnect' : 'OS terminal launched recently'}"></span>`
    : '';
  const remoteIcon = s.remoteControlled
    ? `<span class="session-remote-icon" title="Remote-controlled session (used mobile/web bridge)" aria-label="remote-controlled">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.5 5.5a5 5 0 0 1 9 0"/>
          <path d="M5.5 7.5a2.5 2.5 0 0 1 5 0"/>
          <circle cx="8" cy="9.5" r="0.9" fill="currentColor" stroke="none"/>
        </svg>
      </span>`
    : '';
  function skillBadgeHtml(text) {
    if (!text) return null;
    const m = text.match(/^\/([\w-]+)(.*)/s);
    if (!m) return null;
    const rest = m[2].trim();
    return `<span class="session-skill">/${escapeHtml(m[1])}</span>${rest ? ' ' + escapeHtml(rest) : ''}`;
  }

  const summaryRaw = s.summary || s.firstPrompt || '';
  const skillHtml = skillBadgeHtml(summaryRaw);
  const summaryText = skillHtml || escapeHtml(summaryRaw || 'Untitled session');

  let headerHtml;
  if (opts.timeAgo) {
    headerHtml = `<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:6px">
      <div class="session-summary">${dotHtml}${remoteIcon}${summaryText}</div>
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;margin-left:12px">${escapeHtml(opts.timeAgo)}</span>
    </div>`;
  } else {
    headerHtml = `<div class="session-summary">${dotHtml}${remoteIcon}${summaryText}</div>`;
    if (s.firstPrompt && s.summary) {
      const fpHtml = skillBadgeHtml(s.firstPrompt) || escapeHtml(s.firstPrompt);
      headerHtml += `<div class="session-prompt">${fpHtml}</div>`;
    }
  }

  const shortId = s.sessionId ? s.sessionId.slice(0, 8) + '…' : '';
  const idBadge = s.sessionId
    ? `<span class="session-id-badge" title="${escapeHtml(s.sessionId)} — click to copy" onclick="event.stopPropagation(); copyToClipboard('${s.sessionId}', 'Session ID copied')">${escapeHtml(shortId)}</span>`
    : '';

  return `
    <div class="session-card" style="cursor:pointer" data-session-id="${s.sessionId}" onclick="${opts.onclick || ''}">
      ${headerHtml}
      ${opts.snippets || ''}
      <div class="session-meta">
        ${opts.hasPlan ? '<span class="session-plan-badge" title="Plans were active during this session">plan</span>' : ''}
        ${opts.project ? `<span class="project-badge">${escapeHtml(opts.project)}</span>` : ''}
        ${idBadge}
        ${opts.dates ? `<div class="meta-item">Created <span class="meta-value">${s.created ? new Date(s.created).toLocaleString() : '—'}</span></div>
        <div class="meta-item">Modified <span class="meta-value">${s.modified ? new Date(s.modified).toLocaleString() : '—'}</span></div>` : ''}
        ${renderSessionBadges(s, { sidechain: opts.sidechain })}
        <div class="session-actions">
          <div class="action-menu">
            <button class="btn btn-sm action-menu-btn" onclick="event.stopPropagation(); Sessions.toggleActionMenu(this)" aria-label="More actions">&#8942;</button>
            <div class="action-menu-panel">
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.resumeOS('${slug}', '${s.sessionId}')">Resume in OS terminal</button>
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.resumeBrowser('${slug}', '${s.sessionId}')">Resume in browser terminal</button>
              <button class="action-menu-item" data-slug="${slug}" data-session="${s.sessionId}" data-title="${escapeHtml(s.summary || s.firstPrompt || '')}" onclick="event.stopPropagation(); Sessions.renameAction(this)">Rename</button>
              <button class="action-menu-item" onclick="event.stopPropagation(); Sessions.copyIdAction('${s.sessionId}')">Copy session ID</button>
              ${opts.archived
                ? `<button class="action-menu-item" onclick="event.stopPropagation(); Sessions.unarchiveAction('${slug}', '${s.sessionId}')">Unarchive</button>`
                : `<button class="action-menu-item" onclick="event.stopPropagation(); Sessions.archiveAction('${slug}', '${s.sessionId}')">Archive</button>`
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** Format a date as relative time ("3h ago", "2d ago"). */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  return new Date(dateStr).toLocaleDateString();
}

// --- Constants ---

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
const KB_CONTEXTS = ['Chat', 'Global', 'Autocomplete', 'Settings', 'Confirmation', 'Tabs', 'Help', 'Transcript', 'HistorySearch', 'Task'];
const MCP_TYPES = ['stdio', 'sse', 'http'];
const VALUE_TYPES = ['string', 'number', 'boolean', 'object', 'array'];

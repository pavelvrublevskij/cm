const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { safeSlug, wrapRoute, backup } = require('../lib/file-helpers');
const { CLAUDE_DIR } = require('../lib/paths');
const planCache = require('../lib/plan-cache');
const { getProjectUsageMap, getSessionUsage, calcCost } = require('../lib/usage-index');
const { decodeSlug } = require('../lib/slug');
const { getCustomTitle } = require('../lib/session-title');
const { collectBranches } = require('../lib/session-branches');
const { hasBridgeSession } = require('../lib/session-flags');
const terminalServer = require('../lib/terminal-server');
const activeSessions = require('../lib/active-sessions');
const { stampActive, listAllActiveSessions } = require('../lib/session-status');
const { MAX_SNIPPETS, extractEntrySnippets, extractMetaSnippet } = require('../lib/session-search');
const { collectFromJsonl, collectFromDir } = require('../lib/session-activity');
const { getArchivedIds, archiveSession, unarchiveSession } = require('../lib/session-archive');

const router = express.Router({ mergeParams: true });

const _titleCache = new Map();
const TITLE_CACHE_TTL = 60000;

function getCachedTitle(filePath) {
  const nowMs = Date.now();
  const cached = _titleCache.get(filePath);
  if (cached && nowMs - cached.cachedAt < TITLE_CACHE_TTL) return cached.title;
  const title = getCustomTitle(filePath) || findFirstMeaningfulPrompt(filePath);
  _titleCache.set(filePath, { title, cachedAt: nowMs });
  return title;
}

function normalizePrompt(text) {
  const m = (text || '').match(/<command-name>(\/[\w-]+)<\/command-name>/);
  if (!m) return (text || '');
  const args = (text || '').match(/<command-args>([\s\S]*?)<\/command-args>/);
  const trimmedArgs = args ? args[1].trim() : '';
  return trimmedArgs ? m[1] + ' ' + trimmedArgs : m[1];
}

function isSkippablePrompt(text) {
  const t = (text || '').trim();
  if (t.includes('Caveat: The messages below were generated')) return true;
  return normalizePrompt(t) === '/clear';
}

function findFirstMeaningfulPrompt(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;
        const raw = typeof entry.message?.content === 'string' ? entry.message.content : '';
        if (raw && !isSkippablePrompt(raw)) return normalizePrompt(raw).slice(0, 200);
      } catch (_) {}
    }
  } catch (_) {}
  return '';
}

function safeSpawn(cmd, args, opts) {
  const proc = spawn(cmd, args, opts);
  // Without an 'error' listener, an async spawn failure crashes Node.
  proc.on('error', () => { /* swallowed; caller decides what to do */ });
  return proc;
}

function launchTerminal(projectPath, cmd) {
  if (process.env.__CLAUDE_MANAGER_TEST_HOME) return;
  const platform = process.platform;
  if (platform === 'win32') {
    const wtArgs = ['-d', projectPath, 'cmd.exe', '/k', cmd];
    const proc = spawn('wt.exe', wtArgs, { detached: true, stdio: 'ignore' });
    proc.on('error', () => {
      safeSpawn('cmd.exe', ['/c', `start "" cmd.exe /k "cd /d ${projectPath} && ${cmd}"`], { shell: true, detached: true, stdio: 'ignore' }).unref();
    });
    proc.unref();
  } else if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd '${projectPath}' && ${cmd}"`;
    const proc = safeSpawn('osascript', ['-e', script]);
    proc.unref();
  } else {
    const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    for (const term of terminals) {
      try {
        const args = term === 'gnome-terminal'
          ? ['--', 'bash', '-c', `cd '${projectPath}' && ${cmd}; exec bash`]
          : ['-e', `bash -c "cd '${projectPath}' && ${cmd}; exec bash"`];
        const proc = safeSpawn(term, args);
        proc.unref();
        return;
      } catch (_) { continue; }
    }
    throw new Error('No supported terminal found');
  }
}

router.get('/active', wrapRoute((req, res) => {
  const all = listAllActiveSessions();
  const archivedBySlug = {};
  const result = all
    .filter(({ sessionId }) => !sessionId.includes('..') && !sessionId.includes('/') && !sessionId.includes('\\'))
    .map(({ slug, sessionId, kind }) => {
      const dir = safeSlug(slug);
      let title = '';
      let lastGitBranch = '';
      if (dir) {
        const filePath = path.join(dir, sessionId + '.jsonl');
        title = getCachedTitle(filePath);
        const branches = collectBranches(filePath);
        lastGitBranch = branches.length ? branches[branches.length - 1] : '';
      }
      if (!archivedBySlug[slug]) archivedBySlug[slug] = getArchivedIds(slug);
      const archived = archivedBySlug[slug].has(sessionId);
      return { slug, sessionId, title: title || '', kind, lastGitBranch, archived };
    });
  res.json(result);
}));

router.get('/:slug/sessions', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const showArchived = req.query.archived === 'true';
  const archivedIds = getArchivedIds(req.params.slug);

  const indexFile = path.join(dir, 'sessions-index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      const sessions = (data.entries || []).map(e => ({
        sessionId: e.sessionId,
        summary: e.summary || '',
        firstPrompt: e.firstPrompt || '',
        messageCount: e.messageCount || 0,
        created: e.created || null,
        modified: e.modified || null,
        gitBranch: e.gitBranch || '',
        gitBranches: [],
        isSidechain: e.isSidechain || false
      })).filter(s => showArchived ? archivedIds.has(s.sessionId) : !archivedIds.has(s.sessionId));
      sessions.forEach(s => {
        const filePath = path.join(dir, s.sessionId + '.jsonl');
        const custom = getCustomTitle(filePath);
        if (custom) s.summary = custom;
        s.gitBranches = collectBranches(filePath);
        if (s.gitBranches.length) {
          if (!s.gitBranch) s.gitBranch = s.gitBranches[0];
          s.lastGitBranch = s.gitBranches[s.gitBranches.length - 1];
        }
        s.remoteControlled = hasBridgeSession(filePath);
        if (isSkippablePrompt(s.firstPrompt)) s.firstPrompt = findFirstMeaningfulPrompt(filePath);
      });
      const usageMap = getProjectUsageMap(req.params.slug);
      sessions.forEach(s => {
        const u = usageMap[s.sessionId];
        if (u) { s.tokens = u.totals; s.cost = u.cost; s.models = Object.keys(u.byModel || {}); }
      });
      sessions.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
      stampActive(req.params.slug, sessions);
      return res.json(sessions);
    } catch (_) { /* malformed index, fall through to JSONL parsing */ }
  }

  // Fallback: parse .jsonl files directly
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const sessions = files.map(f => {
    const filePath = path.join(dir, f);
    const stat = fs.statSync(filePath);
    const session = {
      sessionId: f.replace('.jsonl', ''),
      summary: '',
      firstPrompt: '',
      messageCount: 0,
      created: null,
      modified: null,
      gitBranch: '',
      lastGitBranch: '',
      gitBranches: [],
      isSidechain: false,
      remoteControlled: false
    };

    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      let userMessages = 0;
      const branchSeen = new Set();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'custom-title' && entry.customTitle) {
            session.summary = entry.customTitle;
          } else if (entry.type === 'bridge-session') {
            session.remoteControlled = true;
          } else if (entry.type === 'user') {
            userMessages++;
            if (userMessages === 1) {
              session.created = entry.timestamp || stat.birthtime.toISOString();
              session.gitBranch = entry.gitBranch || '';
            }
            if (!session.firstPrompt) {
              const raw = typeof entry.message?.content === 'string' ? entry.message.content : '';
              if (!isSkippablePrompt(raw)) session.firstPrompt = normalizePrompt(raw).slice(0, 200);
            }
            if (entry.gitBranch) {
              session.lastGitBranch = entry.gitBranch;
              if (!branchSeen.has(entry.gitBranch)) {
                branchSeen.add(entry.gitBranch);
                session.gitBranches.push(entry.gitBranch);
              }
            }
            session.modified = entry.timestamp || stat.mtime.toISOString();
          }
        } catch (_) { /* malformed JSONL line, skip */ }
      }
      session.messageCount = userMessages;
      if (!session.created) session.created = stat.birthtime.toISOString();
      if (!session.modified) session.modified = stat.mtime.toISOString();
    } catch (_) {
      /* unreadable file, use stat times */
      session.created = stat.birthtime.toISOString();
      session.modified = stat.mtime.toISOString();
    }

    return session;
  });

  const usageMap = getProjectUsageMap(req.params.slug);
  const filtered = sessions.filter(s => s.messageCount > 0 && (showArchived ? archivedIds.has(s.sessionId) : !archivedIds.has(s.sessionId)));
  filtered.forEach(s => {
    const u = usageMap[s.sessionId];
    if (u) { s.tokens = u.totals; s.cost = u.cost; s.models = Object.keys(u.byModel || {}); }
  });
  filtered.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  stampActive(req.params.slug, filtered);
  res.json(filtered);
}));

router.get('/:slug/sessions/search', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const qLower = q.toLowerCase();
  const archivedIds = getArchivedIds(req.params.slug);

  // Load index metadata if available
  const indexMeta = {};
  const indexFile = path.join(dir, 'sessions-index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      for (const e of (data.entries || [])) {
        indexMeta[e.sessionId] = e;
      }
    } catch (_) {}
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !archivedIds.has(f.replace('.jsonl', '')));
  const results = [];

  for (const f of files) {
    const sessionId = f.replace('.jsonl', '');
    const filePath = path.join(dir, f);
    const snippets = [];
    let messageCount = 0;
    let firstPrompt = '';
    let created = null;
    let modified = null;
    let gitBranch = '';
    let lastGitBranch = '';
    const gitBranches = [];
    const branchSeen = new Set();
    let customTitle = '';

    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'custom-title' && entry.customTitle) {
            customTitle = entry.customTitle;
            continue;
          }
          if (entry.type !== 'user' && entry.type !== 'assistant') continue;

          if (entry.type === 'user') {
            messageCount++;
            if (messageCount === 1) {
              created = entry.timestamp;
              gitBranch = entry.gitBranch || '';
            }
            if (!firstPrompt) {
              const raw = typeof entry.message?.content === 'string' ? entry.message.content : '';
              if (!isSkippablePrompt(raw)) firstPrompt = normalizePrompt(raw).slice(0, 200);
            }
            if (entry.gitBranch) {
              lastGitBranch = entry.gitBranch;
              if (!branchSeen.has(entry.gitBranch)) {
                branchSeen.add(entry.gitBranch);
                gitBranches.push(entry.gitBranch);
              }
            }
            modified = entry.timestamp;
          }

          if (snippets.length >= MAX_SNIPPETS) continue;

          const newSnippets = extractEntrySnippets(entry, q, qLower, snippets.length);
          snippets.push(...newSnippets);
        } catch (_) {}
      }
    } catch (_) { continue; }

    // Also search sub-agent conversations
    if (snippets.length < MAX_SNIPPETS) {
      const subagentDir = path.join(dir, sessionId, 'subagents');
      if (fs.existsSync(subagentDir)) {
        try {
          for (const sf of fs.readdirSync(subagentDir).filter(sf => sf.endsWith('.jsonl'))) {
            if (snippets.length >= MAX_SNIPPETS) break;
            try {
              const subLines = fs.readFileSync(path.join(subagentDir, sf), 'utf-8').split('\n').filter(Boolean);
              for (const line of subLines) {
                if (snippets.length >= MAX_SNIPPETS) break;
                try {
                  const entry = JSON.parse(line);
                  snippets.push(...extractEntrySnippets(entry, q, qLower, snippets.length));
                } catch (_) {}
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    }

    // Also check title/metadata fields (custom title, index summary, first prompt)
    const meta = indexMeta[sessionId];
    if (snippets.length === 0) {
      const metaSnippet = extractMetaSnippet([customTitle, meta?.summary, meta?.firstPrompt, firstPrompt], q, qLower);
      if (metaSnippet) snippets.push(metaSnippet);
    }

    if (snippets.length === 0) continue;

    const session = {
      sessionId,
      summary: customTitle || meta?.summary || '',
      firstPrompt: meta?.firstPrompt || firstPrompt,
      messageCount: meta?.messageCount || messageCount,
      created: meta?.created || created,
      modified: meta?.modified || modified,
      gitBranch: meta?.gitBranch || gitBranch,
      lastGitBranch: meta?.lastGitBranch || lastGitBranch,
      gitBranches,
      isSidechain: meta?.isSidechain || false,
      snippets
    };
    results.push(session);
  }

  const usageMap = getProjectUsageMap(req.params.slug);
  results.forEach(s => {
    const u = usageMap[s.sessionId];
    if (u) { s.tokens = u.totals; s.cost = u.cost; s.models = Object.keys(u.byModel || {}); }
  });
  results.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
  res.json(results);
}));

router.get('/:slug/sessions/with-plans', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const plansDir = path.join(CLAUDE_DIR, 'plans');
  let planStems = [];
  if (fs.existsSync(plansDir)) {
    planStems = fs.readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3));
  }
  if (!planStems.length) return res.json([]);

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const sessionIds = [];
  for (const f of files) {
    const sessionId = f.replace('.jsonl', '');
    if (planCache.get(sessionId)) { sessionIds.push(sessionId); continue; }
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const hasPlan = planStems.some(stem => content.includes(stem));
      if (hasPlan) { planCache.set(sessionId, true); sessionIds.push(sessionId); }
    } catch (_) {}
  }
  res.json(sessionIds);
}));

router.get('/:slug/sessions/:sessionId', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const filePath = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const messages = [];
  let isSidechain = false;
  let userMessageCount = 0;
  let firstPrompt = '';
  let indexSummary = '';
  let created = null;
  let hasPlan = planCache.get(sessionId) === true;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.isSidechain) isSidechain = true;
      if (entry.type === 'summary' && entry.summary) indexSummary = entry.summary;
      if (entry.type === 'user') {
        userMessageCount++;
        if (!created && entry.timestamp) created = entry.timestamp;
      }
      if (entry.type === 'user' && !firstPrompt) {
        const c = entry.message?.content;
        let raw = '';
        if (typeof c === 'string' && c.trim()) raw = c;
        else if (Array.isArray(c)) {
          const tb = c.find(b => b.type === 'text' && b.text?.trim());
          if (tb) raw = tb.text;
        }
        if (raw && !isSkippablePrompt(raw)) firstPrompt = normalizePrompt(raw).slice(0, 200);
      }
      if (!hasPlan && entry.type === 'assistant') {
        const content = entry.message && entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.name === 'ExitPlanMode' && block.input && block.input.planFilePath) {
              const stem = path.basename(block.input.planFilePath, '.md');
              hasPlan = fs.existsSync(path.join(CLAUDE_DIR, 'plans', stem + '.md'));
              if (hasPlan) break;
            }
          }
        }
      }
      if (entry.type === 'user' || entry.type === 'assistant') {
        const msg = {
          role: entry.type,
          timestamp: entry.timestamp,
          gitBranch: entry.gitBranch || '',
          model: entry.message?.model || '',
          content: []
        };

        const content = entry.message?.content;
        if (typeof content === 'string') {
          msg.content.push({ type: 'text', text: content });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              msg.content.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              msg.content.push({
                type: 'tool_use',
                name: block.name,
                input: block.input
              });
            } else if (block.type === 'tool_result') {
              let resultText = '';
              if (typeof block.content === 'string') {
                resultText = block.content.slice(0, 2000);
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter(c => c.type === 'text')
                  .map(c => c.text)
                  .join('\n')
                  .slice(0, 2000);
              }
              const tr = { type: 'tool_result', text: resultText };
              if (entry.toolUseResult?.agentId) {
                tr.agentId = entry.toolUseResult.agentId;
                tr.agentType = entry.toolUseResult.agentType || '';
              }
              msg.content.push(tr);
            } else if (block.type === 'thinking') {
              // skip thinking blocks
            }
          }
        }

        if (msg.content.length > 0) {
          messages.push(msg);
        }
      }
    } catch (_) { /* malformed JSONL line, skip */ }
  }

  messages.reverse();
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 20;
  const page = messages.slice(offset, offset + limit);

  const gitBranches = collectBranches(filePath);
  const lastGitBranch = gitBranches.length ? gitBranches[gitBranches.length - 1] : '';
  const usage = getSessionUsage(req.params.slug, sessionId);
  const customTitle = getCustomTitle(filePath);
  planCache.set(sessionId, hasPlan);

  const gitBranch = gitBranches[0] || '';
  const activeList = listAllActiveSessions();
  const isActive = activeList.some(s => s.sessionId === sessionId && s.slug === req.params.slug);
  const archivedIds = getArchivedIds(req.params.slug);
  const stats = {
    messageCount: userMessageCount,
    summary: customTitle || indexSummary || firstPrompt.slice(0, 80) || '',
    firstPrompt,
    created,
    gitBranch,
    gitBranches,
    lastGitBranch,
    isSidechain,
    hasPlan,
    remoteControlled: hasBridgeSession(filePath),
    active: isActive,
    archived: archivedIds.has(sessionId),
  };
  if (usage) {
    stats.tokens = usage.totals;
    stats.cost = (usage.cost && typeof usage.cost.total === 'number') ? usage.cost.total : 0;
    stats.models = Object.keys(usage.byModel || {});
    stats.modelCosts = Object.fromEntries(
      Object.entries(usage.byModel || {}).map(([m, t]) => [m, calcCost(t, m)])
    );
  }

  res.json({ messages: page, total: messages.length, hasMore: offset + limit < messages.length, stats });
}));

router.get('/:slug/sessions/:sessionId/activity', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const filePath = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const items = collectFromJsonl(filePath, null);

  const sessionSubDir = path.join(dir, sessionId);
  if (fs.existsSync(sessionSubDir)) {
    items.push(...collectFromDir(sessionSubDir, 500));
  }

  items.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(a.timestamp) - new Date(b.timestamp);
  });

  const byCategory = { agent: 0, web: 0, shell: 0, file: 0, other: 0 };
  for (const item of items) byCategory[item.category]++;

  res.json({ items, stats: { total: items.length, byCategory } });
}));

router.get('/:slug/sessions/:sessionId/subagents/:agentId', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const agentId = req.params.agentId;
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return res.status(400).json({ error: 'Invalid agent ID' });
  }

  const filePath = path.join(dir, sessionId, 'subagents', 'agent-' + agentId + '.jsonl');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Sub-agent session not found' });

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const msg = {
        role: entry.type,
        timestamp: entry.timestamp,
        model: entry.message?.model || '',
        content: []
      };
      const content = entry.message?.content;
      if (typeof content === 'string') {
        msg.content.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            msg.content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            msg.content.push({ type: 'tool_use', name: block.name, input: block.input });
          } else if (block.type === 'tool_result') {
            let resultText = '';
            if (typeof block.content === 'string') {
              resultText = block.content.slice(0, 2000);
            } else if (Array.isArray(block.content)) {
              resultText = block.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 2000);
            }
            const tr = { type: 'tool_result', text: resultText };
            if (entry.toolUseResult?.agentId) {
              tr.agentId = entry.toolUseResult.agentId;
              tr.agentType = entry.toolUseResult.agentType || '';
            }
            msg.content.push(tr);
          }
        }
      }
      if (msg.content.length > 0) messages.push(msg);
    } catch (_) {}
  }

  messages.reverse();
  res.json({ messages });
}));

router.post('/:slug/sessions/new', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const projectPath = decodeSlug(req.params.slug);
  try {
    launchTerminal(projectPath, 'claude');
    activeSessions.registerPendingNew(req.params.slug);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to open terminal: ' + e.message });
  }
}));

router.post('/:slug/sessions/:sessionId/resume', wrapRoute((req, res) => {

  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const filePath = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const projectPath = decodeSlug(req.params.slug);
  try {
    terminalServer.disconnectFor(req.params.slug, sessionId, 'Resumed in OS terminal.');
    launchTerminal(projectPath, `claude --resume "${sessionId}"`);
    activeSessions.register(req.params.slug, sessionId, 'os-terminal');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to open terminal: ' + e.message });
  }
}));

router.post('/:slug/sessions/:sessionId/deactivate', wrapRoute((req, res) => {
  const slug = req.params.slug;
  if (!safeSlug(slug)) return res.status(400).json({ error: 'Invalid slug' });
  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  activeSessions.deactivate(slug, sessionId);
  terminalServer.disconnectFor(slug, sessionId, 'Closed by user.');
  res.json({ ok: true });
}));

router.post('/:slug/sessions/:sessionId/rename', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const title = (req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (title.length > 500) return res.status(400).json({ error: 'Title too long' });

  const filePath = path.join(dir, sessionId + '.jsonl');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  backup(filePath);
  const line = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n';
  const existing = fs.readFileSync(filePath, 'utf-8');
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  fs.appendFileSync(filePath, (needsNewline ? '\n' : '') + line);

  const indexFile = path.join(dir, 'sessions-index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      const entry = (data.entries || []).find(e => e.sessionId === sessionId);
      if (entry) {
        backup(indexFile);
        entry.summary = title;
        fs.writeFileSync(indexFile, JSON.stringify(data, null, 2), 'utf-8');
      }
    } catch (_) { /* malformed index, skip */ }
  }

  res.json({ ok: true, title });
}));

router.post('/:slug/sessions/:sessionId/archive', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  if (!fs.existsSync(path.join(dir, sessionId + '.jsonl'))) {
    return res.status(404).json({ error: 'Session not found' });
  }

  archiveSession(req.params.slug, sessionId);
  res.json({ ok: true });
}));

router.post('/:slug/sessions/:sessionId/unarchive', wrapRoute((req, res) => {
  const dir = safeSlug(req.params.slug);
  if (!dir) return res.status(400).json({ error: 'Invalid slug' });

  const sessionId = req.params.sessionId;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  unarchiveSession(req.params.slug, sessionId);
  res.json({ ok: true });
}));

module.exports = router;

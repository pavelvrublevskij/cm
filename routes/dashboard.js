const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR, SKILLS_DIR, OUTPUT_STYLES_DIR, MCP_FILE, KEYBINDINGS_FILE, CLAUDE_DIR } = require('../lib/paths');
const { readJson, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { buildIndex, calcCostMultiModel } = require('../lib/usage-index');
const { getCustomTitle } = require('../lib/session-title');
const { collectBranches } = require('../lib/session-branches');
const { stampActive, listAllActiveSessions } = require('../lib/session-status');
const { hasBridgeSession } = require('../lib/session-flags');
const planCache = require('../lib/plan-cache');

const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

function loadPlanStems() {
  if (!fs.existsSync(PLANS_DIR)) return [];
  try { return fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)); }
  catch (_) { return []; }
}

function fileHasPlan(sessionId, filePath, planStems) {
  if (planCache.get(sessionId)) return true;
  if (!planStems.length) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const hasPlan = planStems.some(stem => content.includes(stem));
    if (hasPlan) planCache.set(sessionId, true);
    return hasPlan;
  } catch (_) { return false; }
}

function normalizePrompt(text) {
  const m = (text || '').match(/<command-name>(\/[\w-]+)<\/command-name>/);
  return m ? m[1] : (text || '');
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

router.get('/active-count', wrapRoute((req, res) => {
  const all = listAllActiveSessions();
  const byProject = {};
  for (const s of all) byProject[s.slug] = (byProject[s.slug] || 0) + 1;
  res.json({ total: all.length, byProject });
}));

/** Gather dashboard stats and recent sessions across all projects. */
router.get('/', wrapRoute(async (req, res) => {
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());

  const planStems = loadPlanStems();
  let totalSessions = 0;
  let totalMemory = 0;
  const recentSessions = [];

  for (const d of dirs) {
    const slug = d.name;
    const projectDir = path.join(PROJECTS_DIR, slug);
    const decodedPath = decodeSlug(slug);

    // Count memory files
    const memoryDir = path.join(projectDir, 'memory');
    if (fs.existsSync(memoryDir)) {
      try { totalMemory += fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).length; } catch (_) {}
    }

    // Collect sessions from index or fallback
    const indexFile = path.join(projectDir, 'sessions-index.json');
    if (fs.existsSync(indexFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        const entries = (data.entries || []).filter(e => e.messageCount > 0);
        totalSessions += entries.length;
        for (const e of entries) {
          const filePath = path.join(projectDir, e.sessionId + '.jsonl');
          const custom = getCustomTitle(filePath);
          const gitBranches = collectBranches(filePath);
          recentSessions.push({
            slug,
            projectName: decodedPath,
            sessionId: e.sessionId,
            summary: custom || e.summary || '',
            firstPrompt: isSkippablePrompt(e.firstPrompt) ? findFirstMeaningfulPrompt(filePath) : (e.firstPrompt || ''),
            messageCount: e.messageCount || 0,
            created: e.created || null,
            modified: e.modified || null,
            gitBranch: e.gitBranch || (gitBranches[0] || ''),
            lastGitBranch: gitBranches[gitBranches.length - 1] || '',
            gitBranches,
            hasPlan: fileHasPlan(e.sessionId, filePath, planStems),
            remoteControlled: hasBridgeSession(filePath)
          });
        }
      } catch (_) { /* malformed index */ }
    } else {
      // Fallback: count .jsonl files
      try {
        const jsonls = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        totalSessions += jsonls.length;
        // Parse first line for recent sessions (lightweight)
        for (const f of jsonls) {
          const filePath = path.join(projectDir, f);
          const stat = fs.statSync(filePath);
          try {
            const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
            let firstPrompt = '', created = null, gitBranch = '', lastGitBranch = '', msgCount = 0, customTitle = '';
            const gitBranches = [];
            const branchSeen = new Set();
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'custom-title' && entry.customTitle) {
                  customTitle = entry.customTitle;
                } else if (entry.type === 'user') {
                  msgCount++;
                  if (msgCount === 1) {
                    created = entry.timestamp || stat.birthtime.toISOString();
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
                }
              } catch (_) { /* malformed line */ }
            }
            if (msgCount > 0) {
              recentSessions.push({
                slug,
                projectName: decodedPath,
                sessionId: f.replace('.jsonl', ''),
                summary: customTitle,
                firstPrompt,
                messageCount: msgCount,
                created,
                modified: stat.mtime.toISOString(),
                gitBranch,
                lastGitBranch,
                gitBranches,
                hasPlan: fileHasPlan(f.replace('.jsonl', ''), filePath, planStems),
                remoteControlled: hasBridgeSession(filePath)
              });
            }
          } catch (_) { /* unreadable file */ }
        }
      } catch (_) {}
    }
  }

  // Enrich with token usage
  const usageIndex = buildIndex();
  for (const s of recentSessions) {
    const entry = usageIndex.sessions[s.slug + '/' + s.sessionId];
    if (entry) {
      s.tokens = entry.totals;
      s.cost = calcCostMultiModel(entry.byModel || {}).total;
      s.models = Object.keys(entry.byModel || {});
    }
  }

  // Sort by modified desc, take top 10
  recentSessions.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));

  // Stamp active/activeKind so the green dot renders on dashboard cards.
  // Pass null for the project slug — getActiveKind reads per-session `s.slug` since this is cross-project.
  stampActive(null, recentSessions);

  // Count other resources
  const mcpData = readJson(MCP_FILE, { servers: {} });
  const mcpCount = Object.keys(mcpData.servers || {}).length;
  let skillsCount = 0;
  if (fs.existsSync(SKILLS_DIR)) {
    try { skillsCount = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).length; } catch (_) {}
  }
  let stylesCount = 0;
  if (fs.existsSync(OUTPUT_STYLES_DIR)) {
    try { stylesCount = fs.readdirSync(OUTPUT_STYLES_DIR).filter(f => f.endsWith('.md')).length; } catch (_) {}
  }
  const kbData = readJson(KEYBINDINGS_FILE, { bindings: [] });
  const kbCount = (kbData.bindings || []).reduce((sum, ctx) => sum + Object.keys(ctx.bindings || {}).length, 0);

  const activeOnly = recentSessions.filter(s => s.active);
  const nonActiveRecent = recentSessions.filter(s => !s.active).slice(0, 10);

  res.json({
    stats: {
      projects: dirs.length,
      sessions: totalSessions,
      memoryFiles: totalMemory,
      mcpServers: mcpCount,
      skills: skillsCount,
      outputStyles: stylesCount,
      keybindings: kbCount
    },
    activeSessions: activeOnly,
    recentSessions: nonActiveRecent
  });
}));

module.exports = router;

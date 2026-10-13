const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR, SKILLS_DIR, OUTPUT_STYLES_DIR, MCP_FILE, KEYBINDINGS_FILE, CLAUDE_DIR } = require('../lib/paths');
const { readJson, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { buildIndex, calcCostMultiModel } = require('../lib/usage-index');
const { scanSession, firstMeaningfulPrompt } = require('../lib/session-scan');
const { stampActive, listAllActiveSessions } = require('../lib/session-status');
const planCache = require('../lib/plan-cache');

const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

function loadPlanStems() {
  if (!fs.existsSync(PLANS_DIR)) return [];
  try { return fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)); }
  catch (_) { return []; }
}

function sessionHasPlan(sessionId, meta) {
  if (planCache.get(sessionId)) return true;
  const hasPlan = !!meta?.hasPlan;
  if (hasPlan) planCache.set(sessionId, true);
  return hasPlan;
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

router.get('/active-count', wrapRoute((req, res) => {
  // listAllActiveSessions() carries read-only viewer instances as separate additive rows (a
  // session can have several), but the dashboard/project card for that session shows just one dot
  // (getActiveKind's os/browser/readonly precedence). Dedupe by session here to match — one count
  // per session regardless of how many rows/kinds contributed to it.
  const all = listAllActiveSessions();
  const seen = new Set();
  const byProject = {};
  for (const s of all) {
    const key = `${s.slug}|${s.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byProject[s.slug] = (byProject[s.slug] || 0) + 1;
  }
  res.json({ total: seen.size, byProject });
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
          const meta = scanSession(filePath, planStems.length ? planStems : null);
          const custom = meta ? (meta.customTitle || meta.summaryTitle) : '';
          const gitBranches = meta ? meta.gitBranches : [];
          recentSessions.push({
            slug,
            projectName: decodedPath,
            sessionId: e.sessionId,
            summary: custom || e.summary || '',
            firstPrompt: isSkippablePrompt(e.firstPrompt) ? firstMeaningfulPrompt(meta, isSkippablePrompt, normalizePrompt) : (e.firstPrompt || ''),
            messageCount: e.messageCount || 0,
            created: e.created || null,
            modified: e.modified || null,
            gitBranch: e.gitBranch || (gitBranches[0] || ''),
            lastGitBranch: gitBranches[gitBranches.length - 1] || '',
            gitBranches,
            hasPlan: sessionHasPlan(e.sessionId, meta),
            remoteControlled: !!meta?.remoteControlled
          });
        }
      } catch (_) { /* malformed index */ }
    } else {
      // Fallback: count .jsonl files
      try {
        const jsonls = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        totalSessions += jsonls.length;
        for (const f of jsonls) {
          const sessionId = f.replace('.jsonl', '');
          const meta = scanSession(path.join(projectDir, f), planStems.length ? planStems : null);
          if (!meta || meta.userCount === 0) continue;
          recentSessions.push({
            slug,
            projectName: decodedPath,
            sessionId,
            summary: meta.customTitle,
            firstPrompt: firstMeaningfulPrompt(meta, isSkippablePrompt, normalizePrompt),
            messageCount: meta.userCount,
            created: meta.firstUserTimestamp || meta.stat.birthtime.toISOString(),
            modified: meta.stat.mtime.toISOString(),
            gitBranch: meta.firstUserBranch,
            lastGitBranch: meta.lastUserBranch,
            gitBranches: meta.gitBranches,
            hasPlan: sessionHasPlan(sessionId, meta),
            remoteControlled: meta.remoteControlled
          });
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

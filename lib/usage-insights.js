const { spawn } = require('child_process');
const { DATA_DIR } = require('./paths');
const { decodeSlug } = require('./slug');
const { addTokens, emptyTokens, calcCostMultiModel } = require('./usage-index');
const { getFilteredByModel, sumByModel, aggregateByPeriod } = require('./usage-filters');
const { listMarks, markImpact, markInPeriod } = require('./usage-marks');

const TOP_N = 10;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

// 'default' leaves the choice to the user's claude config (no flag passed).
const INSIGHT_MODELS = ['default', 'sonnet', 'opus', 'haiku', 'fable'];
const INSIGHT_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

// Same reason as terminal-server's list: when this server was started from inside a Claude Code
// session, these make the spawned claude a nested child of that session.
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID'
];

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function nullableRound(n, digits = 2) {
  return n == null ? null : round(n, digits);
}

function tokenSum(t) {
  return t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
}

function tokenRatios(t) {
  const promptSide = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
  return {
    cacheHitRatio: promptSide ? round(t.cache_read_input_tokens / promptSide, 3) : 0,
    cacheWriteShare: promptSide ? round(t.cache_creation_input_tokens / promptSide, 3) : 0,
    outputShare: tokenSum(t) ? round(t.output_tokens / tokenSum(t), 4) : 0
  };
}

/**
 * Per-session and per-model usage for the given filters. Shared by the AI analysis and the free
 * rule-based hints. Sessions are sorted most expensive first and carry their project slug.
 */
function collectScope(index, { projects, models = new Set(), from, to, fromTime, toTime }) {
  const byModel = {};
  const byProject = {};
  const sessions = [];

  for (const s of Object.values(index.sessions)) {
    if (projects.size && !projects.has(s.slug)) continue;
    const sByModel = getFilteredByModel(s, models, from, to, fromTime, toTime);
    if (!Object.keys(sByModel).length) continue;

    const totals = sumByModel(sByModel);
    const cost = calcCostMultiModel(sByModel).total;
    const mainModel = Object.entries(sByModel).sort((a, b) => tokenSum(b[1]) - tokenSum(a[1]))[0][0];
    sessions.push({ slug: s.slug, project: decodeSlug(s.slug), sessionId: s.sessionId, mainModel, cost: round(cost), tokens: tokenSum(totals), ...tokenRatios(totals) });

    if (!byProject[s.slug]) byProject[s.slug] = { project: decodeSlug(s.slug), sessions: 0, byModel: {} };
    byProject[s.slug].sessions++;
    for (const [m, t] of Object.entries(sByModel)) {
      if (!byModel[m]) byModel[m] = emptyTokens();
      addTokens(byModel[m], t);
      if (!byProject[s.slug].byModel[m]) byProject[s.slug].byModel[m] = emptyTokens();
      addTokens(byProject[s.slug].byModel[m], t);
    }
  }
  sessions.sort((a, b) => b.cost - a.cost);

  const totals = sumByModel(byModel);
  const cost = calcCostMultiModel(byModel);
  const modelStats = Object.entries(byModel).map(([model, t]) => {
    const c = calcCostMultiModel({ [model]: t }).total;
    return { model, tokens: tokenSum(t), cost: round(c), costShare: cost.total ? round(c / cost.total, 3) : 0, ...tokenRatios(t) };
  }).sort((a, b) => b.cost - a.cost);

  return { byModel, byProject, sessions, totals, cost, modelStats };
}

/** Aggregate usage stats for the given scope — the data the insights agent reasons over. */
function buildInsightStats(index, filters) {
  const { projects, models = new Set(), from, to, fromTime, toTime, today } = filters;
  const { byProject, sessions, totals, cost, modelStats } = collectScope(index, filters);
  const sessionCosts = sessions.map(s => s.cost).sort((a, b) => a - b);
  const median = sessionCosts.length ? sessionCosts[Math.floor(sessionCosts.length / 2)] : 0;

  const projectList = Object.values(byProject).map(p => {
    const t = sumByModel(p.byModel);
    return { project: p.project, sessions: p.sessions, tokens: tokenSum(t), cost: round(calcCostMultiModel(p.byModel).total), ...tokenRatios(t) };
  }).sort((a, b) => b.cost - a.cost).slice(0, TOP_N);

  const daily = aggregateByPeriod(index, 'day', models, projects, from, to, fromTime, toTime)
    .reverse()
    .map(p => ({ day: p.label, tokens: tokenSum(p), cost: round(p.cost) }));

  const marks = listMarks(projects)
    .filter(m => markInPeriod(m, from, to))
    .map(m => {
      const impact = markImpact(index, m, today);
      return {
        date: m.date,
        title: m.title,
        description: m.description,
        scope: m.project ? decodeSlug(m.project) : 'global',
        windowDays: impact.window,
        afterWindowStillRunning: impact.after.partial,
        avgCostPerDayBefore: round(impact.before.avgCostPerDay),
        avgCostPerDayAfter: round(impact.after.avgCostPerDay),
        avgTokensPerDayBefore: Math.round(impact.before.avgTokensPerDay),
        avgTokensPerDayAfter: Math.round(impact.after.avgTokensPerDay),
        costPerSessionBefore: nullableRound(impact.before.costPerSession),
        costPerSessionAfter: nullableRound(impact.after.costPerSession),
        cacheHitPctBefore: nullableRound(impact.before.cacheHitPct, 1),
        cacheHitPctAfter: nullableRound(impact.after.cacheHitPct, 1),
        tokensPerRequestBefore: nullableRound(impact.before.tokensPerRequest, 0),
        tokensPerRequestAfter: nullableRound(impact.after.tokensPerRequest, 0)
      };
    });

  return {
    scope: {
      projects: projects.size ? Array.from(projects).map(decodeSlug) : 'all',
      models: models.size ? Array.from(models) : 'all',
      from: from ? from + (fromTime ? ' ' + fromTime : '') : 'beginning',
      to: to ? to + (toTime ? ' ' + toTime : '') : 'now'
    },
    totals: { ...totals, ...tokenRatios(totals) },
    cost: { input: round(cost.input), output: round(cost.output), cacheWrite: round(cost.cache_write), cacheRead: round(cost.cache_read), total: round(cost.total) },
    sessions: {
      count: sessions.length,
      avgCost: sessions.length ? round(cost.total / sessions.length) : 0,
      medianCost: median,
      mostExpensive: sessions.slice(0, TOP_N).map(({ slug, ...rest }) => rest)
    },
    models: modelStats,
    topProjects: projectList,
    daily,
    marks
  };
}

function buildPrompt(stats) {
  return [
    'You are an efficiency coach for a developer using Claude Code (the CLI coding agent).',
    'Below are aggregated token usage statistics from their local Claude Code transcripts, as JSON.',
    '',
    'Field notes:',
    '- cacheHitRatio = cache_read / (input + cache_write + cache_read). Higher is cheaper; Claude Code normally runs well above 0.8.',
    '- cacheWriteShare high means context keeps getting rebuilt (new sessions, /clear, edited CLAUDE.md, switching models, idle >5 min).',
    '- outputShare is output tokens over all tokens. Subagent token totals are counted as output.',
    '- "marks" are events the user recorded (e.g. "added a code optimization skill"), compared over windowDays days before vs windowDays days from the mark on (afterWindowStillRunning: the after window has not finished yet).',
    '  Judge a mark by its efficiency fields (costPerSession, cacheHitPct, tokensPerRequest): they do not grow with workload.',
    '  avgTokensPerDay / avgCostPerDay are volume and mostly reflect how much the user worked.',
    '- Costs are API-price estimates in USD; subscription users care about the relative numbers.',
    '',
    'Write a concise Markdown report with these sections:',
    '## Summary — 2-3 sentences on overall efficiency.',
    '## Efficiency gaps — each gap as a bullet: what it is, the numbers that show it, and the estimated impact.',
    '## Suggestions — concrete, actionable Claude Code habits or config changes that close those gaps',
    '  (e.g. model choice per task, /compact or /clear timing, shorter CLAUDE.md, subagents for exploration, skills, plan mode).',
    '  Order by expected savings.',
    '## Marks — for each mark, say whether usage improved or got worse after it and how confident that reading is. Omit if there are no marks.',
    '',
    'When you mention a session, write its full sessionId in backticks so it can be linked.',
    'Only claim what the data supports. Do not ask follow-up questions.',
    '',
    '```json',
    JSON.stringify(stats, null, 2),
    '```'
  ].join('\n');
}

/** Our environment minus the variables that would make a spawned claude a child of our own session. */
function sessionFreeEnv(base) {
  const env = Object.assign({}, base);
  for (const key of INHERITED_SESSION_VARS) delete env[key];
  return env;
}

function claudeEnv(base) {
  return Object.assign(sessionFreeEnv(base), { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
}

/**
 * Run the user's own `claude` CLI headless with the prompt on stdin. No tools, no MCP servers,
 * and no session transcript, so the analysis neither acts on the machine nor shows up in usage.
 */
function claudeArgs({ model, effort } = {}) {
  const args = ['-p', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--output-format', 'text'];
  if (model && model !== 'default') args.push('--model', model);
  if (effort && effort !== 'default') args.push('--effort', effort);
  return args;
}

function runClaude(prompt, opts) {
  const args = claudeArgs(opts);
  const { cmd, cmdArgs } = process.platform === 'win32'
    ? { cmd: 'cmd.exe', cmdArgs: ['/c', 'claude'].concat(args) }
    : { cmd: '/bin/sh', cmdArgs: ['-c', 'claude "$@"', '--'].concat(args) };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd: DATA_DIR, env: claudeEnv(process.env), windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude did not answer within ' + (RUN_TIMEOUT_MS / 60000) + ' minutes'));
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error((err || out).trim() || 'claude exited with code ' + code));
    });
    child.stdin.end(prompt);
  });
}

/** Session ids the report may mention (the most expensive ones), with their project slug for links. */
function sessionLinksFor(index, filters) {
  return collectScope(index, filters).sessions.slice(0, TOP_N).map(s => ({ sessionId: s.sessionId, slug: s.slug }));
}

module.exports = { sessionFreeEnv, collectScope, buildInsightStats, buildPrompt, sessionLinksFor, runClaude, claudeArgs, claudeEnv, INSIGHT_MODELS, INSIGHT_EFFORTS };

const router = require('express').Router();
const { wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { getModelPricingMap, calcCostMultiModel, addTokens, emptyTokens, buildIndex } = require('../lib/usage-index');
const { getLastFetchedAt, PRICING_URL, resolveModelPrice } = require('../lib/pricing');
const { getFilteredByModel, sumByModel, aggregateByPeriod } = require('../lib/usage-filters');
const marks = require('../lib/usage-marks');
const insights = require('../lib/usage-insights');

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function filterModels(req) {
  const pricingMap = getModelPricingMap();
  const out = new Set();
  for (const m of toArray(req.query.models)) {
    if (resolveModelPrice(m, pricingMap)) out.add(m);
  }
  return out;
}

function filterProjects(req) {
  return new Set(toArray(req.query.projects));
}

function filterDateRange(req) {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  const reTime = /^\d{2}:\d{2}$/;
  const from = req.query.from && reDate.test(req.query.from) ? req.query.from : null;
  const to = req.query.to && reDate.test(req.query.to) ? req.query.to : null;
  const fromTime = req.query.fromTime && reTime.test(req.query.fromTime) ? req.query.fromTime : null;
  const toTime = req.query.toTime && reTime.test(req.query.toTime) ? req.query.toTime : null;
  return { from, to, fromTime, toTime };
}

/** GET /api/usage/summary */
router.get('/summary', wrapRoute((req, res) => {
  const models = filterModels(req);
  const projects = filterProjects(req);
  const { from, to, fromTime, toTime } = filterDateRange(req);
  const index = buildIndex();
  const sessions = Object.values(index.sessions);
  const byModel = {};
  const slugs = new Set();
  let sessionCount = 0;

  const allModels = new Set();
  const allProjects = {};
  for (const s of sessions) {
    for (const m of Object.keys(s.byModel || {})) allModels.add(m);
    if (!allProjects[s.slug]) allProjects[s.slug] = decodeSlug(s.slug);
  }

  for (const s of sessions) {
    if (projects.size && !projects.has(s.slug)) continue;
    const sByModel = getFilteredByModel(s, models, from, to, fromTime, toTime);
    if (!Object.keys(sByModel).length) continue;

    for (const [m, tokens] of Object.entries(sByModel)) {
      if (!byModel[m]) byModel[m] = emptyTokens();
      addTokens(byModel[m], tokens);
    }
    slugs.add(s.slug);
    sessionCount++;
  }

  const totals = sumByModel(byModel);
  const cost = calcCostMultiModel(byModel);

  res.json({
    totals,
    byModel,
    cost,
    sessionCount,
    projectCount: slugs.size,
    modelPricing: getModelPricingMap(),
    pricingUpdated: getLastFetchedAt(),
    pricingSource: PRICING_URL,
    activeModels: Array.from(models),
    activeProjects: Array.from(projects),
    activeFrom: from,
    activeTo: to,
    allModels: Array.from(allModels).sort(),
    allProjects: Object.entries(allProjects).map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name))
  });
}));

/** GET /api/usage/project/:slug */
router.get('/project/:slug', wrapRoute((req, res) => {
  const { from, to, fromTime, toTime } = filterDateRange(req);
  const index = buildIndex();
  const totals = emptyTokens();
  const byModel = {};
  let sessionCount = 0;

  for (const s of Object.values(index.sessions)) {
    if (s.slug !== req.params.slug) continue;
    const sByModel = getFilteredByModel(s, new Set(), from, to, fromTime, toTime);
    if (!Object.keys(sByModel).length) continue;
    sessionCount++;
    for (const [m, tokens] of Object.entries(sByModel)) {
      if (!byModel[m]) byModel[m] = emptyTokens();
      addTokens(byModel[m], tokens);
      addTokens(totals, tokens);
    }
  }

  const cost = calcCostMultiModel(byModel);

  res.json({
    slug: req.params.slug,
    totals,
    byModel,
    cost,
    sessionCount,
    activeFrom: from,
    activeTo: to
  });
}));

/** GET /api/usage/by-period?group=hour|day|week|month|year */
router.get('/by-period', wrapRoute((req, res) => {
  const group = ['hour', 'day', 'week', 'month', 'year'].includes(req.query.group) ? req.query.group : 'month';
  const models = filterModels(req);
  const projects = filterProjects(req);
  const { from, to, fromTime, toTime } = filterDateRange(req);
  const index = buildIndex();
  res.json({ periods: aggregateByPeriod(index, group, models, projects, from, to, fromTime, toTime) });
}));

/** GET /api/usage/by-project */
router.get('/by-project', wrapRoute((req, res) => {
  const models = filterModels(req);
  const projects = filterProjects(req);
  const { from, to, fromTime, toTime } = filterDateRange(req);
  const index = buildIndex();
  const result = {};

  for (const s of Object.values(index.sessions)) {
    if (projects.size && !projects.has(s.slug)) continue;
    const sByModel = getFilteredByModel(s, models, from, to, fromTime, toTime);
    if (!Object.keys(sByModel).length) continue;

    if (!result[s.slug]) {
      result[s.slug] = { slug: s.slug, name: decodeSlug(s.slug), sessionCount: 0, byModel: {}, ...emptyTokens() };
    }
    result[s.slug].sessionCount++;
    for (const [m, tokens] of Object.entries(sByModel)) {
      if (!result[s.slug].byModel[m]) result[s.slug].byModel[m] = emptyTokens();
      addTokens(result[s.slug].byModel[m], tokens);
      addTokens(result[s.slug], tokens);
    }
  }

  const list = Object.values(result)
    .map(p => ({ ...p, cost: calcCostMultiModel(p.byModel).total }))
    .filter(p => p.cost > 0)
    .sort((a, b) => b.cost - a.cost);

  res.json({ projects: list });
}));

function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** GET /api/usage/marks?projects=...&from=...&to=... — marks in the period, with before/after impact within it */
router.get('/marks', wrapRoute((req, res) => {
  const { from, to } = filterDateRange(req);
  const index = buildIndex();
  const today = localToday();
  const list = marks.listMarks(filterProjects(req))
    .filter(m => marks.markInPeriod(m, from, to))
    .map(m => ({
      ...m,
      projectName: m.project ? decodeSlug(m.project) : null,
      impact: marks.markImpact(index, m, today)
    }));
  res.json({ marks: list });
}));

/** POST /api/usage/marks */
router.post('/marks', wrapRoute((req, res) => {
  const result = marks.createMark(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.mark);
}));

/** PUT /api/usage/marks/:id */
router.put('/marks/:id', wrapRoute((req, res) => {
  const result = marks.updateMark(req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.notFound) return res.status(404).json({ error: 'Mark not found' });
  res.json(result.mark);
}));

/** DELETE /api/usage/marks/:id */
router.delete('/marks/:id', wrapRoute((req, res) => {
  if (!marks.deleteMark(req.params.id)) return res.status(404).json({ error: 'Mark not found' });
  res.json({ ok: true });
}));

/** POST /api/usage/insights?projects=...&from=...&to=... { model, effort } — runs the local claude CLI over usage stats */
router.post('/insights', wrapRoute(async (req, res) => {
  const model = (req.body && req.body.model) || 'default';
  const effort = (req.body && req.body.effort) || 'default';
  if (!insights.INSIGHT_MODELS.includes(model)) return res.status(400).json({ error: 'Unknown model: ' + model });
  if (!insights.INSIGHT_EFFORTS.includes(effort)) return res.status(400).json({ error: 'Unknown effort: ' + effort });
  const { from, to, fromTime, toTime } = filterDateRange(req);
  const stats = insights.buildInsightStats(buildIndex(), { projects: filterProjects(req), models: filterModels(req), from, to, fromTime, toTime, today: localToday() });
  if (!stats.sessions.count) return res.status(400).json({ error: 'No usage data for the current filters' });
  const report = await insights.runClaude(insights.buildPrompt(stats), { model, effort });
  res.json({ report, model, effort, generatedAt: new Date().toISOString() });
}));

module.exports = router;

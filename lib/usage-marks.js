const crypto = require('crypto');
const { USAGE_MARKS_FILE } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');
const { dayInRange, sumByModel, utcHourKeyToLocal } = require('./usage-filters');
const { addTokens, emptyTokens, calcCostMultiModel } = require('./usage-index');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Days compared before vs after a mark; chosen per mark when it is added.
const MARK_WINDOWS = [7, 14, 30];
const DEFAULT_WINDOW = 7;

function readMarks() {
  const data = readJson(USAGE_MARKS_FILE, { marks: [] });
  return Array.isArray(data.marks) ? data.marks : [];
}

function writeMarks(marks) {
  writeDataJson(USAGE_MARKS_FILE, { marks });
}

/** Validate a mark payload. Returns { mark } or { error }. */
function validateMark(body) {
  const date = String(body.date || '');
  const title = String(body.title || '').trim();
  if (!DATE_RE.test(date)) return { error: 'date must be YYYY-MM-DD' };
  if (!title) return { error: 'title is required' };
  const window = body.window == null ? DEFAULT_WINDOW : Number(body.window);
  if (!MARK_WINDOWS.includes(window)) return { error: 'window must be one of ' + MARK_WINDOWS.join(', ') + ' days' };
  return {
    mark: {
      date,
      title,
      description: String(body.description || '').trim(),
      project: body.project ? String(body.project) : null,
      window
    }
  };
}

/** Global marks plus marks of the given projects (all marks when no project filter). */
function listMarks(projects) {
  return readMarks()
    .filter(m => !m.project || !projects.size || projects.has(m.project))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function createMark(body) {
  const { mark, error } = validateMark(body);
  if (error) return { error };
  const marks = readMarks();
  const created = { id: crypto.randomUUID(), ...mark, createdAt: new Date().toISOString() };
  marks.push(created);
  writeMarks(marks);
  return { mark: created };
}

function updateMark(id, body) {
  const { mark, error } = validateMark(body);
  if (error) return { error };
  const marks = readMarks();
  const idx = marks.findIndex(m => m.id === id);
  if (idx === -1) return { notFound: true };
  marks[idx] = { ...marks[idx], ...mark };
  writeMarks(marks);
  return { mark: marks[idx] };
}

function deleteMark(id) {
  const marks = readMarks();
  const next = marks.filter(m => m.id !== id);
  if (next.length === marks.length) return false;
  writeMarks(next);
  return true;
}

function shiftDay(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Usage of the given projects on local days from..to. Volume (tokens and cost per active day)
 * grows with how much you worked; the efficiency figures (cost per session, cache hit %, tokens
 * per request) don't, so they show whether a change actually helped.
 */
function windowStats(index, projects, from, to) {
  const byModel = {};
  const days = new Set();
  const sessions = new Set();
  let requests = 0;
  for (const s of Object.values(index.sessions)) {
    if (projects.size && !projects.has(s.slug)) continue;
    for (const [hourKey, modelTokens] of Object.entries(s.hourly || {})) {
      const { localDay } = utcHourKeyToLocal(hourKey);
      if (!dayInRange(localDay, from, to)) continue;
      for (const [m, t] of Object.entries(modelTokens)) {
        if (!byModel[m]) byModel[m] = emptyTokens();
        addTokens(byModel[m], t);
      }
      days.add(localDay);
      sessions.add(s.slug + '/' + s.sessionId);
      requests += (s.hourlyRequests || {})[hourKey] || 0;
    }
  }
  const t = sumByModel(byModel);
  const tokens = t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
  const promptSide = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
  const cost = calcCostMultiModel(byModel).total;
  return {
    from, to,
    activeDays: days.size,
    sessions: sessions.size,
    requests,
    tokens, cost,
    avgTokensPerDay: days.size ? tokens / days.size : 0,
    avgCostPerDay: days.size ? cost / days.size : 0,
    costPerSession: sessions.size ? cost / sessions.size : null,
    cacheHitPct: promptSide ? t.cache_read_input_tokens / promptSide * 100 : null,
    tokensPerRequest: requests ? tokens / requests : null
  };
}

function pctChange(before, after) {
  if (!before || after == null) return null;
  return (after - before) / before * 100;
}

function ptsChange(before, after) {
  if (before == null || after == null) return null;
  return after - before;
}

/** Whether a mark's date falls inside the selected period (open ends allowed). */
function markInPeriod(mark, from, to) {
  return (!from || mark.date >= from) && (!to || mark.date <= to);
}

/**
 * Compare average daily usage over the mark's window: the `window` days before the mark vs the
 * `window` days starting on the mark (cut at today while that window is still running — then
 * `after.partial` is true). Averages are per active day (days with usage), so idle days don't
 * skew the result. Scoped to the mark's project, or to every project for a global mark.
 */
function markImpact(index, mark, today) {
  const window = MARK_WINDOWS.includes(mark.window) ? mark.window : DEFAULT_WINDOW;
  const projects = mark.project ? new Set([mark.project]) : new Set();
  const before = windowStats(index, projects, shiftDay(mark.date, -window), shiftDay(mark.date, -1));
  const plannedEnd = shiftDay(mark.date, window - 1);
  const afterTo = today && plannedEnd > today ? today : plannedEnd;
  const after = { ...windowStats(index, projects, mark.date, afterTo), partial: afterTo !== plannedEnd };
  return {
    window,
    before,
    after,
    tokensChangePct: pctChange(before.avgTokensPerDay, after.avgTokensPerDay),
    costChangePct: pctChange(before.avgCostPerDay, after.avgCostPerDay),
    costPerSessionChangePct: pctChange(before.costPerSession, after.costPerSession),
    tokensPerRequestChangePct: pctChange(before.tokensPerRequest, after.tokensPerRequest),
    cacheHitChangePts: ptsChange(before.cacheHitPct, after.cacheHitPct)
  };
}

module.exports = { readMarks, listMarks, createMark, updateMark, deleteMark, markImpact, markInPeriod, shiftDay, MARK_WINDOWS };

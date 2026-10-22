const crypto = require('crypto');
const { USAGE_MARKS_FILE } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');
const { aggregateByPeriod } = require('./usage-filters');

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

function windowStats(index, projects, from, to) {
  const periods = aggregateByPeriod(index, 'day', new Set(), projects, from, to);
  const tokens = periods.reduce((s, p) => s + p.input_tokens + p.output_tokens + p.cache_creation_input_tokens + p.cache_read_input_tokens, 0);
  const cost = periods.reduce((s, p) => s + p.cost, 0);
  const days = periods.length;
  return {
    from, to, activeDays: days,
    tokens, cost,
    avgTokensPerDay: days ? tokens / days : 0,
    avgCostPerDay: days ? cost / days : 0
  };
}

function pctChange(before, after) {
  if (!before) return null;
  return (after - before) / before * 100;
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
    costChangePct: pctChange(before.avgCostPerDay, after.avgCostPerDay)
  };
}

module.exports = { readMarks, listMarks, createMark, updateMark, deleteMark, markImpact, markInPeriod, shiftDay, MARK_WINDOWS };

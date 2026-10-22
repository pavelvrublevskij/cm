const fs = require('fs');
const path = require('path');
const { GLOBAL_CLAUDE_MD, SKILLS_DIR, PLUGINS_DIR, USAGE_MARK_DISMISSED_FILE } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const { slugForPath } = require('./project-list');
const { calcCostMultiModel } = require('./usage-index');
const { utcHourKeyToLocal } = require('./usage-filters');
const { readMarks, markInPeriod } = require('./usage-marks');

/** Local YYYY-MM-DD of a Date. */
function localDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function mtimeDay(file) {
  try { return localDay(fs.statSync(file).mtime); } catch (_) { return null; }
}

/** Skill folders in a skills dir, each with the day its SKILL.md last changed. */
function skillDays(dir) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch (_) { return []; }
  return names
    .map(name => ({ name, day: mtimeDay(path.join(dir, name, 'SKILL.md')) }))
    .filter(s => s.day);
}

function suggestion(type, date, project, subject, title, description) {
  return { key: [type, project || 'global', date, subject].join('|'), type, date, project, title, description };
}

/** CLAUDE.md edits and skill changes, globally and in each project's folder. */
function configSuggestions(slugs) {
  const out = [];
  const globalMd = mtimeDay(GLOBAL_CLAUDE_MD);
  if (globalMd) out.push(suggestion('claude-md', globalMd, null, 'CLAUDE.md', 'Edited global CLAUDE.md', 'Last change to ~/.claude/CLAUDE.md'));
  for (const s of skillDays(SKILLS_DIR)) {
    out.push(suggestion('skill', s.day, null, s.name, 'Changed skill ' + s.name, 'Last change to ~/.claude/skills/' + s.name + '/SKILL.md'));
  }
  for (const slug of slugs) {
    const dir = decodeSlug(slug);
    for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const day = mtimeDay(path.join(dir, rel));
      if (day) out.push(suggestion('claude-md', day, slug, rel, 'Edited ' + rel.replace(/\\/g, '/'), 'Last change to ' + rel.replace(/\\/g, '/') + ' in this project'));
    }
    for (const s of skillDays(path.join(dir, '.claude', 'skills'))) {
      out.push(suggestion('skill', s.day, slug, s.name, 'Changed skill ' + s.name, 'Last change to .claude/skills/' + s.name + '/SKILL.md in this project'));
    }
  }
  return out;
}

/** Plugin installs from Claude Code's installed_plugins.json. */
function pluginSuggestions() {
  const data = readJson(path.join(PLUGINS_DIR, 'installed_plugins.json'), {});
  const out = [];
  for (const [name, installs] of Object.entries(data.plugins || {})) {
    for (const inst of Array.isArray(installs) ? installs : []) {
      const at = inst && inst.installedAt ? new Date(inst.installedAt) : null;
      if (!at || isNaN(at)) continue;
      const project = inst.scope === 'project' && inst.projectPath ? slugForPath(inst.projectPath) : null;
      const short = name.split('@')[0];
      out.push(suggestion('plugin', localDay(at), project, name, 'Installed plugin ' + short, 'Plugin ' + name + ' installed'));
    }
  }
  return out;
}

function shortModel(model) {
  return model.replace(/^claude-/, '');
}

/**
 * Days the main model (most cost) changed and then held for the next active day too, so a
 * one-off switch isn't suggested. With one project it is that project's switch; otherwise it is
 * computed across all projects and suggested as a global mark.
 */
function modelSwitchSuggestions(index, projects) {
  const project = projects.size === 1 ? Array.from(projects)[0] : null;
  if (!project) projects = new Set();
  const days = {};
  for (const s of Object.values(index.sessions)) {
    if (projects.size && !projects.has(s.slug)) continue;
    for (const [hourKey, modelTokens] of Object.entries(s.hourly || {})) {
      const day = utcHourKeyToLocal(hourKey).localDay;
      if (!days[day]) days[day] = {};
      for (const [m, t] of Object.entries(modelTokens)) {
        days[day][m] = (days[day][m] || 0) + calcCostMultiModel({ [m]: t }).total;
      }
    }
  }
  const main = Object.keys(days).sort().map(day => {
    const [model] = Object.entries(days[day]).sort((a, b) => b[1] - a[1])[0] || [];
    return { day, model };
  }).filter(d => d.model);
  const out = [];
  for (let i = 1; i < main.length - 1; i++) {
    const prev = main[i - 1].model;
    const cur = main[i].model;
    if (cur !== prev && main[i + 1].model === cur) {
      out.push(suggestion('model', main[i].day, project, cur, 'Main model switched to ' + shortModel(cur),
        'Most of the cost moved from ' + shortModel(prev) + ' to ' + shortModel(cur)));
    }
  }
  return out;
}

/**
 * Folds same-day changes of one type and scope into a single suggestion (a bulk skill install
 * would otherwise suggest dozens of marks). `noun` names the items, e.g. 'skills'.
 */
function groupSameDay(list, type, noun, verb) {
  const groups = {};
  const rest = [];
  for (const s of list) {
    if (s.type !== type) { rest.push(s); continue; }
    const k = (s.project || 'global') + '|' + s.date;
    (groups[k] = groups[k] || []).push(s);
  }
  for (const items of Object.values(groups)) {
    if (items.length === 1) { rest.push(items[0]); continue; }
    const names = items.map(s => s.key.split('|')[3].split('@')[0]).sort();
    const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '');
    rest.push(suggestion(type, items[0].date, items[0].project, items.length + ' ' + noun,
      verb + ' ' + items.length + ' ' + noun, shown));
  }
  return rest;
}

function readDismissed() {
  const data = readJson(USAGE_MARK_DISMISSED_FILE, { keys: [] });
  return new Set(Array.isArray(data.keys) ? data.keys : []);
}

function dismissSuggestion(key) {
  const keys = readDismissed();
  keys.add(String(key));
  writeDataJson(USAGE_MARK_DISMISSED_FILE, { keys: Array.from(keys) });
}

/**
 * Changes worth marking, inside the selected period and projects: CLAUDE.md edits, skill
 * changes, plugin installs and main-model switches. Leaves out dismissed ones and ones that
 * already have a mark (same date, scope and title). Newest first.
 */
function listSuggestions(index, { projects, from, to }) {
  const slugs = new Set();
  for (const s of Object.values(index.sessions)) {
    if (!projects.size || projects.has(s.slug)) slugs.add(s.slug);
  }
  const dismissed = readDismissed();
  const existing = new Set(readMarks().map(m => [m.date, m.project || 'global', m.title].join('|')));
  let all = configSuggestions(slugs).concat(pluginSuggestions(), modelSwitchSuggestions(index, projects));
  all = groupSameDay(groupSameDay(all, 'skill', 'skills', 'Changed'), 'plugin', 'plugins', 'Installed');
  return all
    .filter(s => !s.project || !projects.size || projects.has(s.project))
    .filter(s => markInPeriod(s, from, to))
    .filter(s => !dismissed.has(s.key))
    .filter(s => !existing.has([s.date, s.project || 'global', s.title].join('|')))
    .map(s => ({ ...s, projectName: s.project ? decodeSlug(s.project) : null }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { listSuggestions, dismissSuggestion, modelSwitchSuggestions };

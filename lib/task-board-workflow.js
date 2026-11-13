const path = require('path');
const crypto = require('crypto');
const { SKILLS_DIR, AGENTS_DIR, PLUGINS_DIR, SETTINGS_FILE } = require('./paths');
const { readJson } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const { listSkills } = require('./skill-list');
const { readFrontmatterDir } = require('./frontmatter');

const STAGE_TYPES = ['skill', 'agent', 'prompt'];
const MAX_STAGES = 10;
const MAX_STAGE_TITLE = 40;
const MAX_STAGE_PROMPT = 4000;
const MAX_BRANCHES = 4;
const MAX_BRANCH_WHEN = 200;
const MAX_POS = 5000;
const STAGE_ID_RE = /^s-[a-z0-9]{6,16}$/;
const SOURCE_RANK = { project: 0, global: 1, plugin: 2 };

// Recommended flow: one stage per phase, filled with the skill whose name matches it (the description
// only breaks ties). Plan, Implement and Review are always there (a plain prompt when no skill fits);
// Test only when a skill fits.
const PHASES = [
  { title: 'Plan', re: /\b(plan\w*|brainstorm\w*|spec|specs|specification|architect\w*)\b/i, always: true,
    prompt: 'Analyze the task and write a short implementation plan before changing code.' },
  { title: 'Implement', re: /\b(implement\w*|execut\w*|develop\w*|tdd|build\w*)\b/i, always: true,
    prompt: 'Implement the plan.' },
  { title: 'Test', re: /\b(test\w*|verif\w*|qa)\b/i, always: false,
    prompt: 'Run the tests and fix any failures.' },
  { title: 'Review', re: /\b(review\w*|audit\w*|lint\w*)\b/i, always: true,
    prompt: 'Review the changes for bugs and fix what you find.' }
];

function samePath(a, b) {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** Skills of installed plugins that apply to this project: user scope, or installed for this path. */
function pluginSkills(projectPath) {
  const installed = readJson(path.join(PLUGINS_DIR, 'installed_plugins.json'), {}).plugins || {};
  const enabled = readJson(SETTINGS_FILE, {}).enabledPlugins || {};
  const out = [];
  for (const [key, installs] of Object.entries(installed)) {
    if (enabled[key] === false || !Array.isArray(installs)) continue;
    const plugin = key.split('@')[0];
    const install = installs.find(i => i && i.installPath && (i.scope === 'user' || (i.projectPath && samePath(i.projectPath, projectPath))));
    if (!install) continue;
    for (const s of listSkills(path.join(install.installPath, 'skills'))) {
      out.push({ kind: 'skill', name: plugin + ':' + s.name, description: s.description, source: 'plugin' });
    }
  }
  return out;
}

function agentsIn(dir, source) {
  try {
    return readFrontmatterDir(dir).map(a => ({
      kind: 'agent', name: a.name || a.filename.replace(/\.md$/, ''), description: String(a.description || ''), source
    }));
  } catch (_) { return []; }
}

/** Skills and agents a session in this project can use. */
function availableFor(slug) {
  const projectPath = decodeSlug(slug);
  const claudeDir = path.join(projectPath, '.claude');
  const skills = (dir, source) => listSkills(dir).map(s => ({ kind: 'skill', name: s.name, description: s.description, source }));
  return [
    ...skills(path.join(claudeDir, 'skills'), 'project'),
    ...skills(SKILLS_DIR, 'global'),
    ...pluginSkills(projectPath),
    ...agentsIn(path.join(claudeDir, 'agents'), 'project'),
    ...agentsIn(AGENTS_DIR, 'global')
  ];
}

/** What a saved workflow is compared against to notice added or removed skills and agents. */
function snapshotOf(available) {
  return available.map(a => a.kind + ':' + a.name).sort();
}

/** 0 unless the skill's own name (not its plugin prefix) matches; a matching description breaks ties. */
function score(phase, item) {
  const words = item.name.split(':').pop().replace(/[-_]+/g, ' ');
  if (!phase.re.test(words)) return 0;
  return 2 + (phase.re.test(item.description) ? 1 : 0);
}

/** Free recommendation from skill names and descriptions — no AI. */
function recommend(available) {
  const used = new Set();
  const stages = [];
  for (const phase of PHASES) {
    const best = available
      .filter(a => a.kind === 'skill' && !used.has(a.name))
      .map(a => ({ a, s: score(phase, a) }))
      .filter(x => x.s > 0)
      .sort((x, y) => y.s - x.s || SOURCE_RANK[x.a.source] - SOURCE_RANK[y.a.source] || x.a.name.localeCompare(y.a.name))[0];
    if (best) {
      used.add(best.a.name);
      stages.push({ title: phase.title, type: 'skill', ref: best.a.name, prompt: '' });
    } else if (phase.always) {
      stages.push({ title: phase.title, type: 'prompt', ref: '', prompt: phase.prompt });
    }
  }
  return stages;
}

/** Stages that use a skill or agent the project no longer has. */
function missingRefs(stages, available) {
  const names = new Set(available.map(a => a.kind + ':' + a.name));
  return (stages || []).filter(s => s.type !== 'prompt' && !names.has(s.type + ':' + s.ref)).map(s => s.id);
}

function newStageId() {
  return 's-' + crypto.randomBytes(4).toString('hex');
}

/**
 * Validate submitted stages; existing ids are kept so tickets stay in their column. The first stage is
 * the one Ready leads to. Each stage has a default arrow (next: a stage id or 'done'); a stage without
 * one gets the following stage, or Done after the last, as before arrows existed. The result is
 * ordered along the default arrows from the first stage, then the stages only conditions lead to.
 */
function validateStages(input, available) {
  if (!Array.isArray(input)) return { error: 'stages must be a list' };
  if (input.length > MAX_STAGES) return { error: `at most ${MAX_STAGES} stages` };
  const names = new Set(available.map(a => a.kind + ':' + a.name));
  const ids = new Set();
  const stages = [];
  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    const title = String((raw && raw.title) || '').trim();
    const type = String((raw && raw.type) || '');
    const ref = String((raw && raw.ref) || '').trim();
    const prompt = String((raw && raw.prompt) || '').trim();
    if (!title) return { error: `stage ${n}: title is required` };
    if (title.length > MAX_STAGE_TITLE) return { error: `stage ${n}: title is too long` };
    if (!STAGE_TYPES.includes(type)) return { error: `stage ${n}: unknown type` };
    if (type === 'prompt' && !prompt) return { error: `stage ${n}: prompt is required` };
    if (type !== 'prompt' && !names.has(type + ':' + ref)) return { error: `stage ${n}: ${type} "${ref}" is not available in this project` };
    if (prompt.length > MAX_STAGE_PROMPT) return { error: `stage ${n}: prompt is too long` };
    let id = raw && typeof raw.id === 'string' && STAGE_ID_RE.test(raw.id) && !ids.has(raw.id) ? raw.id : newStageId();
    while (ids.has(id)) id = newStageId();
    ids.add(id);
    const stage = { id, title, type, ref: type === 'prompt' ? '' : ref, prompt, next: raw && raw.next, branches: (raw && raw.branches) || [] };
    const pos = raw && raw.pos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      stage.pos = { x: Math.min(Math.max(Math.round(pos.x), 0), MAX_POS), y: Math.min(Math.max(Math.round(pos.y), 0), MAX_POS) };
    }
    stages.push(stage);
  }
  // Second pass: an arrow may lead to any stage of the workflow, including earlier ones and itself.
  for (const [i, stage] of stages.entries()) {
    if (stage.next === undefined || stage.next === null) stage.next = i === stages.length - 1 ? 'done' : stages[i + 1].id;
    if (stage.next !== 'done' && !ids.has(stage.next)) return { error: `stage "${stage.title}": draw its default arrow` };
    const { branches, error } = validateBranches(stage.branches, ids);
    if (error) return { error: `stage ${i + 1}: ${error}` };
    stage.branches = branches;
  }
  return orderStages(stages);
}

/** Stages in board order; every stage has to be reachable from Ready, and Done from the first stage. */
function orderStages(stages) {
  if (!stages.length) return { stages };
  const byId = new Map(stages.map(s => [s.id, s]));
  const order = [];
  const seen = new Set();
  for (let s = stages[0]; s && !seen.has(s.id); s = byId.get(s.next)) { seen.add(s.id); order.push(s); }
  let reachesDone = false;
  for (let i = 0; i < order.length; i++) {
    for (const to of [order[i].next, ...order[i].branches.map(b => b.to)]) {
      if (to === 'done') reachesDone = true;
      else if (!seen.has(to)) { seen.add(to); order.push(byId.get(to)); }
    }
  }
  const stranded = stages.find(s => !seen.has(s.id));
  if (stranded) return { error: `stage "${stranded.title}" cannot be reached from Ready` };
  if (!reachesDone) return { error: 'no arrow leads to Done' };
  return { stages: order };
}

/** Conditions of one stage: [{ when, to }], to being a stage id or 'done'. */
function validateBranches(input, ids) {
  if (!Array.isArray(input)) return { error: 'conditions must be a list' };
  if (input.length > MAX_BRANCHES) return { error: `at most ${MAX_BRANCHES} conditions` };
  const branches = [];
  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    const when = String((raw && raw.when) || '').trim();
    const to = String((raw && raw.to) || '');
    if (!when) return { error: `condition ${n}: text is required` };
    if (when.length > MAX_BRANCH_WHEN) return { error: `condition ${n}: text is too long` };
    if (to !== 'done' && !ids.has(to)) return { error: `condition ${n}: unknown target stage` };
    branches.push({ when, to });
  }
  return { branches };
}

module.exports = { PHASES, STAGE_TYPES, MAX_STAGES, MAX_BRANCHES, availableFor, snapshotOf, recommend, missingRefs, validateStages };

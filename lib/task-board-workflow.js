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

/** Validate submitted stages; existing ids are kept so tickets stay in their column. */
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
    stages.push({ id, title, type, ref: type === 'prompt' ? '' : ref, prompt });
  }
  return { stages };
}

module.exports = { PHASES, STAGE_TYPES, MAX_STAGES, availableFor, snapshotOf, recommend, missingRefs, validateStages };

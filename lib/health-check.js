const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');
const { CLAUDE_DIR, CLAUDE_JSON, PROJECTS_DIR, SETTINGS_FILE, MCP_FILE, KEYBINDINGS_FILE, SKILLS_DIR, GLOBAL_CLAUDE_MD } = require('./paths');
const { listProjectDirs } = require('./project-list');

// Claude Code itself warns once a CLAUDE.md passes this size; every character is sent each turn.
const CLAUDE_MD_MAX_CHARS = 40000;
// Skill descriptions decide when a skill triggers: too short is vague, over 1024 is cut off.
const SKILL_DESC_MIN = 40;
const SKILL_DESC_MAX = 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Claude Code loads only the first 200 lines of MEMORY.md into each session.
const MEMORY_INDEX_MAX_LINES = 200;

function finding(severity, area, title, detail, extra) {
  return { severity, area, title, detail, ...extra };
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

/** Projects whose folder still exists, as { slug, path, name }. */
function liveProjects() {
  return listProjectDirs()
    .filter(p => p.path && exists(p.path))
    .map(p => ({ ...p, name: path.basename(p.path) }));
}

// ── JSON files ───────────────────────────────────────────────────────────────

function checkJsonFile(file, scope, extra) {
  if (!exists(file)) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) {
    return [finding('error', 'json', 'Cannot read ' + path.basename(file), e.message, { scope, location: file, ...extra })];
  }
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    return [finding('error', 'json', 'Invalid JSON in ' + path.basename(file),
      'Claude Code cannot read this file, so its settings are ignored. Parser says: ' + e.message,
      { scope, location: file, ...extra })];
  }
}

function checkJson(projects) {
  const out = [];
  for (const f of [SETTINGS_FILE, path.join(CLAUDE_DIR, 'settings.local.json'), CLAUDE_JSON, MCP_FILE, KEYBINDINGS_FILE]) {
    out.push(...checkJsonFile(f, 'Global'));
  }
  for (const p of projects) {
    for (const rel of [path.join('.claude', 'settings.json'), path.join('.claude', 'settings.local.json'), '.mcp.json']) {
      out.push(...checkJsonFile(path.join(p.path, rel), p.name, { slug: p.slug }));
    }
  }
  return out;
}

// ── MCP servers ──────────────────────────────────────────────────────────────

/** Whether a command resolves to a file: as a path, or by name on PATH (with PATHEXT on Windows). */
function commandExists(cmd, env) {
  if (!cmd) return false;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return exists(cmd);
  const exts = process.platform === 'win32'
    ? [''].concat((env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (exists(path.join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

/**
 * Static check of one server definition — servers are never started (that would run arbitrary
 * commands). Only the server name and command name are reported, never args or env values.
 */
function checkServer(name, def, scope, location, extra, env) {
  if (!def || typeof def !== 'object') {
    return [finding('error', 'mcp', `MCP server "${name}" has no definition`, 'The entry is not an object.', { scope, location, ...extra })];
  }
  const type = def.type || (def.url ? 'http' : 'stdio');
  if (type === 'stdio') {
    if (!def.command) {
      return [finding('error', 'mcp', `MCP server "${name}" has no command`, 'A stdio server needs a "command" to start.', { scope, location, ...extra })];
    }
    const cmd = String(def.command);
    if (/\$\{[^}]+\}/.test(cmd)) return [];
    if (!commandExists(cmd, env)) {
      return [finding('error', 'mcp', `MCP server "${name}" will not start`,
        `Its command "${path.basename(cmd)}" was not found on this machine (not a file and not on PATH). Install it or fix the command.`,
        { scope, location, ...extra })];
    }
    return [];
  }
  if (type === 'http' || type === 'sse') {
    const url = String(def.url || '');
    if (!url) return [finding('error', 'mcp', `MCP server "${name}" has no URL`, `A ${type} server needs a "url".`, { scope, location, ...extra })];
    if (/\$\{[^}]+\}/.test(url)) return [];
    try { new URL(url); } catch (_) {
      return [finding('error', 'mcp', `MCP server "${name}" has an invalid URL`, 'The "url" is not a valid address.', { scope, location, ...extra })];
    }
    return [];
  }
  return [finding('warn', 'mcp', `MCP server "${name}" has an unknown type`, `Type "${type}" is not stdio, http or sse.`, { scope, location, ...extra })];
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

function checkMcp(projects, env) {
  const out = [];
  const claudeJson = readJsonQuiet(CLAUDE_JSON) || {};
  for (const [name, def] of Object.entries(claudeJson.mcpServers || {})) {
    out.push(...checkServer(name, def, 'Global', CLAUDE_JSON, {}, env));
  }
  const globalMcp = readJsonQuiet(MCP_FILE) || {};
  for (const [name, def] of Object.entries(globalMcp.mcpServers || {})) {
    out.push(...checkServer(name, def, 'Global', MCP_FILE, {}, env));
  }
  const localByPath = {};
  for (const [key, data] of Object.entries(claudeJson.projects || {})) {
    localByPath[key.replace(/\\/g, '/').toLowerCase()] = data;
  }
  for (const p of projects) {
    const file = path.join(p.path, '.mcp.json');
    const data = readJsonQuiet(file) || {};
    for (const [name, def] of Object.entries(data.mcpServers || {})) {
      out.push(...checkServer(name, def, p.name, file, { slug: p.slug }, env));
    }
    const local = localByPath[p.path.replace(/\\/g, '/').toLowerCase()];
    for (const [name, def] of Object.entries((local && local.mcpServers) || {})) {
      out.push(...checkServer(name, def, p.name, CLAUDE_JSON, { slug: p.slug }, env));
    }
  }
  return out;
}

// ── Skills ───────────────────────────────────────────────────────────────────

/**
 * Hidden folders (e.g. Claude Code's .trash) are never skills; `ignore` names folders Claude Code
 * manages itself, like the global "synced" folder of skills synced from claude.ai.
 */
function checkSkillsDir(dir, scope, extra, ignore = []) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !ignore.includes(d.name))
      .map(d => d.name);
  } catch (_) { return []; }
  const out = [];
  for (const folder of names) {
    const file = path.join(dir, folder, 'SKILL.md');
    const loc = { scope, location: file, ...extra };
    if (!exists(file)) {
      out.push(finding('warn', 'skills', `Skill folder "${folder}" has no SKILL.md`, 'Claude Code ignores a skill folder without SKILL.md.', { ...loc, location: path.join(dir, folder) }));
      continue;
    }
    let fm;
    try { fm = matter(fs.readFileSync(file, 'utf-8')).data; } catch (e) {
      out.push(finding('error', 'skills', `Skill "${folder}" has broken frontmatter`, 'The YAML at the top of SKILL.md cannot be parsed: ' + e.message.split('\n')[0], loc));
      continue;
    }
    const desc = String(fm.description || '').trim();
    if (!desc) {
      out.push(finding('warn', 'skills', `Skill "${folder}" has no description`, 'Claude decides when to use a skill from its description; without one it will not trigger on its own.', loc));
    } else if (desc.length < SKILL_DESC_MIN) {
      out.push(finding('info', 'skills', `Skill "${folder}" has a very short description`, `${desc.length} characters. Say what it does and when to use it, so Claude picks it at the right time.`, loc));
    } else if (desc.length > SKILL_DESC_MAX) {
      out.push(finding('warn', 'skills', `Skill "${folder}" description is too long`, `${desc.length} characters; descriptions over ${SKILL_DESC_MAX} are cut off.`, loc));
    }
    if (fm.name && !SKILL_NAME_RE.test(String(fm.name))) {
      out.push(finding('info', 'skills', `Skill "${folder}" has an unusual name`, `"${String(fm.name).slice(0, 64)}" — skill names should be lowercase letters, numbers and hyphens.`, loc));
    }
  }
  return out;
}

function checkSkills(projects) {
  const out = checkSkillsDir(SKILLS_DIR, 'Global', {}, ['synced']);
  for (const p of projects) out.push(...checkSkillsDir(path.join(p.path, '.claude', 'skills'), p.name, { slug: p.slug }));
  return out;
}

// ── CLAUDE.md size ───────────────────────────────────────────────────────────

function checkClaudeMdFile(file, scope, extra) {
  let size;
  try { size = fs.readFileSync(file, 'utf-8').length; } catch (_) { return []; }
  if (size <= CLAUDE_MD_MAX_CHARS) return [];
  return [finding('warn', 'claude-md', `${path.basename(file)} is large`,
    `${Math.round(size / 1000)}k characters (about ${Math.round(size / 4000)}k tokens) are sent with every request. Over ${CLAUDE_MD_MAX_CHARS / 1000}k Claude Code warns about performance; move rarely needed parts into skills or separate files.`,
    { scope, location: file, ...extra })];
}

function checkClaudeMd(projects) {
  const out = checkClaudeMdFile(GLOBAL_CLAUDE_MD, 'Global', {});
  for (const p of projects) {
    for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      out.push(...checkClaudeMdFile(path.join(p.path, rel), p.name, { slug: p.slug }));
    }
  }
  return out;
}

// ── Memories ─────────────────────────────────────────────────────────────────

/** File names MEMORY.md links to, from "[title](file.md)" entries. */
function indexLinks(indexText) {
  const out = new Set();
  for (const m of indexText.matchAll(/\]\(([^)\s]+\.md)\)/g)) out.add(path.basename(decodeURIComponent(m[1])));
  return out;
}

function checkMemoryDir(dir, scope, extra) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch (_) { return []; }
  const out = [];
  const memories = files.filter(f => f !== 'MEMORY.md');
  const indexFile = path.join(dir, 'MEMORY.md');
  const hasIndex = files.includes('MEMORY.md');

  if (hasIndex) {
    const indexText = fs.readFileSync(indexFile, 'utf-8');
    const lines = indexText.split('\n').length;
    if (lines > MEMORY_INDEX_MAX_LINES) {
      out.push(finding('warn', 'memory', 'MEMORY.md is too long', `${lines} lines; only the first ${MEMORY_INDEX_MAX_LINES} are loaded into each session, so later entries are never seen.`, { scope, location: indexFile, ...extra }));
    }
    const links = indexLinks(indexText);
    for (const link of links) {
      if (!files.includes(link)) {
        out.push(finding('warn', 'memory', `MEMORY.md points to a missing memory`, `"${link}" is listed in the index but the file no longer exists — a stale entry.`, { scope, location: indexFile, ...extra }));
      }
    }
    for (const f of memories) {
      if (!links.has(f)) {
        out.push(finding('info', 'memory', `Memory "${f}" is not in MEMORY.md`, 'Claude finds memories through the index; without an entry this one is unlikely to be recalled.', { scope, location: path.join(dir, f), ...extra }));
      }
    }
  }

  const byBody = {};
  const byName = {};
  for (const f of memories) {
    let parsed;
    try { parsed = matter(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch (_) { continue; }
    const body = parsed.content.trim().replace(/\s+/g, ' ').toLowerCase();
    if (body) {
      const h = crypto.createHash('sha1').update(body).digest('hex');
      (byBody[h] = byBody[h] || []).push(f);
    }
    const name = String(parsed.data.name || '').trim().toLowerCase();
    if (name) (byName[name] = byName[name] || []).push(f);
  }
  const reported = new Set();
  for (const group of Object.values(byBody)) {
    if (group.length < 2) continue;
    group.forEach(f => reported.add(f));
    out.push(finding('warn', 'memory', 'Duplicate memories', `${group.join(', ')} have the same content; keep one.`, { scope, location: path.join(dir, group[0]), ...extra }));
  }
  for (const [name, group] of Object.entries(byName)) {
    if (group.length < 2 || group.every(f => reported.has(f))) continue;
    out.push(finding('warn', 'memory', 'Memories with the same name', `${group.join(', ')} are all named "${name}"; merge or rename them.`, { scope, location: path.join(dir, group[0]), ...extra }));
  }
  return out;
}

function checkMemories(projects) {
  const out = [];
  const nameBySlug = Object.fromEntries(projects.map(p => [p.slug, p.name]));
  for (const p of listProjectDirs()) {
    out.push(...checkMemoryDir(path.join(PROJECTS_DIR, p.slug, 'memory'), nameBySlug[p.slug] || path.basename(p.path || p.slug), { slug: p.slug }));
  }
  return out;
}

// ── All ──────────────────────────────────────────────────────────────────────

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

/** Every check, errors first. Read-only: nothing is started, written or fixed. */
function runHealthCheck(env = process.env) {
  const projects = liveProjects();
  const findings = [
    ...checkJson(projects),
    ...checkMcp(projects, env),
    ...checkSkills(projects),
    ...checkClaudeMd(projects),
    ...checkMemories(projects)
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { checkedAt: new Date().toISOString(), projectCount: projects.length, counts, findings };
}

module.exports = { runHealthCheck, commandExists, checkServer, CLAUDE_MD_MAX_CHARS, SKILL_DESC_MIN, MEMORY_INDEX_MAX_LINES };

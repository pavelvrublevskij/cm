const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR, DATA_DIR } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');

const ARTIFACT_DB = path.join(DATA_DIR, 'artifact-index.json');

// Ticket codes embedded in branch names, e.g. "TAMS-10187-aeoi-active-process-review" -> "TAMS-10187".
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

function extractTicket(branch) {
  if (!branch) return null;
  const m = branch.match(TICKET_RE);
  return m ? m[1] : null;
}

/**
 * Every artifact published or updated from a session transcript, deduplicated by artifact_id
 * (keeping the most recent publish/update as the record, with the earliest timestamp kept as
 * firstPublishedAt). Only tool_result entries carrying a url + artifact_id count as a publish —
 * other Artifact-tool actions (list, read, comments, ...) produce neither and are skipped.
 */
function parseSessionArtifacts(filePath) {
  const pending = new Map(); // tool_use_id -> { input, timestamp, gitBranch }
  const byArtifactId = new Map();

  let lines;
  try { lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean); }
  catch (_) { return []; }

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.name === 'Artifact') {
          pending.set(block.id, { input: block.input || {}, timestamp: entry.timestamp, gitBranch: entry.gitBranch });
        }
      }
      continue;
    }

    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type !== 'tool_result') continue;
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);

        const result = entry.toolUseResult;
        if (!result || !result.url || !result.artifact_id) continue;

        const artifactId = result.artifact_id;
        const prev = byArtifactId.get(artifactId);
        byArtifactId.set(artifactId, {
          artifactId,
          url: result.url,
          title: result.title || call.input.title || '',
          description: call.input.description || '',
          favicon: call.input.favicon || '',
          ticket: extractTicket(call.gitBranch),
          gitBranch: call.gitBranch || null,
          firstPublishedAt: prev ? prev.firstPublishedAt : (call.timestamp || entry.timestamp),
          updatedAt: entry.timestamp || call.timestamp,
          updated: !!result.updated
        });
      }
    }
  }

  return Array.from(byArtifactId.values());
}

function buildIndex() {
  const index = readJson(ARTIFACT_DB, { version: 1, sessions: {} });
  if (!index.sessions) index.sessions = {};

  const forceReindex = index.version !== 1;

  const seen = new Set();
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch (_) { return index; }

  for (const d of dirs) {
    const slug = d.name;
    const projectDir = path.join(PROJECTS_DIR, slug);
    let files;
    try { files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl')); }
    catch (_) { continue; }

    for (const f of files) {
      const sessionId = f.replace('.jsonl', '');
      const key = slug + '/' + sessionId;
      seen.add(key);

      const filePath = path.join(projectDir, f);
      let mtime;
      try { mtime = fs.statSync(filePath).mtimeMs; }
      catch (_) { continue; }

      if (!forceReindex && index.sessions[key] && index.sessions[key].mtime === mtime) continue;

      index.sessions[key] = { mtime, slug, sessionId, artifacts: parseSessionArtifacts(filePath) };
    }
  }

  for (const key of Object.keys(index.sessions)) {
    if (!seen.has(key)) delete index.sessions[key];
  }

  index.version = 1;
  writeDataJson(ARTIFACT_DB, index);
  return index;
}

/** All published artifacts across every project, newest first. */
function getAllArtifacts() {
  const index = buildIndex();
  const out = [];
  for (const entry of Object.values(index.sessions)) {
    for (const a of entry.artifacts) out.push({ ...a, slug: entry.slug, sessionId: entry.sessionId });
  }
  out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return out;
}

/** Published artifacts for one project, newest first. */
function getProjectArtifacts(slug) {
  return getAllArtifacts().filter(a => a.slug === slug);
}

/** Published artifacts for one session, newest first. */
function getSessionArtifacts(slug, sessionId) {
  const index = buildIndex();
  const entry = index.sessions[slug + '/' + sessionId];
  if (!entry) return [];
  return [...entry.artifacts].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/** Cheap counts for deciding sidebar/tab visibility without shipping full artifact payloads. */
function getArtifactSummary() {
  const index = buildIndex();
  const bySlug = {};
  let total = 0;
  for (const entry of Object.values(index.sessions)) {
    if (!entry.artifacts.length) continue;
    bySlug[entry.slug] = (bySlug[entry.slug] || 0) + entry.artifacts.length;
    total += entry.artifacts.length;
  }
  return { total, bySlug };
}

module.exports = { buildIndex, getAllArtifacts, getProjectArtifacts, getSessionArtifacts, getArtifactSummary, extractTicket, parseSessionArtifacts };

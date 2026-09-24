const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { wrapRoute, safeSlug } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { PROJECTS_DIR } = require('../lib/paths');
const { computeGroups } = require('../lib/project-grouping');
const { listProjectDirs } = require('../lib/project-list');
const { getProjectArtifacts } = require('../lib/artifact-index');

const router = express.Router();

const UNGROUPED = {
  groupId: null,
  groupLabel: null,
  groupPrimary: false,
  groupParentSlug: null,
  groupRelPath: null
};

/** Count directory entries matching `predicate`, or 0 when the directory is missing/unreadable. */
function countEntries(dir, predicate) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
  } catch (_) {
    return 0;     // missing directory, or no permission to read it
  }
}

const isMarkdown = d => d.isFile() && d.name.endsWith('.md');
const isJsonl = d => d.isFile() && d.name.endsWith('.jsonl');
const isDirectory = d => d.isDirectory();

function openFolder(folderPath) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    execFile('open', [folderPath]);
  } else {
    execFile('xdg-open', [folderPath]);
  }
}

router.get('/', wrapRoute((req, res) => {
  const projects = listProjectDirs().map(({ slug, path: projectPath }) => {
    const stateDir = path.join(PROJECTS_DIR, slug);
    const memoryDir = path.join(stateDir, 'memory');

    return {
      slug,
      path: projectPath,
      hasMemory: fs.existsSync(memoryDir),
      memoryCount: countEntries(memoryDir, isMarkdown),
      sessionCount: countEntries(stateDir, isJsonl),
      skillsCount: countEntries(path.join(projectPath, '.claude', 'skills'), isDirectory),
      outputStylesCount: countEntries(path.join(projectPath, '.claude', 'output-styles'), isMarkdown),
      hasClaudeMd: fs.existsSync(path.join(projectPath, 'CLAUDE.md')),
      hasAiMemory: fs.existsSync(path.join(projectPath, '.ai_project_memory'))
    };
  });

  const groups = computeGroups(projects);
  for (const p of projects) Object.assign(p, groups.get(p.slug) || UNGROUPED);

  res.json(projects);
}));

router.get('/:slug/artifacts', wrapRoute((req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const artifacts = getProjectArtifacts(req.params.slug);

  const groups = new Map();
  for (const a of artifacts) {
    const key = a.ticket || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const result = Array.from(groups.entries())
    .map(([ticket, items]) => ({ ticket: ticket || null, artifacts: items }))
    .sort((a, b) => {
      if (!a.ticket) return 1;
      if (!b.ticket) return -1;
      return new Date(b.artifacts[0].updatedAt) - new Date(a.artifacts[0].updatedAt);
    });

  res.json({ total: artifacts.length, groups: result });
}));

router.post('/:slug/open-folder', wrapRoute((req, res) => {
  if (!safeSlug(req.params.slug)) return res.status(400).json({ error: 'Invalid slug' });
  const projectPath = decodeSlug(req.params.slug);
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return res.status(404).json({ error: 'Folder does not exist on disk' });
  }
  openFolder(projectPath);
  res.json({ ok: true });
}));

module.exports = router;

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CLAUDE_DIR, PROJECTS_DIR } = require('../lib/paths');
const { wrapRoute } = require('../lib/file-helpers');
const { openPath, revealInFileManager } = require('../lib/os-open');
const planCache = require('../lib/plan-cache');
const { resolveProjectPath } = require('../lib/project-files');
const { decodeSlug } = require('../lib/slug');
const { computeDiff } = require('../lib/diff');

const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

const router = express.Router();
const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');

/**
 * Claude Code names file-history backups `<sha256(absolute path) truncated to 16 hex>@v<n>`.
 * Recomputing it recovers the path -> backup mapping for sessions whose transcript carries no
 * file-history-snapshot records (newer Claude Code versions omit them).
 */
function backupHash(absPath) {
  return crypto.createHash('sha256').update(absPath, 'utf8').digest('hex').slice(0, 16);
}

/** Resolve+validate a projSlug/filePath pair against the project dir. Returns { error, status } or { target }. */
function resolveProjectFile(projSlug, filePath) {
  if (!filePath) return { status: 400, error: 'Invalid file path' };

  const resolved = resolveProjectPath(projSlug, filePath);
  if (resolved.error) return resolved;
  if (!fs.existsSync(resolved.target) || !fs.statSync(resolved.target).isFile()) {
    return { status: 404, error: 'File not found' };
  }
  return { target: resolved.target };
}

router.get('/:sessionId/context', wrapRoute(async (req, res) => {
  const { sessionId } = req.params;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const histDir = path.join(FILE_HISTORY_DIR, sessionId);
  let files = [];

  let projSlug = null;
  const planPathsFromSession = new Set();

  // Always find the session JSONL regardless of whether file-history exists
  let sessionContent = null;
  for (const proj of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const candidate = path.join(PROJECTS_DIR, proj.name, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) {
      try { sessionContent = fs.readFileSync(candidate, 'utf-8'); projSlug = proj.name; } catch (_) {}
      break;
    }
  }

  if (sessionContent) {
    const fileMap = {};

    for (const line of sessionContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (planPathsFromSession.size === 0 && planCache.get(sessionId) !== false && obj.type === 'assistant') {
          const content = obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type !== 'tool_use' || !block.input) continue;
              if (block.name === 'ExitPlanMode' && block.input.planFilePath) {
                planPathsFromSession.add(block.input.planFilePath);
              } else if (block.name === 'Write' && block.input.file_path) {
                const planRel = path.relative(PLANS_DIR, path.resolve(block.input.file_path));
                if (!planRel.startsWith('..') && !path.isAbsolute(planRel)) {
                  planPathsFromSession.add(block.input.file_path);
                }
              }
            }
          }
        }
        if (fs.existsSync(histDir)) {
          if (obj.type !== 'file-history-snapshot' || !obj.isSnapshotUpdate) continue;
          const backups = obj.snapshot && obj.snapshot.trackedFileBackups;
          if (!backups) continue;
          for (const [filePath, info] of Object.entries(backups)) {
            if (!fileMap[filePath]) fileMap[filePath] = { hash: null, maxVersion: 0, isNew: false };
            if (!info.backupFileName) {
              fileMap[filePath].isNew = true;
              continue;
            }
            if (!fileMap[filePath].hash) fileMap[filePath].hash = info.backupFileName.split('@')[0];
            fileMap[filePath].maxVersion = Math.max(fileMap[filePath].maxVersion, info.version);
          }
        }
      } catch (_) {}
    }

    const projectDir = projSlug ? decodeSlug(projSlug) : null;

    // Fallback: collect files touched via Write/Edit/MultiEdit tool calls.
    // Runs unconditionally so sessions without a file-history dir still show their files.
    if (projectDir) {
      const resolvedProjectDir = path.resolve(projectDir);
      const existingKeys = new Set(Object.keys(fileMap).map(k => k.replace(/\\/g, '/')));
      for (const line of sessionContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== 'assistant') continue;
          const content = obj.message && obj.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type !== 'tool_use' || !block.input) continue;
            let filePath = null;
            let isNew = false;
            if (block.name === 'Write') { filePath = block.input.file_path; isNew = true; }
            else if (block.name === 'Edit' || block.name === 'MultiEdit') { filePath = block.input.file_path; }
            else if (block.name === 'NotebookEdit') { filePath = block.input.notebook_path; }
            if (!filePath) continue;
            const rel = path.relative(resolvedProjectDir, path.resolve(filePath));
            if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
            const relNorm = rel.replace(/\\/g, '/');
            if (!existingKeys.has(relNorm)) {
              existingKeys.add(relNorm);
              fileMap[relNorm] = { hash: null, maxVersion: 0, isNew };
            }
          }
        } catch (_) {}
      }
    }

    const histFiles = fs.existsSync(histDir) ? fs.readdirSync(histDir) : [];

    // Files found via tool calls carry no backup name; recover it from the path so their diffs work.
    if (projectDir && histFiles.length) {
      for (const [filePath, info] of Object.entries(fileMap)) {
        if (info.hash || info.isNew) continue;
        const candidate = backupHash(path.resolve(projectDir, filePath));
        if (histFiles.some(f => f.startsWith(candidate + '@v'))) info.hash = candidate;
      }
    }

    files = Object.entries(fileMap).map(([filePath, info]) => {
      const versions = info.hash ? histFiles
        .filter(f => f.startsWith(info.hash + '@v'))
        .map(f => parseInt(f.split('@v')[1], 10))
        .filter(v => !isNaN(v))
        .sort((a, b) => a - b) : [];
      let isDeleted = false;
      let mtime = null;
      if (projectDir) {
        const currentFile = path.resolve(projectDir, filePath);
        try {
          mtime = fs.statSync(currentFile).mtimeMs;
        } catch (_) {
          isDeleted = true;
        }
      }
      return { path: filePath, hash: info.hash, versions, isNew: info.isNew, isDeleted, mtime };
    });
    // Every entry came from a snapshot backup or a Write/Edit/MultiEdit/NotebookEdit call, so all of
    // them were touched by this session. Files without a recorded snapshot have no diff, but their
    // current source is still viewable in the Files tab — they used to be filtered out here.
  }

  // Plans linked to this session via ExitPlanMode planFilePath
  const plans = [];
  for (const planPath of planPathsFromSession) {
    const name = path.basename(planPath, '.md');
    try {
      const stat = fs.statSync(path.join(PLANS_DIR, name + '.md'));
      plans.push({ name, mtime: stat.mtime });
    } catch (_) {}
  }
  if (planCache.get(sessionId) === undefined) planCache.set(sessionId, plans.length > 0);

  res.json({ files, plans, projSlug });
}));

router.post('/open-file', wrapRoute((req, res) => {
  const { projSlug, filePath } = req.body || {};
  const resolved = resolveProjectFile(projSlug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  openPath(resolved.target);
  res.json({ ok: true });
}));

router.post('/reveal-file', wrapRoute((req, res) => {
  const { projSlug, filePath } = req.body || {};
  const resolved = resolveProjectFile(projSlug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  revealInFileManager(resolved.target);
  res.json({ ok: true });
}));

router.get('/:sessionId/:hash/diff', wrapRoute((req, res) => {
  const { sessionId, hash } = req.params;
  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);

  for (const p of [sessionId, hash]) {
    if (p.includes('..') || p.includes('/') || p.includes('\\')) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }
  }

  const histDir = path.join(FILE_HISTORY_DIR, sessionId);
  const fromFile = path.join(histDir, `${hash}@v${from}`);
  const toFile = path.join(histDir, `${hash}@v${to}`);

  if (!fs.existsSync(fromFile) || !fs.existsSync(toFile)) {
    return res.status(404).json({ error: 'Version not found' });
  }

  const oldText = fs.readFileSync(fromFile, 'utf-8');
  const newText = fs.readFileSync(toFile, 'utf-8');
  res.json(computeDiff(oldText, newText));
}));

router.get('/:sessionId/:hash/diff-current', wrapRoute((req, res) => {
  const { sessionId, hash } = req.params;
  const version = parseInt(req.query.version, 10);
  const { projSlug, filePath } = req.query;
  const isNew = req.query.isNew === 'true';

  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  if (!isNew && (hash.includes('..') || hash.includes('/') || hash.includes('\\'))) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const resolved = resolveProjectPath(projSlug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  const currentFile = resolved.target;
  const currentExists = fs.existsSync(currentFile);

  let oldText = '';
  if (!isNew) {
    const histDir = path.join(FILE_HISTORY_DIR, sessionId);
    const fromFile = path.join(histDir, `${hash}@v${version}`);
    if (!fs.existsSync(fromFile)) return res.status(404).json({ error: 'Version not found' });
    oldText = fs.readFileSync(fromFile, 'utf-8');
  }

  const newText = currentExists ? fs.readFileSync(currentFile, 'utf-8') : '';
  res.json(computeDiff(oldText, newText));
}));

module.exports = router;

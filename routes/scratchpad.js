const express = require('express');
const fs = require('fs');
const path = require('path');
const { wrapRoute } = require('../lib/file-helpers');
const { openPath, revealInFileManager } = require('../lib/os-open');
const { readFileForEditor } = require('../lib/project-files');
const { safeScratchpadDir, listFiles } = require('../lib/scratchpad');

const router = express.Router({ mergeParams: true });

const PREVIEW_MAX_BYTES = 200 * 1024;

/** Resolve a relative path against a scratchpad dir, guarding against traversal. Returns null if unsafe. */
function resolveScratchpadFile(dir, rel) {
  if (!rel) return null;
  const target = path.resolve(dir, rel);
  const relCheck = path.relative(path.resolve(dir), target);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  return target;
}

router.get('/:slug/sessions/:sessionId/scratchpad', wrapRoute((req, res) => {
  const dir = safeScratchpadDir(req.params.slug, req.params.sessionId);
  if (!dir) return res.status(400).json({ error: 'Invalid parameters' });
  if (!fs.existsSync(dir)) return res.json({ exists: false, files: [] });

  const files = listFiles(dir).sort((a, b) => b.mtime - a.mtime);
  res.json({ exists: true, files });
}));

router.get('/:slug/sessions/:sessionId/scratchpad/file', wrapRoute((req, res) => {
  const dir = safeScratchpadDir(req.params.slug, req.params.sessionId);
  if (!dir) return res.status(400).json({ error: 'Invalid parameters' });

  const target = resolveScratchpadFile(dir, req.query.path || '');
  if (!target) return res.status(400).json({ error: 'Invalid file path' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.json(readFileForEditor(target, PREVIEW_MAX_BYTES));
}));

router.post('/:slug/sessions/:sessionId/scratchpad/open-folder', wrapRoute((req, res) => {
  const dir = safeScratchpadDir(req.params.slug, req.params.sessionId);
  if (!dir) return res.status(400).json({ error: 'Invalid parameters' });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Folder does not exist on disk' });
  openPath(dir);
  res.json({ ok: true });
}));

router.post('/:slug/sessions/:sessionId/scratchpad/open-file', wrapRoute((req, res) => {
  const dir = safeScratchpadDir(req.params.slug, req.params.sessionId);
  if (!dir) return res.status(400).json({ error: 'Invalid parameters' });

  const target = resolveScratchpadFile(dir, req.body?.path || '');
  if (!target) return res.status(400).json({ error: 'Invalid file path' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  openPath(target);
  res.json({ ok: true });
}));

router.post('/:slug/sessions/:sessionId/scratchpad/reveal-file', wrapRoute((req, res) => {
  const dir = safeScratchpadDir(req.params.slug, req.params.sessionId);
  if (!dir) return res.status(400).json({ error: 'Invalid parameters' });

  const target = resolveScratchpadFile(dir, req.body?.path || '');
  if (!target) return res.status(400).json({ error: 'Invalid file path' });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  revealInFileManager(target);
  res.json({ ok: true });
}));

module.exports = router;

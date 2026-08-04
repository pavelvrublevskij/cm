const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { wrapRoute } = require('../lib/file-helpers');
const { safeScratchpadDir, listFiles } = require('../lib/scratchpad');

const router = express.Router({ mergeParams: true });

const PREVIEW_MAX_BYTES = 200 * 1024;

/** Open a file or folder with the OS default association (Explorer/Finder/xdg-open). */
function openPath(targetPath) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    execFile('open', [targetPath]);
  } else {
    execFile('xdg-open', [targetPath]);
  }
}

/** Reveal a file in the OS file explorer, selecting it (Linux falls back to opening the containing folder). */
function revealInFileManager(targetPath) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('explorer.exe', ['/select,' + targetPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'darwin') {
    execFile('open', ['-R', targetPath]);
  } else {
    execFile('xdg-open', [path.dirname(targetPath)]);
  }
}

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

  const stat = fs.statSync(target);
  if (stat.size > PREVIEW_MAX_BYTES) {
    return res.json({ binary: false, tooLarge: true, size: stat.size });
  }

  const buffer = fs.readFileSync(target);
  const isBinary = buffer.subarray(0, 8000).includes(0);
  if (isBinary) return res.json({ binary: true, size: stat.size });
  res.json({ binary: false, content: buffer.toString('utf-8'), size: stat.size });
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

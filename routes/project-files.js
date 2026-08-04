const express = require('express');
const fs = require('fs');
const { wrapRoute } = require('../lib/file-helpers');
const { resolveProjectPath, listDir, readFileForEditor } = require('../lib/project-files');

const router = express.Router();

router.get('/:slug/files/tree', wrapRoute((req, res) => {
  const resolved = resolveProjectPath(req.params.slug, req.query.path || '');
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  if (!fs.existsSync(resolved.target) || !fs.statSync(resolved.target).isDirectory()) {
    return res.status(404).json({ error: 'Directory not found' });
  }
  res.json({ path: resolved.rel, entries: listDir(resolved.target) });
}));

router.get('/:slug/files/content', wrapRoute((req, res) => {
  const resolved = resolveProjectPath(req.params.slug, req.query.path || '');
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  if (!resolved.rel) return res.status(400).json({ error: 'Invalid file path' });
  if (!fs.existsSync(resolved.target) || !fs.statSync(resolved.target).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.json({ path: resolved.rel, ...readFileForEditor(resolved.target) });
}));

router.put('/:slug/files/content', wrapRoute((req, res) => {
  const { path: filePath, content } = req.body || {};
  const resolved = resolveProjectPath(req.params.slug, filePath || '');
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  if (!resolved.rel) return res.status(400).json({ error: 'Invalid file path' });
  if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });
  if (!fs.existsSync(resolved.target) || !fs.statSync(resolved.target).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.writeFileSync(resolved.target, content, 'utf-8');
  const stat = fs.statSync(resolved.target);
  res.json({ ok: true, path: resolved.rel, size: stat.size, mtime: stat.mtimeMs });
}));

module.exports = router;

const express = require('express');
const fs = require('fs');
const path = require('path');
const { backup, safeJoin, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { readFrontmatterFile, readFrontmatterDir, writeFrontmatter } = require('../lib/frontmatter');
const { OUTPUT_STYLES_DIR } = require('../lib/paths');

const router = express.Router();

function mapStyles(dir) {
  return readFrontmatterDir(dir).map(s => ({
    filename: s.filename,
    name: s.name || s.filename.replace('.md', ''),
    description: s.description || '',
    frontmatter: { name: s.name, description: s.description, ...s },
    content: s.content
  }));
}

// Global routes

router.get('/global', (req, res) => {
  res.json(mapStyles(OUTPUT_STYLES_DIR));
});

router.put('/global/:filename', wrapRoute((req, res) => {
  fs.mkdirSync(OUTPUT_STYLES_DIR, { recursive: true });
  const filePath = safeJoin(OUTPUT_STYLES_DIR, req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  backup(filePath);
  writeFrontmatter(filePath, req.body.frontmatter || {}, req.body.content || '');
  res.json({ ok: true });
}));

router.delete('/global/:filename', wrapRoute((req, res) => {
  const filePath = safeJoin(OUTPUT_STYLES_DIR, req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  backup(filePath);
  fs.unlinkSync(filePath);
  res.json({ ok: true });
}));

// Project routes

router.get('/project/:slug', (req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  res.json(mapStyles(path.join(decodedPath, '.claude', 'output-styles')));
});

router.get('/project/:slug/:filename', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const filePath = safeJoin(path.join(decodedPath, '.claude', 'output-styles'), req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const { frontmatter, content, raw } = readFrontmatterFile(filePath);
  res.json({ filename: req.params.filename, frontmatter, content, raw });
}));

router.put('/project/:slug/:filename', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const dir = path.join(decodedPath, '.claude', 'output-styles');
  const filePath = safeJoin(dir, req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  fs.mkdirSync(dir, { recursive: true });
  backup(filePath);
  writeFrontmatter(filePath, req.body.frontmatter || {}, req.body.content || '');
  res.json({ ok: true });
}));

router.delete('/project/:slug/:filename', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const filePath = safeJoin(path.join(decodedPath, '.claude', 'output-styles'), req.params.filename);
  if (!filePath) return res.status(400).json({ error: 'Invalid filename' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  backup(filePath);
  fs.unlinkSync(filePath);
  res.json({ ok: true });
}));

module.exports = router;

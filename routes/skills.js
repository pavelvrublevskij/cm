const express = require('express');
const fs = require('fs');
const path = require('path');
const { backup, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { readFrontmatterFile, writeFrontmatter } = require('../lib/frontmatter');
const { SKILLS_DIR } = require('../lib/paths');
const { readUsage, recordUsage } = require('../lib/skill-usage');
const { listCommands, commandFile } = require('../lib/project-commands');

const router = express.Router();

function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      try {
        const skillFile = path.join(dir, d.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) return null;
        const { frontmatter, content } = readFrontmatterFile(skillFile);
        return {
          name: d.name,
          title: frontmatter.name || d.name,
          description: String(frontmatter.description || ''),
          frontmatter,
          content
        };
      } catch (_) { return null; }
    }).filter(Boolean);
}

router.get('/global', wrapRoute((req, res) => {
  res.json(listSkills(SKILLS_DIR));
}));

router.get('/global/:name', wrapRoute((req, res) => {
  const skillFile = path.join(SKILLS_DIR, req.params.name, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return res.status(404).json({ error: 'Not found' });
  const { frontmatter, content, raw } = readFrontmatterFile(skillFile);
  res.json({ name: req.params.name, frontmatter, content, raw });
}));

router.put('/global/:name', wrapRoute((req, res) => {
  const dir = path.join(SKILLS_DIR, req.params.name);
  const skillFile = path.join(dir, 'SKILL.md');
  fs.mkdirSync(dir, { recursive: true });
  backup(skillFile);
  writeFrontmatter(skillFile, req.body.frontmatter || {}, req.body.content || '');
  res.json({ ok: true });
}));

router.delete('/global/:name', wrapRoute((req, res) => {
  const dir = path.join(SKILLS_DIR, req.params.name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  const skillFile = path.join(dir, 'SKILL.md');
  backup(skillFile);
  fs.rmSync(dir, { recursive: true });
  res.json({ ok: true });
}));

router.get('/project/:slug', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  res.json(listSkills(path.join(decodedPath, '.claude', 'skills')));
}));

// Everything the terminal's Skills popover can type: the project's own skills and its custom slash
// commands, each carrying how often it has been picked here. Kept apart from /project/:slug so the
// project Skills tab keeps listing skills alone.
router.get('/palette/:slug', wrapRoute((req, res) => {
  const claudeDir = path.join(decodeSlug(req.params.slug), '.claude');
  const usage = readUsage(req.params.slug);
  const withUsage = kind => item => ({
    name: item.name,
    description: item.description,
    kind,
    usageCount: usage[item.name] || 0
  });
  res.json([
    ...listSkills(path.join(claudeDir, 'skills')).map(withUsage('skill')),
    ...listCommands(path.join(claudeDir, 'commands')).map(withUsage('command'))
  ]);
}));

// Count an entry pasted into a session terminal. Only names the project actually has are recorded,
// so a stale or forged one cannot grow the file.
router.post('/usage/:slug/:name', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const claudeDir = path.join(decodedPath, '.claude');
  const skillFile = path.join(claudeDir, 'skills', req.params.name, 'SKILL.md');
  if (!path.resolve(skillFile).startsWith(path.resolve(decodedPath))) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const known = fs.existsSync(skillFile) || !!commandFile(path.join(claudeDir, 'commands'), req.params.name);
  if (!known) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, count: recordUsage(req.params.slug, req.params.name) });
}));

router.get('/project/:slug/:name', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const skillFile = path.join(decodedPath, '.claude', 'skills', req.params.name, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return res.status(404).json({ error: 'Not found' });
  const { frontmatter, content, raw } = readFrontmatterFile(skillFile);
  res.json({ name: req.params.name, frontmatter, content, raw });
}));

router.put('/project/:slug/:name', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const dir = path.join(decodedPath, '.claude', 'skills', req.params.name);
  const skillFile = path.join(dir, 'SKILL.md');
  fs.mkdirSync(dir, { recursive: true });
  backup(skillFile);
  writeFrontmatter(skillFile, req.body.frontmatter || {}, req.body.content || '');
  res.json({ ok: true });
}));

router.delete('/project/:slug/:name', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const dir = path.join(decodedPath, '.claude', 'skills', req.params.name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  const skillFile = path.join(dir, 'SKILL.md');
  backup(skillFile);
  fs.rmSync(dir, { recursive: true });
  res.json({ ok: true });
}));

module.exports = router;

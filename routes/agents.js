const express = require('express');
const fs = require('fs');
const path = require('path');
const { backup, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { readFrontmatterFile, readFrontmatterDir, writeFrontmatter } = require('../lib/frontmatter');
const { AGENTS_DIR } = require('../lib/paths');

const router = express.Router();

/** An agent file name straight inside the agents folder: no path parts, must end in .md. */
function safeAgentFile(filename) {
  const name = String(filename || '');
  if (!name.endsWith('.md') || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

function listAgents(dir) {
  return readFrontmatterDir(dir).map(({ filename, content, ...frontmatter }) => ({
    filename,
    name: frontmatter.name || filename.replace(/\.md$/, ''),
    description: frontmatter.description || '',
    frontmatter,
    content
  }));
}

function readAgent(dir, filename, res) {
  const file = safeAgentFile(filename);
  if (!file) return res.status(400).json({ error: 'Invalid agent file name' });
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  const { frontmatter, content, raw } = readFrontmatterFile(filePath);
  res.json({ filename: file, frontmatter, content, raw });
}

function writeAgent(dir, filename, body, res) {
  const file = safeAgentFile(filename);
  if (!file) return res.status(400).json({ error: 'Invalid agent file name' });
  const fm = (body && body.frontmatter) || {};
  if (!String(fm.name || '').trim()) return res.status(400).json({ error: 'Agent name is required' });
  if (!String(fm.description || '').trim()) return res.status(400).json({ error: 'Agent description is required' });
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, file);
  backup(filePath);
  writeFrontmatter(filePath, fm, (body && body.content) || '');
  res.json({ ok: true });
}

function deleteAgent(dir, filename, res) {
  const file = safeAgentFile(filename);
  if (!file) return res.status(400).json({ error: 'Invalid agent file name' });
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  backup(filePath);
  fs.unlinkSync(filePath);
  res.json({ ok: true });
}

function projectAgentsDir(slug) {
  return path.join(decodeSlug(slug), '.claude', 'agents');
}

// --- Global agents: ~/.claude/agents/, available in every project ---

router.get('/global', wrapRoute((req, res) => {
  res.json(listAgents(AGENTS_DIR));
}));

router.get('/global/:filename', wrapRoute((req, res) => readAgent(AGENTS_DIR, req.params.filename, res)));
router.put('/global/:filename', wrapRoute((req, res) => writeAgent(AGENTS_DIR, req.params.filename, req.body, res)));
router.delete('/global/:filename', wrapRoute((req, res) => deleteAgent(AGENTS_DIR, req.params.filename, res)));

// --- Project agents: <project>/.claude/agents/ ---

router.get('/project/:slug', wrapRoute((req, res) => {
  res.json(listAgents(projectAgentsDir(req.params.slug)));
}));

router.get('/project/:slug/:filename', wrapRoute((req, res) => readAgent(projectAgentsDir(req.params.slug), req.params.filename, res)));
router.put('/project/:slug/:filename', wrapRoute((req, res) => writeAgent(projectAgentsDir(req.params.slug), req.params.filename, req.body, res)));
router.delete('/project/:slug/:filename', wrapRoute((req, res) => deleteAgent(projectAgentsDir(req.params.slug), req.params.filename, res)));

module.exports = router;

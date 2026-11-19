const express = require('express');
const fs = require('fs');
const path = require('path');
const { backup, readJson, isSafeKey, wrapRoute } = require('../lib/file-helpers');
const { decodeSlug } = require('../lib/slug');
const { CLAUDE_DIR, CLAUDE_JSON } = require('../lib/paths');

const router = express.Router();

function toForwardSlashes(p) {
  return p.replace(/\\/g, '/');
}

function findProjectKey(claudeJson, projectPath) {
  const projects = claudeJson.projects || {};
  const target = toForwardSlashes(projectPath).toLowerCase();
  for (const key of Object.keys(projects)) {
    if (toForwardSlashes(key).toLowerCase() === target) return key;
  }
  return null;
}

router.get('/global', (req, res) => {
  const claudeJson = readJson(CLAUDE_JSON, {});
  res.json({ servers: claudeJson.mcpServers || {} });
});

router.get('/cloud', (req, res) => {
  const creds = readJson(path.join(CLAUDE_DIR, '.credentials.json'), {});
  const mcpOAuth = creds.mcpOAuth || {};
  const claudeJson = readJson(CLAUDE_JSON, {});
  const everConnected = claudeJson.claudeAiMcpEverConnected || [];

  const authenticated = Object.keys(mcpOAuth).map(key => {
    const parts = key.split('|');
    return { key, provider: parts[0] || key, id: parts[1] || '', source: 'oauth' };
  });
  const authProviders = new Set(authenticated.map(a => a.provider.toLowerCase()));

  const history = everConnected
    .map(name => name.replace(/^claude\.ai\s+/i, '').trim())
    .filter(name => name && !authProviders.has(name.toLowerCase()))
    .map(name => ({ key: name, provider: name, id: '', source: 'history' }));

  res.json([...authenticated, ...history]);
});

router.put('/global', wrapRoute((req, res) => {
  backup(CLAUDE_JSON);
  const claudeJson = readJson(CLAUDE_JSON, {});
  claudeJson.mcpServers = (req.body && req.body.servers) || {};
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(claudeJson, null, 2), 'utf-8');
  res.json({ ok: true });
}));

router.get('/project/:slug', (req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const projectFile = path.join(decodedPath, '.mcp.json');
  const projectData = readJson(projectFile, {});
  const projectServers = projectData.mcpServers || projectData.servers || {};

  const claudeJson = readJson(CLAUDE_JSON, {});
  const projectKey = findProjectKey(claudeJson, decodedPath);
  const localServers = (projectKey && claudeJson.projects[projectKey].mcpServers) || {};

  res.json({
    projectScope: { path: projectFile, servers: projectServers },
    localScope: {
      path: CLAUDE_JSON,
      projectKey: projectKey || toForwardSlashes(decodedPath),
      servers: localServers
    }
  });
});

router.put('/project/:slug/project', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  const filePath = path.join(decodedPath, '.mcp.json');
  backup(filePath);
  const existing = readJson(filePath, {});
  existing.mcpServers = (req.body && req.body.servers) || {};
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');
  res.json({ ok: true, path: filePath });
}));

router.put('/project/:slug/local', wrapRoute((req, res) => {
  const decodedPath = decodeSlug(req.params.slug);
  backup(CLAUDE_JSON);
  const claudeJson = readJson(CLAUDE_JSON, {});
  if (!claudeJson.projects) claudeJson.projects = {};
  const existingKey = findProjectKey(claudeJson, decodedPath);
  const key = existingKey || toForwardSlashes(decodedPath);
  if (!isSafeKey(key)) return res.status(400).json({ error: 'Invalid project' });
  if (!claudeJson.projects[key]) claudeJson.projects[key] = {};
  claudeJson.projects[key].mcpServers = (req.body && req.body.servers) || {};
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(claudeJson, null, 2), 'utf-8');
  res.json({ ok: true, projectKey: key });
}));

module.exports = router;

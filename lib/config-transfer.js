const express = require('express');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { backup, wrapRoute } = require('./file-helpers');
const { decodeSlug } = require('./slug');
const { AGENTS_DIR, SKILLS_DIR, BACKUPS_DIR } = require('./paths');

// Export, import and copy for agents (one <name>.md file each) and skills (one <name>/ folder each,
// SKILL.md plus any supporting files), between ~/.claude and any project's .claude folder.

const KINDS = {
  agents: { globalDir: AGENTS_DIR, label: 'agent' },
  skills: { globalDir: SKILLS_DIR, label: 'skill' }
};

const zipBodyParser = express.raw({ type: 'application/zip', limit: '25mb' });

/** Folder of a scope: 'global' or a project slug. */
function scopeDir(kind, scope) {
  if (scope === 'global') return KINDS[kind].globalDir;
  return path.join(decodeSlug(scope), '.claude', kind);
}

/**
 * One file or folder name that is valid on every OS: no path parts, no "." / "..", none of the
 * characters Windows rejects (a ":" would even write an NTFS alternate data stream).
 */
function safePart(part) {
  return !!part && part !== '.' && part !== '..' && !/[\/\<>:"|?*\x00-\x1f]/.test(part);
}

/** An item name straight inside the folder; agents must end in .md. */
function safeName(kind, name) {
  const n = String(name || '');
  if (!safePart(n) || n.includes('..')) return null;
  if (kind === 'agents' && !n.endsWith('.md')) return null;
  return n;
}

/** Same folder on disk, also through symlinks/junctions and, on Windows, in another letter case. */
function sameDir(a, b) {
  const real = p => {
    try { return fs.realpathSync.native(p); } catch (_) { return path.resolve(p); }
  };
  const norm = p => process.platform === 'win32' ? real(p).toLowerCase() : real(p);
  return norm(a) === norm(b);
}

function listNames(kind, dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => kind === 'agents'
      ? d.isFile() && d.name.endsWith('.md')
      : d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'SKILL.md')))
    .map(d => d.name);
}

/** Back up and remove an existing item so it can be replaced. A skill is backed up as a whole folder. */
function clearItem(kind, dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return;
  if (kind === 'agents') {
    backup(p);
    fs.rmSync(p);
  } else {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.cpSync(p, path.join(BACKUPS_DIR, `${name}.${Date.now()}.bak`), { recursive: true });
    fs.rmSync(p, { recursive: true });
  }
}

function exportZip(kind, dir, names) {
  const zip = new AdmZip();
  for (const name of names) {
    const p = path.join(dir, name);
    if (kind === 'agents') zip.addLocalFile(p);
    else zip.addLocalFolder(p, name);
  }
  return zip.toBuffer();
}

/** Items in an uploaded zip: { name, files: [{ rel, data }] }, or a string error. */
function readZipItems(kind, buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { return 'Not a valid ZIP file: ' + e.message; }
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  if (kind === 'agents') {
    const items = entries.filter(e => !e.entryName.includes('/') && e.entryName.endsWith('.md'));
    if (items.length === 0) return 'ZIP contains no agent .md files';
    for (const e of items) if (!safeName(kind, e.entryName)) return 'Invalid file name in ZIP: ' + e.entryName;
    return items.map(e => ({ name: e.entryName, files: [{ rel: e.entryName, data: e.getData() }] }));
  }

  const byName = new Map();
  for (const e of entries) {
    const parts = e.entryName.split('/');
    if (parts.length < 2) continue;
    if (!parts.every(safePart)) return 'Invalid path in ZIP: ' + e.entryName;
    const name = parts[0];
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ rel: parts.slice(1).join('/'), data: e.getData() });
  }
  const items = [...byName].filter(([, files]) => files.some(f => f.rel === 'SKILL.md'))
    .map(([name, files]) => ({ name, files }));
  if (items.length === 0) return 'ZIP contains no skills (folders with SKILL.md)';
  return items;
}

/**
 * Write every item into a staging folder next to the targets first, then swap each one in. A file
 * that cannot be written fails the import before any existing item is touched.
 */
function writeItems(kind, dir, items) {
  const staging = path.join(dir, `.import-${Date.now()}`);
  try {
    for (const item of items) {
      const base = kind === 'agents' ? staging : path.join(staging, item.name);
      for (const f of item.files) {
        const target = path.join(base, f.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.data);
      }
    }
    for (const item of items) {
      clearItem(kind, dir, item.name);
      fs.renameSync(path.join(staging, item.name), path.join(dir, item.name));
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function conflictsIn(kind, dir, names) {
  return names.filter(n => fs.existsSync(path.join(dir, n)));
}

/**
 * Adds /export/<scope>, /import/<scope> and /copy/<scope>/:name to an agents or skills router,
 * where <scope> is global or project/:slug. Kept apart from /<scope>/:name so an item called
 * "export" or "import" still opens.
 */
function mountTransferRoutes(router, kind) {
  const scopes = [
    { path: '/global', scope: () => 'global' },
    { path: '/project/:slug', scope: req => req.params.slug }
  ];

  for (const s of scopes) {
    // ?names=a&names=b exports just those; without it every item in the scope.
    router.get(`/export${s.path}`, wrapRoute((req, res) => {
      const dir = scopeDir(kind, s.scope(req));
      let names = listNames(kind, dir);
      if (req.query.names) {
        const wanted = [].concat(req.query.names).map(String);
        for (const n of wanted) {
          if (!safeName(kind, n)) return res.status(400).json({ error: 'Invalid name: ' + n });
          if (!names.includes(n)) return res.status(404).json({ error: 'Not found: ' + n });
        }
        names = wanted;
      }
      if (names.length === 0) return res.status(404).json({ error: `No ${kind} to export` });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.zip"`);
      res.setHeader('X-File-Count', String(names.length));
      res.send(exportZip(kind, dir, names));
    }));

    router.post(`/import${s.path}`, zipBodyParser, wrapRoute((req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Expected ZIP binary body (Content-Type: application/zip)' });
      }
      const items = readZipItems(kind, req.body);
      if (typeof items === 'string') return res.status(400).json({ error: items });
      const dir = scopeDir(kind, s.scope(req));
      const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
      const conflicts = conflictsIn(kind, dir, items.map(i => i.name));
      if (conflicts.length > 0 && !overwrite) return res.status(409).json({ error: 'conflict', conflicts });
      fs.mkdirSync(dir, { recursive: true });
      writeItems(kind, dir, items);
      res.json({ ok: true, imported: items.length });
    }));

    // Body: { target: 'global' | <project slug> }.
    router.post(`/copy${s.path}/:name`, wrapRoute((req, res) => {
      const name = safeName(kind, req.params.name);
      if (!name) return res.status(400).json({ error: `Invalid ${KINDS[kind].label} name` });
      const target = req.body && req.body.target;
      if (!target) return res.status(400).json({ error: 'Target is required' });
      const srcDir = scopeDir(kind, s.scope(req));
      const destDir = scopeDir(kind, String(target));
      if (!listNames(kind, srcDir).includes(name)) return res.status(404).json({ error: 'Not found' });
      if (sameDir(srcDir, destDir)) return res.status(400).json({ error: 'Target is the same as the source' });
      const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
      const conflicts = conflictsIn(kind, destDir, [name]);
      if (conflicts.length > 0 && !overwrite) return res.status(409).json({ error: 'conflict', conflicts });
      fs.mkdirSync(destDir, { recursive: true });
      clearItem(kind, destDir, name);
      fs.cpSync(path.join(srcDir, name), path.join(destDir, name), { recursive: true });
      res.json({ ok: true });
    }));
  }
}

module.exports = { mountTransferRoutes, sameDir };

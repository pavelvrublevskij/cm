const fs = require('fs');
const path = require('path');
const { decodeSlug } = require('./slug');

const CONTENT_MAX_BYTES = 1024 * 1024;

/** Resolve a project slug + relative path into an absolute path inside the project dir. */
function resolveProjectPath(slug, rel) {
  if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return { status: 400, error: 'Invalid slug' };
  }
  const projectDir = decodeSlug(slug);
  if (!projectDir) return { status: 404, error: 'Project not found' };
  // Existence is the caller's business: a missing target is a 404 there, and checking here would
  // shadow path-traversal rejections (400) for projects that no longer exist on disk.
  const root = path.resolve(projectDir);
  const target = path.resolve(root, rel || '');
  const relCheck = path.relative(root, target);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { status: 400, error: 'Invalid file path' };
  }
  return { root, target, rel: relCheck.replace(/\\/g, '/') };
}

/**
 * Walk down a chain of directories that hold nothing but a single directory, so
 * src/main/java/app collapses into one tree row. Stops at the first directory
 * with files of its own or more than one subdirectory.
 */
function collapseDirChain(absDir, name) {
  let merged = name;
  let current = path.join(absDir, name);
  for (;;) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (_) { return merged; }
    const dirs = entries.filter(e => e.isDirectory());
    if (dirs.length !== 1 || entries.some(e => e.isFile())) return merged;
    merged += '/' + dirs[0].name;
    current = path.join(current, dirs[0].name);
  }
}

/** List one directory level — directories first, then files, both case-insensitive alphabetical. */
function listDir(absDir) {
  const entries = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      entries.push({ name: collapseDirChain(absDir, entry.name), type: 'dir' });
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(abs);
        entries.push({ name: entry.name, type: 'file', size: stat.size, mtime: stat.mtimeMs });
      } catch (_) { /* vanished between readdir and stat */ }
    }
  }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/** Read a file for display, flagging binary and oversized content instead of returning it. */
function readFileForEditor(target, maxBytes = CONTENT_MAX_BYTES) {
  const stat = fs.statSync(target);
  if (stat.size > maxBytes) {
    return { binary: false, tooLarge: true, size: stat.size, mtime: stat.mtimeMs };
  }
  const buffer = fs.readFileSync(target);
  if (buffer.subarray(0, 8000).includes(0)) {
    return { binary: true, size: stat.size, mtime: stat.mtimeMs };
  }
  return { binary: false, content: buffer.toString('utf-8'), size: stat.size, mtime: stat.mtimeMs };
}

module.exports = { CONTENT_MAX_BYTES, resolveProjectPath, listDir, readFileForEditor };

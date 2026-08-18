const fs = require('fs');
const path = require('path');
const { decodeSlug } = require('./slug');

const CONTENT_MAX_BYTES = 1024 * 1024;
const SEARCH_EXCLUDED_DIRS = new Set(['node_modules', '.git']);
const SEARCH_MAX_RESULTS = 500;

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
 * Resolve a Dirent's actual type, following symlinks/junctions (Dirent.isDirectory()/isFile()
 * use lstat semantics and report false for both on a linked directory or file). Returns null
 * for broken links or anything that vanished between readdir and stat.
 */
function direntType(entry, abs) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) {
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return 'dir';
      if (stat.isFile()) return 'file';
    } catch (_) { /* broken symlink */ }
  }
  return null;
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
    const types = entries.map(e => direntType(e, path.join(current, e.name)));
    const dirs = types.filter(t => t === 'dir');
    if (dirs.length !== 1 || types.some(t => t === 'file')) return merged;
    const onlyDir = entries[types.indexOf('dir')];
    merged += '/' + onlyDir.name;
    current = path.join(current, onlyDir.name);
  }
}

/** List one directory level — directories first, then files, both case-insensitive alphabetical. */
function listDir(absDir) {
  const entries = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const type = direntType(entry, abs);
    if (type === 'dir') {
      entries.push({ name: collapseDirChain(absDir, entry.name), type: 'dir' });
    } else if (type === 'file') {
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

function isUpper(ch) {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

/**
 * True if text[i] starts a new "hump": an uppercase letter at the very start of the string, right
 * after a separator/digit, or right after a lowercase letter (a camelCase transition). An uppercase
 * letter that just continues an existing all-caps run — the M in "..._AM_..." — is not a hump start,
 * which is what keeps an unrelated all-caps token from acting as a matchable initial.
 */
function isHumpStart(text, i) {
  return isUpper(text[i]) && (i === 0 || !isUpper(text[i - 1]));
}

/**
 * True if query matches text as either a contiguous case-insensitive substring, or a subsequence
 * that lands only on text's hump-start letters (an acronym match, e.g. "pr" hitting ProjectRunner
 * via its P and R, or "P-Runner" via P and the R right after the dash). A subsequence through
 * lowercase letters, or through a non-hump-start capital, does not count — that is what tells
 * "P..R.." and "pr.." apart from the non-matches "p..R..", "P..r.." and "p..r".
 */
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (text.toLowerCase().includes(q)) return true;
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (isHumpStart(text, ti) && text[ti].toLowerCase() === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Recursively fuzzy-search file/dir names under root, skipping node_modules and .git. */
function searchTree(root, query, maxResults = SEARCH_MAX_RESULTS) {
  const matches = [];
  let truncated = false;

  function walk(absDir, relDir) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(absDir, entry.name);
      const type = direntType(entry, abs);
      if (!type) continue;
      const isDir = type === 'dir';
      if (isDir && SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      if (fuzzyMatch(query, entry.name)) {
        matches.push({ path: rel, type });
        if (matches.length >= maxResults) { truncated = true; return; }
      }
      if (isDir) walk(abs, rel);
    }
  }

  walk(root, '');
  return { matches, truncated };
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

module.exports = { CONTENT_MAX_BYTES, resolveProjectPath, listDir, searchTree, readFileForEditor };

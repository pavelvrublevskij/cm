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

function isLower(ch) {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

/** Anything that isn't a letter — punctuation, digits, whitespace — separates words. */
function isSeparator(ch) {
  return !isUpper(ch) && !isLower(ch);
}

/**
 * True if text[i] starts a new word: the very start of the name, right after a separator (so both
 * "project-files" and "snake_case" segment on their punctuation), or a camelCase hump (an uppercase
 * letter right after a lowercase one). A letter that only continues a run — the "o" in "project",
 * the "M" in "..._AM_..." — is not a word start, which is what keeps a random letter inside a word,
 * or inside an all-caps token, from acting as a matchable initial.
 */
function isWordStart(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  return isSeparator(prev) || (isUpper(text[i]) && isLower(prev));
}

/**
 * True if query matches text as either a contiguous case-insensitive substring, or a subsequence
 * that lands only on text's word-start letters (e.g. "pr" hitting ProjectRunner via its P and R
 * humps, or "pf" hitting "project-files" via the p and the f right after the dash). A subsequence
 * through a letter that is just sitting mid-word — not a word start — does not count, which is what
 * tells "P..R.." and "pr.." apart from the non-matches "p..R..", "P..r.." and "p..r".
 */
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (text.toLowerCase().includes(q)) return true;
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (isWordStart(text, ti) && text[ti].toLowerCase() === q[qi]) qi++;
  }
  return qi === q.length;
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** True if abs is a readable, non-binary, non-oversized file whose contents contain lowerQuery. */
function contentContains(abs, lowerQuery, maxBytes = CONTENT_MAX_BYTES) {
  let stat;
  try { stat = fs.statSync(abs); } catch (_) { return false; }
  if (stat.size > maxBytes) return false;
  let buffer;
  try { buffer = fs.readFileSync(abs); } catch (_) { return false; }
  if (looksBinary(buffer)) return false;
  return buffer.toString('utf-8').toLowerCase().includes(lowerQuery);
}

/**
 * Recursively search file/dir names — and file contents — under root, skipping node_modules and
 * .git. A name match takes priority; a file whose name doesn't match is still included if its
 * contents contain query as a plain, case-insensitive substring.
 */
function searchTree(root, query, maxResults = SEARCH_MAX_RESULTS) {
  const matches = [];
  const lowerQuery = query.toLowerCase();
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
      const matchedBy = fuzzyMatch(query, entry.name) ? 'name'
        : (!isDir && contentContains(abs, lowerQuery)) ? 'content'
        : null;
      if (matchedBy) {
        matches.push({ path: rel, type, matchedBy });
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
  if (looksBinary(buffer)) {
    return { binary: true, size: stat.size, mtime: stat.mtimeMs };
  }
  return { binary: false, content: buffer.toString('utf-8'), size: stat.size, mtime: stat.mtimeMs };
}

module.exports = { CONTENT_MAX_BYTES, resolveProjectPath, listDir, searchTree, readFileForEditor };

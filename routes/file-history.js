const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CLAUDE_DIR, PROJECTS_DIR } = require('../lib/paths');
const { wrapRoute } = require('../lib/file-helpers');
const { openPath, revealInFileManager } = require('../lib/os-open');
const planCache = require('../lib/plan-cache');
const { resolveProjectPath } = require('../lib/project-files');
const { decodeSlug } = require('../lib/slug');
const { computeDiff } = require('../lib/diff');
const { extractBashWrites } = require('../lib/bash-writes');
const { readBaselines } = require('../lib/read-baseline');

const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');

const router = express.Router();
const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');

/**
 * Claude Code names file-history backups `<sha256(absolute path) truncated to 16 hex>@v<n>`.
 * Recomputing it recovers the path -> backup mapping for sessions whose transcript carries no
 * file-history-snapshot records (newer Claude Code versions omit them).
 */
function backupHash(absPath) {
  return crypto.createHash('sha256').update(absPath, 'utf8').digest('hex').slice(0, 16);
}

/** Splits shell arg text into tokens, keeping quoted substrings intact. */
function tokenizeShellArgs(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return tokens;
}

/**
 * Claude Code has no dedicated delete tool — deletions happen via `rm`/`git rm` inside Bash calls,
 * which carry no file-history snapshot. This scans a single Bash command for `cd`/`rm`-family
 * statements to recover the paths it deleted, resolving `cd`s only within that same command string
 * (cwd is not tracked across separate Bash calls — too unreliable to simulate).
 */
function extractBashDeletions(command) {
  const statements = (command || '').split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  let cwd = '';
  const targets = [];
  for (const stmt of statements) {
    const cdMatch = stmt.match(/^cd\s+(\S+)/);
    if (cdMatch) {
      cwd = path.posix.join(cwd, cdMatch[1].replace(/^["']|["']$/, '').replace(/["']$/, ''));
      continue;
    }
    const rmMatch = stmt.match(/^(?:git\s+rm|rm|rmdir|del|Remove-Item|unlink)\b(.*)$/i);
    if (!rmMatch) continue;
    for (const tok of tokenizeShellArgs(rmMatch[1])) {
      if (tok.startsWith('-') || tok.startsWith('/') || /^\d*>/.test(tok)) continue;
      targets.push(path.posix.join(cwd, tok));
    }
  }
  return targets;
}

/**
 * Text of a user entry when it is a prompt the user typed — not a tool result, meta/sidechain
 * entry, local-command caveat or /clear. Returns null for anything else.
 */
function userPromptText(obj) {
  if (obj.type !== 'user' || obj.isMeta || obj.isSidechain) return null;
  const content = obj.message && obj.message.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some(b => b.type === 'tool_result')) {
    const block = content.find(b => b.type === 'text');
    if (block) text = block.text || '';
  }
  if (text === null) return null;
  if (text.includes('Caveat: The messages below were generated')) return null;
  const cmd = text.match(/<command-name>(\/[\w-]+)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    text = cmd[1] + (args && args[1].trim() ? ' ' + args[1].trim() : '');
    if (text === '/clear') return null;
  }
  return text;
}

/** Resolve+validate a projSlug/filePath pair against the project dir. Returns { error, status } or { target }. */
function resolveProjectFile(projSlug, filePath) {
  if (!filePath) return { status: 400, error: 'Invalid file path' };

  const resolved = resolveProjectPath(projSlug, filePath);
  if (resolved.error) return resolved;
  if (!fs.existsSync(resolved.target) || !fs.statSync(resolved.target).isFile()) {
    return { status: 404, error: 'File not found' };
  }
  return { target: resolved.target };
}

router.get('/:sessionId/context', wrapRoute(async (req, res) => {
  const { sessionId } = req.params;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const histDir = path.join(FILE_HISTORY_DIR, sessionId);
  let files = [];

  let projSlug = null;
  const planPathsFromSession = new Set();
  // Temporary diagnostic for the macOS file-detection issue -- pass ?debug=1 to see, per tool
  // call, why a file was or wasn't matched into the project directory. Remove once resolved.
  const debug = req.query.debug === '1' ? [] : null;

  // Always find the session JSONL regardless of whether file-history exists
  let sessionContent = null;
  for (const proj of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const candidate = path.join(PROJECTS_DIR, proj.name, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) {
      try { sessionContent = fs.readFileSync(candidate, 'utf-8'); projSlug = proj.name; } catch (_) {}
      break;
    }
  }

  const prompts = [];

  if (sessionContent) {
    const fileMap = {};
    // relative path -> Set of prompt indices whose tool calls touched it
    const filePrompts = new Map();
    const touch = (relNorm, promptIdx) => {
      if (!promptIdx) return;
      if (!filePrompts.has(relNorm)) filePrompts.set(relNorm, new Set());
      filePrompts.get(relNorm).add(promptIdx);
    };
    // relative path -> shell commands that wrote or removed it, in session order
    const fileScripts = new Map();
    const addScript = (relNorm, block, obj, promptIdx) => {
      if (!fileScripts.has(relNorm)) fileScripts.set(relNorm, []);
      const list = fileScripts.get(relNorm);
      if (block.id && list.some(sc => sc.id === block.id)) return;
      list.push({
        id: block.id || null,
        tool: block.name,
        command: block.input.command || '',
        description: block.input.description || '',
        timestamp: obj.timestamp || null,
        prompt: promptIdx || null
      });
    };

    for (const line of sessionContent.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (planPathsFromSession.size === 0 && obj.type === 'assistant') {
          const content = obj.message && obj.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type !== 'tool_use' || !block.input) continue;
              if (block.name === 'ExitPlanMode' && block.input.planFilePath) {
                planPathsFromSession.add(block.input.planFilePath);
              } else if (block.name === 'Write' && block.input.file_path) {
                const planRel = path.relative(PLANS_DIR, path.resolve(block.input.file_path));
                if (!planRel.startsWith('..') && !path.isAbsolute(planRel)) {
                  planPathsFromSession.add(block.input.file_path);
                }
              }
            }
          }
        }
        if (fs.existsSync(histDir)) {
          if (obj.type !== 'file-history-snapshot' || !obj.isSnapshotUpdate) continue;
          const backups = obj.snapshot && obj.snapshot.trackedFileBackups;
          if (!backups) continue;
          for (const [filePath, info] of Object.entries(backups)) {
            if (!fileMap[filePath]) fileMap[filePath] = { hash: null, maxVersion: 0, isNew: false };
            if (!info.backupFileName) {
              fileMap[filePath].isNew = true;
              continue;
            }
            if (!fileMap[filePath].hash) fileMap[filePath].hash = info.backupFileName.split('@')[0];
            fileMap[filePath].maxVersion = Math.max(fileMap[filePath].maxVersion, info.version);
          }
        }
      } catch (_) {}
    }

    const projectDir = projSlug ? decodeSlug(projSlug) : null;

    // Fallback: collect files touched via Write/Edit/MultiEdit tool calls, plus files/dirs removed
    // via rm/git rm inside Bash calls (Claude Code has no dedicated delete tool).
    // Runs unconditionally so sessions without a file-history dir still show their files.
    if (projectDir) {
      const resolvedProjectDir = path.resolve(projectDir);
      const existingKeys = new Set(Object.keys(fileMap).map(k => k.replace(/\\/g, '/')));
      let sessionStart = 0;
      for (const line of sessionContent.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (!sessionStart && obj.timestamp) sessionStart = Date.parse(obj.timestamp) || 0;
          const promptText = userPromptText(obj);
          if (promptText !== null) {
            prompts.push({ index: prompts.length + 1, text: promptText.slice(0, 200), timestamp: obj.timestamp || null });
            continue;
          }
          if (obj.type !== 'assistant') continue;
          const promptIdx = prompts.length;
          const content = obj.message && obj.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type !== 'tool_use' || !block.input) continue;
            if (block.name === 'Bash' || block.name === 'PowerShell') {
              // Shell writes carry no snapshot; accept a parsed target only if it exists in the
              // project and was modified after the session began.
              for (const { cwd, target } of extractBashWrites(block.input.command)) {
                for (const base of [path.resolve(resolvedProjectDir, cwd), resolvedProjectDir]) {
                  const abs = path.resolve(base, target);
                  const rel = path.relative(resolvedProjectDir, abs);
                  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
                  let st;
                  try { st = fs.statSync(abs); } catch (_) { continue; }
                  if (!st.isFile() || st.mtimeMs < sessionStart) continue;
                  const relNorm = rel.replace(/\\/g, '/');
                  if (!existingKeys.has(relNorm)) {
                    existingKeys.add(relNorm);
                    fileMap[relNorm] = { hash: null, maxVersion: 0, isNew: false };
                  }
                  touch(relNorm, promptIdx);
                  addScript(relNorm, block, obj, promptIdx);
                  break;
                }
              }
            }
            if (block.name === 'Bash') {
              for (const target of extractBashDeletions(block.input.command)) {
                const abs = path.resolve(resolvedProjectDir, target);
                const rel = path.relative(resolvedProjectDir, abs);
                if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
                const relNorm = rel.replace(/\\/g, '/');
                // Only trust a parsed rm target once disk confirms it's actually gone — an
                // imperfect shell parse should never mislabel a still-present file as deleted.
                // Skip it entirely if it's a directory whose contents are already tracked
                // individually (e.g. `rm -rf src` after files under src/ were written) — adding
                // the bare directory path as its own "file" entry duplicates those rows in the tree.
                const prefix = relNorm + '/';
                const isTrackedDir = [...existingKeys].some(k => k.startsWith(prefix));
                if (fs.existsSync(abs) || isTrackedDir) continue;
                touch(relNorm, promptIdx);
                addScript(relNorm, block, obj, promptIdx);
                if (existingKeys.has(relNorm)) continue;
                existingKeys.add(relNorm);
                fileMap[relNorm] = { hash: null, maxVersion: 0, isNew: false };
              }
              continue;
            }
            let filePath = null;
            let isNew = false;
            if (block.name === 'Write') { filePath = block.input.file_path; isNew = true; }
            else if (block.name === 'Edit' || block.name === 'MultiEdit') { filePath = block.input.file_path; }
            else if (block.name === 'NotebookEdit') { filePath = block.input.notebook_path; }
            if (!filePath) continue;
            const rel = path.relative(resolvedProjectDir, path.resolve(filePath));
            const included = !(rel.startsWith('..') || path.isAbsolute(rel));
            if (debug) debug.push({ tool: block.name, filePath, resolvedProjectDir, rel, included });
            if (!included) continue;
            const relNorm = rel.replace(/\\/g, '/');
            touch(relNorm, promptIdx);
            if (!existingKeys.has(relNorm)) {
              existingKeys.add(relNorm);
              fileMap[relNorm] = { hash: null, maxVersion: 0, isNew };
            }
          }
        } catch (_) {}
      }
    }

    const histFiles = fs.existsSync(histDir) ? fs.readdirSync(histDir) : [];

    // Files found via tool calls carry no backup name; recover it from the path so their diffs work.
    if (projectDir && histFiles.length) {
      for (const [filePath, info] of Object.entries(fileMap)) {
        if (info.hash || info.isNew) continue;
        const candidate = backupHash(path.resolve(projectDir, filePath));
        if (histFiles.some(f => f.startsWith(candidate + '@v'))) info.hash = candidate;
      }
    }

    const readBases = projectDir ? readBaselines(sessionContent, projectDir) : new Map();

    files = Object.entries(fileMap).map(([filePath, info]) => {
      const versions = info.hash ? histFiles
        .filter(f => f.startsWith(info.hash + '@v'))
        .map(f => parseInt(f.split('@v')[1], 10))
        .filter(v => !isNaN(v))
        .sort((a, b) => a - b) : [];
      let isDeleted = false;
      let mtime = null;
      if (projectDir) {
        const currentFile = path.resolve(projectDir, filePath);
        try {
          mtime = fs.statSync(currentFile).mtimeMs;
        } catch (_) {
          isDeleted = true;
        }
      }
      // No snapshot: the session's own earlier full Read of the file stands in as the "before" text.
      const readBase = !info.hash && !info.isNew && !isDeleted && readBases.has(filePath);
      const relKey = projectDir && path.isAbsolute(filePath) ? path.relative(path.resolve(projectDir), path.resolve(filePath)) : filePath;
      const relNormKey = relKey.replace(/\\/g, '/');
      const touchedBy = filePrompts.get(relNormKey);
      const promptIdxs = touchedBy ? [...touchedBy].sort((a, b) => a - b) : [];
      const scripts = fileScripts.get(relNormKey) || [];
      return { path: filePath, hash: info.hash, versions, isNew: info.isNew, isDeleted, mtime, readBase, prompts: promptIdxs, scripts };
    });
    // Every entry came from a snapshot backup or a Write/Edit/MultiEdit/NotebookEdit call, so all of
    // them were touched by this session. Files without a recorded snapshot have no diff, but their
    // current source is still viewable in the Files tab — they used to be filtered out here.
  }

  // Plans linked to this session via ExitPlanMode planFilePath
  const plans = [];
  for (const planPath of planPathsFromSession) {
    const name = path.basename(planPath, '.md');
    try {
      const stat = fs.statSync(path.join(PLANS_DIR, name + '.md'));
      plans.push({ name, mtime: stat.mtime });
    } catch (_) {}
  }
  planCache.set(sessionId, plans.length > 0);

  res.json(debug ? { files, plans, projSlug, prompts, debug } : { files, plans, projSlug, prompts });
}));

router.post('/open-file', wrapRoute((req, res) => {
  const { projSlug, filePath } = req.body || {};
  const resolved = resolveProjectFile(projSlug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  openPath(resolved.target);
  res.json({ ok: true });
}));

router.post('/reveal-file', wrapRoute((req, res) => {
  const { projSlug, filePath } = req.body || {};
  const resolved = resolveProjectFile(projSlug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  revealInFileManager(resolved.target);
  res.json({ ok: true });
}));

router.get('/:sessionId/:hash/diff', wrapRoute((req, res) => {
  const { sessionId, hash } = req.params;
  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);

  for (const p of [sessionId, hash]) {
    if (p.includes('..') || p.includes('/') || p.includes('\\')) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }
  }

  const histDir = path.join(FILE_HISTORY_DIR, sessionId);
  const fromFile = path.join(histDir, `${hash}@v${from}`);
  const toFile = path.join(histDir, `${hash}@v${to}`);

  if (!fs.existsSync(fromFile) || !fs.existsSync(toFile)) {
    return res.status(404).json({ error: 'Version not found' });
  }

  const oldText = fs.readFileSync(fromFile, 'utf-8');
  const newText = fs.readFileSync(toFile, 'utf-8');
  res.json(computeDiff(oldText, newText));
}));

/** The session's recorded pre-edit text for a shell-edited file, or null when none was captured. */
function readBaselineText(sessionId, projSlug, filePath) {
  const file = path.join(PROJECTS_DIR, projSlug, sessionId + '.jsonl');
  if (!fs.existsSync(file)) return null;
  const bases = readBaselines(fs.readFileSync(file, 'utf-8'), decodeSlug(projSlug));
  const text = bases.get(filePath.replace(/\\/g, '/'));
  return text === undefined ? null : text;
}

router.get('/:sessionId/:hash/diff-current', wrapRoute((req, res) => {
  const { sessionId, hash } = req.params;
  const version = parseInt(req.query.version, 10);
  const { projSlug, filePath } = req.query;
  const isNew = req.query.isNew === 'true';
  const readBase = req.query.readBase === 'true';

  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  if (!isNew && (hash.includes('..') || hash.includes('/') || hash.includes('\\'))) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  const resolved = resolveProjectPath(projSlug, filePath);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  const currentFile = resolved.target;
  const currentExists = fs.existsSync(currentFile);

  let oldText = '';
  if (readBase) {
    const text = readBaselineText(sessionId, projSlug, filePath);
    if (text === null) return res.status(404).json({ error: 'No earlier Read of this file in the session' });
    const lf = (t) => t.replace(/\r\n/g, '\n');
    return res.json(computeDiff(lf(text), currentExists ? lf(fs.readFileSync(currentFile, 'utf-8')) : ''));
  }
  if (!isNew) {
    const histDir = path.join(FILE_HISTORY_DIR, sessionId);
    const fromFile = path.join(histDir, `${hash}@v${version}`);
    if (!fs.existsSync(fromFile)) return res.status(404).json({ error: 'Version not found' });
    oldText = fs.readFileSync(fromFile, 'utf-8');
  }

  const newText = currentExists ? fs.readFileSync(currentFile, 'utf-8') : '';
  res.json(computeDiff(oldText, newText));
}));

module.exports = router;

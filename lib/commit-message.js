const fs = require('fs');
const path = require('path');
const { git } = require('./git');

// The diff sent to claude is cut here: a commit message needs the gist, not every line.
const MAX_DIFF_CHARS = 60000;
const MAX_UNTRACKED_CHARS = 8000;
const RECENT_SUBJECTS = 10;

/**
 * What committing `files` would record, as text for the prompt: the diff against HEAD for
 * tracked files and the start of each new (untracked) file. Read-only — the index is not touched.
 */
async function collectChanges(projectPath, files) {
  let diff;
  try {
    diff = await git(['diff', 'HEAD', '--', ...files], projectPath);
  } catch (_) {
    // No commits yet, so no HEAD: staged plus unstaged changes are the whole story.
    diff = [await git(['diff', '--cached', '--', ...files], projectPath), await git(['diff', '--', ...files], projectPath)]
      .filter(Boolean).join('\n');
  }

  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '--', ...files], projectPath))
    .split('\n').map(s => s.trim()).filter(Boolean);
  const root = path.resolve(projectPath);
  const added = [];
  for (const rel of untracked) {
    const abs = path.resolve(projectPath, rel);
    if (!abs.startsWith(root + path.sep)) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf-8'); } catch (_) { continue; }
    if (text.includes('\u0000')) { added.push(`New file ${rel} (binary)`); continue; }
    const cut = text.length > MAX_UNTRACKED_CHARS ? text.slice(0, MAX_UNTRACKED_CHARS) + '\n… (cut)' : text;
    added.push(`New file ${rel}:\n${cut}`);
  }

  let out = diff + (added.length ? '\n' + added.join('\n\n') : '');
  if (out.length > MAX_DIFF_CHARS) out = out.slice(0, MAX_DIFF_CHARS) + '\n… (diff cut, ' + (out.length - MAX_DIFF_CHARS) + ' more characters)';
  return out;
}

/** The repo's recent commit subjects, so the message matches its style. Empty for a new repo. */
async function recentSubjects(projectPath) {
  try {
    return (await git(['log', '-' + RECENT_SUBJECTS, '--format=%s'], projectPath)).split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function buildPrompt(changes, subjects) {
  return [
    'Write a git commit message for the changes below.',
    '',
    'Rules:',
    '- First line: a summary of at most 72 characters, imperative mood ("Add", "Fix", not "Added").',
    '- If the change needs more explanation, add a blank line and a short body (plain sentences or "- " bullets) about what changed and why.',
    '- Match the style of the recent commit subjects when there are any.',
    '- Output only the commit message: no quotes, no code fences, no preamble.',
    '',
    subjects.length ? 'Recent commit subjects:\n' + subjects.map(s => '- ' + s).join('\n') : 'This repository has no commits yet.',
    '',
    'Changes:',
    changes
  ].join('\n');
}

/** Strips wrappers a model may add despite the rules: code fences and surrounding quotes. */
function cleanMessage(text) {
  let msg = String(text).trim();
  const fence = msg.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) msg = fence[1].trim();
  if (/^".*"$/s.test(msg) && !msg.slice(1, -1).includes('"')) msg = msg.slice(1, -1).trim();
  return msg;
}

module.exports = { collectChanges, recentSubjects, buildPrompt, cleanMessage, MAX_DIFF_CHARS };

const path = require('path');

// The AskUserQuestion hook (scripts/question-hook.js): a PreToolUse hook that holds Claude's question
// in CM so the conversation view can answer it. Shared by the browser-terminal and Task Board hook files.

const QUESTION_HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'question-hook.js');
// How long the hook holds a question for an answer from CM; then claude shows its own menu.
const QUESTION_HOLD_MS = 600000;

const fwd = p => p.replace(/\\/g, '/');

/** The PreToolUse hook group for AskUserQuestion; its timeout outlasts the hold so the hook ends itself. */
function questionHookGroup() {
  const command = `"${fwd(process.execPath)}" "${fwd(QUESTION_HOOK_SCRIPT)}"`;
  return { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command, timeout: QUESTION_HOLD_MS / 1000 + 10 }] };
}

/**
 * Check answers for held questions: one non-empty string per question, keyed by the question text.
 * Returns '' when they are fine, else the error.
 */
function answersError(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'Answers are missing';
  const texts = questions.map(q => q.question);
  const keys = Object.keys(answers);
  if (keys.length !== texts.length || !texts.every(t => keys.includes(t))) return 'Answer every question';
  for (const t of texts) {
    const a = answers[t];
    if (typeof a !== 'string' || !a.trim()) return 'Answer every question';
  }
  return '';
}

module.exports = { QUESTION_HOOK_SCRIPT, QUESTION_HOLD_MS, questionHookGroup, answersError };

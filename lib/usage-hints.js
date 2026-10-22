const { collectScope } = require('./usage-insights');

// Thresholds for the free, rule-based hints. Each rule only fires with enough data behind it.
const MIN_PROMPT_TOKENS = 1_000_000;
const CACHE_HIT_MIN = 0.8;
const CACHE_WRITE_MAX = 0.2;
const OPUS_SHARE_MAX = 0.8;
const MIN_COST_FOR_MODEL_HINT = 5;
const EXPENSIVE_SESSION = 5;
const LONG_SESSION_TOKENS = 20_000_000;

function pct(n) {
  return Math.round(n * 100) + '%';
}

function money(n) {
  return '$' + n.toFixed(2);
}

/**
 * Quick efficiency warnings for the filtered usage, computed locally without AI.
 * Each hint: { id, level: 'warn' | 'info', title, detail }.
 */
function buildHints(index, filters) {
  const { sessions, totals, cost, modelStats } = collectScope(index, filters);
  const hints = [];
  if (!sessions.length) return hints;

  const promptSide = totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens;
  if (promptSide >= MIN_PROMPT_TOKENS) {
    const hit = totals.cache_read_input_tokens / promptSide;
    const write = totals.cache_creation_input_tokens / promptSide;
    if (hit < CACHE_HIT_MIN) {
      hints.push({
        id: 'cache-hit',
        level: 'warn',
        title: 'Cache hit ' + pct(hit),
        detail: 'Only ' + pct(hit) + ' of prompt tokens came from cache; Claude Code usually runs above ' + pct(CACHE_HIT_MIN) + '. '
          + 'Context is being rebuilt often: many short sessions, /clear, CLAUDE.md edits, model switches, or pauses over 5 minutes.'
      });
    }
    if (write > CACHE_WRITE_MAX) {
      hints.push({
        id: 'cache-write',
        level: 'warn',
        title: 'Cache writes ' + pct(write),
        detail: pct(write) + ' of prompt tokens were written to cache (more expensive than input). '
          + 'Long-lived sessions on one task reuse the cache better than starting over.'
      });
    }
  }

  const opusShare = modelStats.filter(m => /opus/i.test(m.model)).reduce((s, m) => s + m.costShare, 0);
  if (cost.total >= MIN_COST_FOR_MODEL_HINT && opusShare >= OPUS_SHARE_MAX) {
    hints.push({
      id: 'opus-share',
      level: 'info',
      title: pct(opusShare) + ' of cost on Opus',
      detail: pct(opusShare) + ' of the ' + money(cost.total) + ' spend ran on Opus. '
        + 'Sonnet handles routine edits, tests and lookups for less — switch with /model sonnet and keep Opus for hard problems.'
    });
  }

  const expensive = sessions.filter(s => s.cost >= EXPENSIVE_SESSION);
  if (expensive.length) {
    hints.push({
      id: 'expensive-sessions',
      level: 'warn',
      title: expensive.length + (expensive.length === 1 ? ' session' : ' sessions') + ' over ' + money(EXPENSIVE_SESSION),
      detail: expensive.length + ' of ' + sessions.length + ' sessions cost ' + money(EXPENSIVE_SESSION) + ' or more (top ' + money(expensive[0].cost) + '). '
        + 'Splitting big tasks into separate sessions and using subagents for exploration keeps each context smaller.'
    });
  }

  const long = sessions.filter(s => s.tokens >= LONG_SESSION_TOKENS);
  if (long.length) {
    hints.push({
      id: 'long-sessions',
      level: 'info',
      title: long.length + (long.length === 1 ? ' session' : ' sessions') + ' over ' + (LONG_SESSION_TOKENS / 1e6) + 'M tokens',
      detail: long.length + ' sessions processed more than ' + (LONG_SESSION_TOKENS / 1e6) + 'M tokens each — every turn re-sends a large context. '
        + 'Run /compact when a session gets long, or /clear when switching to an unrelated task.'
    });
  }

  return hints;
}

module.exports = { buildHints, EXPENSIVE_SESSION, LONG_SESSION_TOKENS };

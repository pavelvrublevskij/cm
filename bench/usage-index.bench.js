const fs = require('fs');
const path = require('path');

// parseSessionUsage() resolves pricing per line via getCurrentPricing(), which re-reads and
// re-parses pricing-history.json from disk on every call. Point DATA_DIR at an empty bench
// fixture dir (no pricing-history.json) so that read hits the FALLBACK_PRICING path and this
// bench never touches the real ~/.claude data — must happen before lib/paths.js is required.
const TMP = path.join(__dirname, 'tmp', 'usage-index');
process.env.CLAUDE_MANAGER_DATA_DIR = TMP;

const { parseSessionUsage } = require('../lib/usage-index');
const { bench, printResults, makeRng } = require('./helpers');

const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'];

function genSessionUsageTranscript(rng, lineCount) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 4 === 0) {
      const model = MODELS[Math.floor(rng() * MODELS.length)];
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        requestId: `req_${i}`,
        message: {
          model,
          usage: {
            input_tokens: Math.floor(rng() * 2000),
            output_tokens: Math.floor(rng() * 500),
            cache_creation_input_tokens: Math.floor(rng() * 1000),
            cache_read_input_tokens: Math.floor(rng() * 5000)
          }
        }
      }));
    } else {
      lines.push(JSON.stringify({
        type: 'user',
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        message: { content: `step ${i}` }
      }));
    }
  }
  return lines.join('\n') + '\n';
}

function writeFixture(name, content) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, name);
  fs.writeFileSync(file, content);
  return file;
}

function run() {
  const rng = makeRng(13);
  const results = [];
  const sizes = [500, 2000, 10000];

  for (const size of sizes) {
    const file = writeFixture(`session-${size}.jsonl`, genSessionUsageTranscript(rng, size));
    results.push(bench(`parseSessionUsage, ${size} lines`, () => parseSessionUsage(file)));
  }

  printResults(results);
  fs.rmSync(TMP, { recursive: true, force: true });
}

module.exports = { run };

if (require.main === module) run();

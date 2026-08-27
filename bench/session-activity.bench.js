const fs = require('fs');
const path = require('path');
const { collectFromJsonl } = require('../lib/session-activity');
const { bench, printResults, makeRng } = require('./helpers');

const TMP = path.join(__dirname, 'tmp', 'session-activity');
const TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task'];

function genTranscript(rng, lineCount) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    if (i % 3 === 0) {
      lines.push(JSON.stringify({
        type: 'user',
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        message: { content: `do thing number ${i}` }
      }));
    } else {
      const tool = TOOLS[Math.floor(rng() * TOOLS.length)];
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        message: {
          content: [
            { type: 'text', text: 'working on it' },
            { type: 'tool_use', name: tool, input: { command: `echo ${i}`, file_path: `/tmp/f${i}.js`, pattern: `pat_${i}` } }
          ]
        }
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
  const rng = makeRng(7);
  const results = [];
  const sizes = [500, 2000, 10000];

  for (const size of sizes) {
    const file = writeFixture(`transcript-${size}.jsonl`, genTranscript(rng, size));
    results.push(bench(`collectFromJsonl, ${size} lines`, () => collectFromJsonl(file)));
  }

  printResults(results);
  fs.rmSync(TMP, { recursive: true, force: true });
}

module.exports = { run };

if (require.main === module) run();

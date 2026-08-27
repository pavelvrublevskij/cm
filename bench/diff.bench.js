const { computeDiff } = require('../lib/diff');
const { bench, printResults, makeRng } = require('./helpers');

function genLines(rng, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(`function line_${i}() { return ${Math.floor(rng() * 100000)}; }`);
  }
  return lines;
}

/** Apply `editCount` scattered single-line edits to a clone of `lines`. */
function applyScatteredEdits(lines, rng, editCount) {
  const out = lines.slice();
  for (let i = 0; i < editCount; i++) {
    const idx = Math.floor(rng() * out.length);
    out[idx] = `edited_${i}_${out[idx]}`;
  }
  return out;
}

/** Apply a handful of edits clustered in one region, leaving long matching prefix/suffix. */
function applyLocalizedEdits(lines, rng, editCount) {
  const out = lines.slice();
  const center = Math.floor(out.length / 2);
  for (let i = 0; i < editCount; i++) {
    const idx = center + i;
    if (idx < out.length) out[idx] = `edited_${i}_${out[idx]}`;
  }
  return out;
}

function run() {
  const rng = makeRng(42);
  const results = [];

  {
    const base = genLines(rng, 2000);
    const edited = applyLocalizedEdits(base, rng, 5);
    results.push(bench('2000 lines, 5 localized edits', () => computeDiff(base.join('\n'), edited.join('\n'))));
  }

  {
    const base = genLines(rng, 2000);
    const edited = applyScatteredEdits(base, rng, 200);
    results.push(bench('2000 lines, 200 scattered edits (~10%)', () => computeDiff(base.join('\n'), edited.join('\n'))));
  }

  {
    const base = genLines(rng, 8000);
    const edited = applyScatteredEdits(base, rng, 400);
    results.push(bench('8000 lines (MAX_LINES), 400 scattered edits', () => computeDiff(base.join('\n'), edited.join('\n')), { iterations: 5, warmup: 1 }));
  }

  {
    const base = genLines(rng, 10000);
    const edited = applyScatteredEdits(base, rng, 500);
    results.push(bench('10000 lines, over MAX_LINES (tooLarge fast path)', () => computeDiff(base.join('\n'), edited.join('\n'))));
  }

  printResults(results);
}

module.exports = { run };

if (require.main === module) run();

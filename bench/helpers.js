const { performance } = require('perf_hooks');

/** Run fn `iterations` times (plus warmup runs) and return timing stats in milliseconds. */
function bench(label, fn, { iterations = 20, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) fn();

  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);

  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / samples.length;
  const min = samples[0];
  const max = samples[samples.length - 1];
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];

  return { label, iterations, min, mean, p50, p95, max };
}

function printResults(results) {
  const rows = results.map(r => ({
    label: r.label,
    'min (ms)': r.min.toFixed(2),
    'p50 (ms)': r.p50.toFixed(2),
    'mean (ms)': r.mean.toFixed(2),
    'p95 (ms)': r.p95.toFixed(2),
    'max (ms)': r.max.toFixed(2)
  }));
  console.table(rows);
}

/** Deterministic pseudo-random generator so bench input sizes are reproducible across runs. */
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

module.exports = { bench, printResults, makeRng };

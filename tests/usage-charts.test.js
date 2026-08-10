const { test } = require('node:test');
const assert = require('node:assert');

// Inline the formulas from usage-charts.js (renderProjects: costForModel and
// lastNonZeroModelIndex) since that file has DOM/Chart.js dependencies and
// cannot be required directly in Node.js.

function costForModel(proj, model, pricing) {
  const t = (proj.byModel || {})[model];
  if (!t) return 0;
  const r = pricing[model] || {};
  return (t.input_tokens || 0) * (r.input || 0) / 1e6
    + (t.output_tokens || 0) * (r.output || 0) / 1e6
    + (t.cache_creation_input_tokens || 0) * (r.cache_write || 0) / 1e6
    + (t.cache_read_input_tokens || 0) * (r.cache_read || 0) / 1e6;
}

function lastNonZeroModelIndex(list, modelList, pricing) {
  return list.map(proj => {
    let last = -1;
    modelList.forEach((m, i) => { if (costForModel(proj, m, pricing) > 0) last = i; });
    return last;
  });
}

const pricing = {
  'model-a': { input: 1, output: 1, cache_write: 0, cache_read: 0 },
  'model-b': { input: 1, output: 1, cache_write: 0, cache_read: 0 },
  'model-c': { input: 1, output: 1, cache_write: 0, cache_read: 0 },
};
const tokens = (n) => ({ input_tokens: n, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

test('lastNonZeroModelIndex: single-model project rounds cap on that model', () => {
  const modelList = ['model-a', 'model-b', 'model-c'];
  const list = [{ byModel: { 'model-a': tokens(10) } }];
  assert.deepStrictEqual(lastNonZeroModelIndex(list, modelList, pricing), [0]);
});

test('lastNonZeroModelIndex: cap lands on the last model with cost, not the last dataset', () => {
  // model-c is last in modelList but has zero cost for this project — the cap
  // must land on model-b, the actual rightmost non-zero segment.
  const modelList = ['model-a', 'model-b', 'model-c'];
  const list = [{ byModel: { 'model-a': tokens(10), 'model-b': tokens(5) } }];
  assert.deepStrictEqual(lastNonZeroModelIndex(list, modelList, pricing), [1]);
});

test('lastNonZeroModelIndex: middle model with zero cost is skipped', () => {
  const modelList = ['model-a', 'model-b', 'model-c'];
  const list = [{ byModel: { 'model-a': tokens(10), 'model-c': tokens(3) } }];
  assert.deepStrictEqual(lastNonZeroModelIndex(list, modelList, pricing), [2]);
});

test('lastNonZeroModelIndex: project with no matching usage caps nothing (-1)', () => {
  const modelList = ['model-a', 'model-b'];
  const list = [{ byModel: {} }];
  assert.deepStrictEqual(lastNonZeroModelIndex(list, modelList, pricing), [-1]);
});

test('lastNonZeroModelIndex: computed independently per project', () => {
  const modelList = ['model-a', 'model-b', 'model-c'];
  const list = [
    { byModel: { 'model-a': tokens(10) } },
    { byModel: { 'model-a': tokens(10), 'model-b': tokens(5), 'model-c': tokens(2) } },
    { byModel: { 'model-b': tokens(1) } },
  ];
  assert.deepStrictEqual(lastNonZeroModelIndex(list, modelList, pricing), [0, 2, 1]);
});

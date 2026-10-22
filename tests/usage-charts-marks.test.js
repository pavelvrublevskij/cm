const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'usage-charts.js'), 'utf-8');
const context = vm.createContext({});
vm.runInContext(src + '\nglobalThis._UsageCharts = UsageCharts;', context);
const UsageCharts = context._UsageCharts;

test('markAt finds the mark whose flag label contains the point', () => {
  UsageCharts.markHits = [
    { x: 100, y: 10, w: 80, h: 16, mark: { id: 'a' } },
    { x: 100, y: 27, w: 60, h: 16, mark: { id: 'b' } }
  ];
  assert.strictEqual(UsageCharts.markAt(120, 15).id, 'a');
  assert.strictEqual(UsageCharts.markAt(150, 30).id, 'b');
});

test('markAt returns null outside every flag label', () => {
  UsageCharts.markHits = [{ x: 100, y: 10, w: 80, h: 16, mark: { id: 'a' } }];
  assert.strictEqual(UsageCharts.markAt(90, 15), null);
  assert.strictEqual(UsageCharts.markAt(120, 40), null);
  UsageCharts.markHits = [];
  assert.strictEqual(UsageCharts.markAt(120, 15), null);
});

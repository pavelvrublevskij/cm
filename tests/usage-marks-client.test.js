const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'usage-marks.js'), 'utf-8');
const context = vm.createContext({
  localStorage: { getItem: () => null, setItem: () => {} },
  fmtTokens: (n) => String(n),
  escapeHtml: (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  Usage: { fmtCost: (n) => '$' + n.toFixed(2) }
});
vm.runInContext(src + '\nglobalThis._UsageMarks = UsageMarks;', context);
const UsageMarks = context._UsageMarks;

test('periodKey matches chart label format for each grouping', () => {
  assert.strictEqual(UsageMarks.periodKey('2026-03-04', 'day'), '2026-03-04');
  assert.strictEqual(UsageMarks.periodKey('2026-03-04', 'hour'), '2026-03-04 00:00');
  assert.strictEqual(UsageMarks.periodKey('2026-03-04', 'week'), '2026-W10');
  assert.strictEqual(UsageMarks.periodKey('2026-03-04', 'month'), '2026-03');
  assert.strictEqual(UsageMarks.periodKey('2026-03-04', 'year'), '2026');
});

test('isoWeek handles year boundaries', () => {
  assert.strictEqual(UsageMarks.isoWeek('2026-01-01'), '2026-W01');
  assert.strictEqual(UsageMarks.isoWeek('2027-01-01'), '2026-W53');
});

test('labelIndex places a mark on its own period', () => {
  const labels = ['2026-03-01', '2026-03-02', '2026-03-03'];
  assert.strictEqual(UsageMarks.labelIndex('2026-03-02', 'day', labels), 1);
});

test('labelIndex moves a mark on an idle day to the next active period', () => {
  const labels = ['2026-03-01', '2026-03-05'];
  assert.strictEqual(UsageMarks.labelIndex('2026-03-03', 'day', labels), 1);
});

test('labelIndex returns -1 outside the charted range', () => {
  const labels = ['2026-03-01', '2026-03-05'];
  assert.strictEqual(UsageMarks.labelIndex('2026-02-20', 'day', labels), -1);
  assert.strictEqual(UsageMarks.labelIndex('2026-03-09', 'day', labels), -1);
  assert.strictEqual(UsageMarks.labelIndex('2026-03-01', 'day', []), -1);
});

test('labelIndex in hour grouping keeps a mark on the first charted day', () => {
  const labels = ['2026-03-01 09:00', '2026-03-01 14:00', '2026-03-02 10:00'];
  assert.strictEqual(UsageMarks.labelIndex('2026-03-01', 'hour', labels), 0);
  assert.strictEqual(UsageMarks.labelIndex('2026-03-02', 'hour', labels), 2);
});

test('labelIndex in month grouping', () => {
  const labels = ['2026-01', '2026-02', '2026-03'];
  assert.strictEqual(UsageMarks.labelIndex('2026-02-15', 'month', labels), 1);
});

test('byLabelIndex groups marks that land on the same period', () => {
  UsageMarks.marks = [
    { id: 'a', date: '2026-03-02', title: 'A' },
    { id: 'b', date: '2026-03-02', title: 'B' },
    { id: 'c', date: '2026-01-01', title: 'Outside' }
  ];
  const map = UsageMarks.byLabelIndex('day', ['2026-03-01', '2026-03-02']);
  assert.strictEqual(JSON.stringify(Object.keys(map)), '["1"]');
  assert.strictEqual(map[1].map(m => m.id).join(','), 'a,b');
});

test('fmtPct colors a drop as good and a rise as bad', () => {
  assert.match(UsageMarks.fmtPct(-25), /mark-delta-good.*-25%/);
  assert.match(UsageMarks.fmtPct(40), /mark-delta-bad.*\+40%/);
  assert.match(UsageMarks.fmtPct(null), /n\/a/);
});

test('scopeName is Global for global marks and the project folder name otherwise', () => {
  assert.strictEqual(UsageMarks.scopeName({ project: null }), 'Global');
  assert.strictEqual(UsageMarks.scopeName({ project: 'C--x-cm', projectName: 'C:\\Users\\me\\code\\cm' }), 'cm');
  assert.strictEqual(UsageMarks.scopeName({ project: 'x', projectName: '/home/me/bosh' }), 'bosh');
});

test('flagText shows scope and title, cut to 40 characters', () => {
  assert.strictEqual(UsageMarks.flagText({ project: null, title: 'New skill' }), '\u2691 Global \u00b7 New skill');
  const long = UsageMarks.flagText({ project: null, title: 'x'.repeat(80) });
  assert.strictEqual(long.length, 40);
  assert.ok(long.endsWith('\u2026'));
});

test('tooltipHtml shows date, scope badge, title and description, escaped', () => {
  const html = UsageMarks.tooltipHtml([
    { date: '2026-03-02', title: 'New <skill>', description: 'Code optimization', project: null },
    { date: '2026-03-02', title: 'Proj mark', description: '', project: 'x', projectName: '/home/me/bosh' }
  ]);
  assert.match(html, /2026-03-02 <span class="mark-tip-scope mark-tip-global">Global<\/span> New &lt;skill&gt;/);
  assert.match(html, /<div class="mark-tip-desc">Code optimization<\/div>/);
  assert.match(html, /<span class="mark-tip-scope">bosh<\/span> Proj mark/);
  assert.strictEqual((html.match(/mark-tip-desc/g) || []).length, 1);
});

const IMPACT = {
  window: 7,
  before: { from: '2026-10-03', to: '2026-10-09', avgTokensPerDay: 1000, avgCostPerDay: 2, costPerSession: 4, cacheHitPct: 90, tokensPerRequest: 300 },
  after: { from: '2026-10-10', to: '2026-10-16', partial: false, avgTokensPerDay: 500, avgCostPerDay: 3, costPerSession: 3, cacheHitPct: 95, tokensPerRequest: null },
  tokensChangePct: -50,
  costChangePct: 50,
  costPerSessionChangePct: -25,
  cacheHitChangePts: 5,
  tokensPerRequestChangePct: null
};

test('impactHtml shows the compared days and colored efficiency changes', () => {
  const html = UsageMarks.impactHtml(IMPACT);
  assert.match(html, /7 days before vs 7 days from the mark/);
  assert.match(html, /Days<\/span><span>Oct 3 \u2013 Oct 9<\/span><span>Oct 10 \u2013 Oct 16<\/span>/);
  assert.match(html, /Cost \/ session<\/span><span>\$4\.00<\/span><span>\$3\.00<\/span><span><span class="mark-delta mark-delta-good">-25%/);
  assert.match(html, /Cache hit<\/span><span>90%<\/span><span>95%<\/span><span><span class="mark-delta mark-delta-good">\+5 pts/);
  assert.match(html, /Tokens \/ request<\/span><span>300<\/span><span>\u2014<\/span><span><span class="mark-delta">n\/a/);
});

test('impactHtml shows volume changes without good/bad color', () => {
  const html = UsageMarks.impactHtml(IMPACT);
  assert.match(html, /Tokens \/ day<\/span><span>1000<\/span><span>500<\/span><span><span class="mark-delta ">-50%/);
  assert.match(html, /Cost \/ day<\/span><span>\$2\.00<\/span><span>\$3\.00<\/span><span><span class="mark-delta ">\+50%/);
});

test('fmtPts treats a higher cache hit as better', () => {
  assert.match(UsageMarks.fmtPts(3.4), /mark-delta-good">\+3 pts/);
  assert.match(UsageMarks.fmtPts(-2.6), /mark-delta-bad">-3 pts/);
  assert.match(UsageMarks.fmtPts(0.2), /mark-delta ">0 pts/);
});

test('fmtRange marks a window that is still running', () => {
  assert.strictEqual(UsageMarks.fmtRange({ from: '2026-10-20', to: '2026-10-22', partial: true }), 'Oct 20 \u2013 Oct 22 (so far)');
  assert.strictEqual(UsageMarks.fmtRange({ from: '2026-12-28', to: '2027-01-03' }), 'Dec 28 \u2013 Jan 3');
});

test('windowHint spells out the days a window compares', () => {
  assert.strictEqual(UsageMarks.windowHint('2026-10-10', 7),
    'Average usage per day on Oct 3 \u2013 Oct 9 (7 days before) vs Oct 10 \u2013 Oct 16 (7 days from this date).');
  assert.match(UsageMarks.windowHint('2026-03-01', 14), /Feb 15 \u2013 Feb 28 \(14 days before\) vs Mar 1 \u2013 Mar 14/);
});

test('tooltipHtml leaves out the impact block when it is unknown', () => {
  const html = UsageMarks.tooltipHtml([{ date: '2026-03-02', title: 'A', description: '', project: null }]);
  assert.ok(!html.includes('mark-tip-impact'));
});

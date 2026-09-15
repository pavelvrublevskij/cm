const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// TerminalSkills lists the project's own skills and custom slash commands above the session
// terminal. Two contracts matter: a clicked entry is TYPED as `/name ` with a trailing space and no
// newline (the user finishes the line), and the click is counted per project so the most used ones
// pin to the top.
const src = fs.readFileSync(path.join(__dirname, '../public/js/terminal-skills.js'), 'utf-8');

const harness = {
  els: {},
  sent: [],
  toasts: [],
  focused: 0,
  connected: true,
  skills: [],
  apiError: null,
  posts: [],
  listeners: { added: 0, removed: 0 },
};

function makeEl(id) {
  return { id, innerHTML: '', value: '', style: {}, focused: 0, focus() { this.focused++; }, contains: () => false };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

const context = vm.createContext({
  document: {
    getElementById: id => el(id),
    addEventListener: () => { harness.listeners.added++; },
    removeEventListener: () => { harness.listeners.removed++; },
  },
  window: {},
  escapeHtml: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'),
  escapeAttr: s => String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
    .split('"').join('&quot;').split("'").join('&#39;'),
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
  TerminalPanel: {
    state: {
      slug: 'C--proj',
      view: {
        isConnected: () => harness.connected,
        send: p => { harness.sent.push(p); return true; },
        focus: () => { harness.focused++; },
      },
    },
  },
  api: async (url, opts) => {
    if (opts && opts.method === 'POST') { harness.posts.push(url); return { ok: true, count: 1 }; }
    if (harness.apiError) throw new Error(harness.apiError);
    return harness.skills;
  },
});
context.window = context;
vm.runInContext(src, context);
const TS = context.TerminalSkills;

function body() { return el('terminal-skills-body').innerHTML; }

beforeEach(() => {
  harness.els = {};
  harness.sent = [];
  harness.toasts = [];
  harness.focused = 0;
  harness.connected = true;
  harness.apiError = null;
  harness.posts = [];
  harness.skills = [
    { name: 'zeta', description: 'Last alphabetically', kind: 'skill', usageCount: 0 },
    { name: 'alpha', description: 'First alphabetically', kind: 'skill', usageCount: 3 },
    { name: 'beta', description: 'Middle', kind: 'command', usageCount: 9 },
  ];
  TS.close();
});

test('open() loads the project palette and pins the most used above the full list', async () => {
  await TS.open();

  assert.strictEqual(TS.isOpen(), true);
  assert.strictEqual(el('terminal-skills-popover').style.display, 'block');

  const html = body();
  assert.ok(html.includes('Most used'), 'most-used section missing');
  assert.ok(html.includes('>All<'), 'full-list section missing');

  // Most used: beta (9) then alpha (3); zeta is unused and only appears in the full list.
  const top = html.slice(html.indexOf('Most used'), html.indexOf('>All<'));
  assert.ok(top.indexOf('/beta') < top.indexOf('/alpha'), 'most used not ordered by count');
  assert.ok(!top.includes('/zeta'), 'unused skill should not be pinned');
  assert.ok(top.includes('9&times;'), 'usage count badge missing');

  const all = html.slice(html.indexOf('>All<'));
  assert.ok(all.indexOf('/alpha') < all.indexOf('/beta'), 'full list not alphabetical');
  assert.ok(all.indexOf('/beta') < all.indexOf('/zeta'), 'full list not alphabetical');
});

test('most used caps at TOP_COUNT', async () => {
  harness.skills = Array.from({ length: 8 }, (_, i) => ({
    name: 'skill-' + i, description: 'd', kind: 'skill', usageCount: i + 1
  }));
  await TS.open();

  const html = body();
  const top = html.slice(html.indexOf('Most used'), html.indexOf('>All<'));
  const pinned = (top.match(/terminal-skills-item/g) || []).length;
  assert.strictEqual(pinned, TS.TOP_COUNT);
  assert.ok(top.includes('/skill-7'), 'highest count missing from most used');
  assert.ok(!top.includes('/skill-0'), 'lowest count should be cut');
});

test('no most-used section until a skill has been clicked', async () => {
  harness.skills = [{ name: 'fresh', description: 'never used', kind: 'skill', usageCount: 0 }];
  await TS.open();

  const html = body();
  assert.ok(!html.includes('Most used'));
  assert.ok(html.includes('/fresh'));
});

test('a project with nothing to offer renders an empty note', async () => {
  harness.skills = [];
  await TS.open();
  assert.ok(body().includes('No project skills or commands'));
});

test('commands are listed beside skills and labelled by kind', async () => {
  await TS.open();

  const all = body().slice(body().indexOf('>All<'));
  const betaRow = all.slice(all.indexOf('/beta'));
  const alphaRow = all.slice(all.indexOf('/alpha'), all.indexOf('/beta'));
  assert.ok(betaRow.includes('command'), 'command not labelled');
  assert.ok(alphaRow.includes('skill'), 'skill not labelled');
});

test('a namespaced command types its full /ns:name', async () => {
  harness.skills = [{ name: 'git:commit', description: 'nested command', kind: 'command', usageCount: 0 }];
  await TS.open();
  TS.use('git:commit');

  assert.strictEqual(harness.sent[0].d, '/git:commit ');
});

test('a failed load is reported in the popover', async () => {
  harness.apiError = 'boom';
  await TS.open();
  assert.ok(el('terminal-skills-popover').innerHTML.includes('boom'));
});

test('filter matches name or description and reports no matches', async () => {
  await TS.open();

  TS.setFilter('zet');
  assert.ok(body().includes('/zeta'));
  assert.ok(!body().includes('/alpha'));

  TS.setFilter('Middle');
  assert.ok(body().includes('/beta'));
  assert.ok(!body().includes('/zeta'));

  TS.setFilter('nothing-matches-this');
  assert.ok(body().includes('Nothing matches'));
});

test('clicking a skill types /name with a trailing space and no newline', async () => {
  await TS.open();
  TS.use('alpha');

  assert.strictEqual(harness.sent.length, 1);
  assert.strictEqual(harness.sent[0].t, 'i');
  assert.strictEqual(harness.sent[0].d, '/alpha ');
  assert.ok(!harness.sent[0].d.includes('\r'), 'must not submit the line');
  assert.ok(!harness.sent[0].d.includes('\n'), 'must not submit the line');
  assert.strictEqual(harness.focused, 1);
  assert.strictEqual(TS.isOpen(), false, 'popover should close after a pick');
});

test('clicking a skill counts the use for this project', async () => {
  await TS.open();
  TS.use('alpha');
  await new Promise(r => setImmediate(r));

  assert.strictEqual(harness.posts.length, 1);
  assert.strictEqual(harness.posts[0], '/api/skills/usage/C--proj/alpha');
  assert.strictEqual(harness.skills.find(s => s.name === 'alpha').usageCount, 4, 'local count not bumped');
});

test('nothing is typed when the terminal is not connected', async () => {
  await TS.open();
  harness.connected = false;
  TS.use('alpha');

  assert.strictEqual(harness.sent.length, 0);
  assert.strictEqual(harness.posts.length, 0);
  assert.strictEqual(harness.toasts[0].type, 'error');
});

test('useFrom reads the skill name off the clicked button', async () => {
  await TS.open();
  TS.useFrom({ getAttribute: () => 'beta' });
  assert.strictEqual(harness.sent.length, 1);
  assert.strictEqual(harness.sent[0].d, '/beta ');
});

test('close() clears the popover and drops its document listeners', async () => {
  await TS.open();
  const added = harness.listeners.added;
  TS.close();

  assert.strictEqual(TS.isOpen(), false);
  assert.strictEqual(el('terminal-skills-popover').style.display, 'none');
  assert.strictEqual(el('terminal-skills-popover').innerHTML, '');
  assert.strictEqual(harness.listeners.removed, added, 'listeners left bound');
});

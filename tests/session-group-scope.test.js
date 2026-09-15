const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Sessions.renderCard under group scope: once a project's list folds in its siblings' sessions,
// every card has to name the project it belongs to — badging only the foreign ones would leave the
// unbadged majority ambiguous — and a foreign card has to open against its own project rather than
// the one currently being viewed.

const utilsSrc = fs.readFileSync(path.join(__dirname, '../public/js/utils.js'), 'utf-8');
const sessionsSrc = fs.readFileSync(path.join(__dirname, '../public/js/sessions.js'), 'utf-8');

const HUB = 'C--work-workspace-demo';
const SERVICE = 'C--work-standalone-service';

let Sessions;

function load() {
  const sandbox = {
    document: {
      createElement: () => {
        const el = { _text: '' };
        Object.defineProperty(el, 'textContent', { set(v) { this._text = v; }, get() { return this._text; } });
        Object.defineProperty(el, 'innerHTML', {
          get() { return String(this._text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        });
        return el;
      },
      documentElement: { setAttribute: () => {} },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    window: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(utilsSrc, sandbox);
  vm.runInContext(sessionsSrc + '\nglobalThis._Sessions = Sessions;', sandbox);

  // Stand in for the Projects module the sidebar populates, so _group/_projectLabel resolve.
  sandbox.Projects = {
    data: [
      { slug: HUB, groupId: 'auto:abc', groupLabel: 'workspace-demo', groupRelPath: null, path: 'C:\\work\\workspace-demo' },
      { slug: SERVICE, groupId: 'auto:abc', groupLabel: 'workspace-demo', groupRelPath: 'linked-repos/independent-service', path: 'C:\\work\\standalone-service' }
    ],
    _memberLabel(p) {
      if (p.groupRelPath) return p.groupRelPath;
      return p.path.split(/[\\/]/).filter(Boolean).pop();
    }
  };
  return sandbox._Sessions;
}

function badges(html) {
  return [...html.matchAll(/<span class="project-badge">([^<]*)<\/span>/g)].map(m => m[1]);
}

function cardOnclick(html) {
  const m = html.match(/<div class="session-card"[^>]*onclick="([^"]*)"/);
  return m ? m[1] : '';
}

beforeEach(() => {
  Sessions = load();
  Sessions.cache = {};
  Sessions._showArchived = false;
  Sessions._planSessionIds = null;
  Sessions._searchResults = {};
});

test('no project badge when group scope is off', () => {
  Sessions._groupScope = false;
  const html = Sessions.renderCard(HUB, { slug: HUB, sessionId: 's1', summary: 'Local work' }, 0);
  assert.deepStrictEqual(badges(html), []);
});

test('group scope badges the current project\'s own sessions too, not just foreign ones', () => {
  Sessions._groupScope = true;
  const html = Sessions.renderCard(HUB, { slug: HUB, sessionId: 's1', summary: 'Local work' }, 0);
  assert.deepStrictEqual(badges(html), ['workspace-demo']);
});

test('a foreign session is badged with its path inside the group, not its bare folder name', () => {
  Sessions._groupScope = true;
  const html = Sessions.renderCard(HUB, { slug: SERVICE, sessionId: 's2', summary: 'Service work' }, 0);
  assert.deepStrictEqual(badges(html), ['linked-repos/independent-service']);
});

test('a foreign session opens against its own project', () => {
  Sessions._groupScope = true;
  const html = Sessions.renderCard(HUB, { slug: SERVICE, sessionId: 's2', summary: 'Service work' }, 0);
  assert.strictEqual(cardOnclick(html), `Sessions.openGroupedSession('${SERVICE}', 's2')`);
});

test('a session of the viewed project still opens through the cached list index', () => {
  Sessions._groupScope = true;
  Sessions.cache[HUB] = [{ slug: HUB, sessionId: 'other' }, { slug: HUB, sessionId: 's1' }];
  const html = Sessions.renderCard(HUB, { slug: HUB, sessionId: 's1', summary: 'Local work' }, 0);
  assert.strictEqual(cardOnclick(html), `Sessions.open('${HUB}', 's1', 1)`);
});

test('_findSession locates a foreign session inside the viewed project\'s group-scoped cache', () => {
  const foreign = { slug: SERVICE, sessionId: 's2', summary: 'Service work' };
  Sessions.cache[HUB] = [{ slug: HUB, sessionId: 's1' }, foreign];
  assert.strictEqual(Sessions._findSession(SERVICE, 's2'), foreign);
  assert.strictEqual(Sessions._findSession(HUB, 's2'), undefined,
    'a session is only matched under the project it actually belongs to');
});

// renderGroup used to build its cards with renderSessionCard directly instead of going through
// renderCard, which silently dropped the project badge and the cross-project onclick for every
// session that landed inside a ticket/branch/temporal group — i.e. most of them.

function groupHtml(viewedSlug, sessions) {
  return Sessions.renderGroup(viewedSlug, { key: 'k', label: 'grp', type: 'branch', sessions }, new Set(), 0);
}

test('sessions inside a ticket/branch group are badged with their project too', () => {
  Sessions._groupScope = true;
  const html = groupHtml(HUB, [
    { slug: HUB, sessionId: 's1', summary: 'Local', created: '2026-01-01T10:00:00Z', modified: '2026-01-01T10:05:00Z' },
    { slug: SERVICE, sessionId: 's2', summary: 'Service', created: '2026-01-01T11:00:00Z', modified: '2026-01-01T11:05:00Z' }
  ]);
  assert.deepStrictEqual(badges(html).sort(), ['linked-repos/independent-service', 'workspace-demo']);
});

test('a foreign session inside a group opens against its own project, not the viewed one', () => {
  Sessions._groupScope = true;
  const html = groupHtml(HUB, [
    { slug: HUB, sessionId: 's1', summary: 'Local', created: '2026-01-01T10:00:00Z', modified: '2026-01-01T10:05:00Z' },
    { slug: SERVICE, sessionId: 's2', summary: 'Service', created: '2026-01-01T11:00:00Z', modified: '2026-01-01T11:05:00Z' }
  ]);
  assert.ok(html.includes(`Sessions.openGroupedSession('${SERVICE}', 's2')`),
    'the foreign card must not open against the viewed project');
  assert.ok(!html.includes(`Sessions.open('${HUB}', 's2'`),
    'the foreign session must never be opened as if it belonged to the viewed project');
});

test('with group scope off, grouped cards carry no badge and open normally', () => {
  Sessions._groupScope = false;
  Sessions.cache[HUB] = [{ slug: HUB, sessionId: 's1' }];
  const html = groupHtml(HUB, [
    { slug: HUB, sessionId: 's1', summary: 'One', created: '2026-01-01T10:00:00Z', modified: '2026-01-01T10:05:00Z' },
    { slug: HUB, sessionId: 's3', summary: 'Two', created: '2026-01-01T11:00:00Z', modified: '2026-01-01T11:05:00Z' }
  ]);
  assert.deepStrictEqual(badges(html), []);
  assert.ok(html.includes(`Sessions.open('${HUB}', 's1', 0)`));
});

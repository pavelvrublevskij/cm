const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Sidebar session rows are inserted under their project's nav item, which — once projects are
// grouped — sits at its own depth in the tree. The rows have to take their indent from that depth
// or a nested project's sessions render further left than the project they belong to.
//
// The indent travels as a --tree-indent custom property rather than an inline padding, so the
// collapsed-sidebar rule's padding shorthand can still flatten it; an inline padding would win over
// the stylesheet and leave icons indented while collapsed.

const src = fs.readFileSync(path.join(__dirname, '../public/js/active-sessions-bar.js'), 'utf-8');

function makeEl(treeIndent) {
  const el = {
    className: '',
    title: '',
    innerHTML: '',
    dataset: {},
    children: [],
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = value; },
      getPropertyValue(name) { return this._props[name] || ''; }
    },
    classList: { add() {}, remove() {}, contains: () => false, toggle: () => false },
    appendChild(child) { el.children.push(child); },
    addEventListener() {},
    remove() {},
    setAttribute() {},
    querySelectorAll: () => [],
    insertAdjacentElement(_pos, node) { inserted.push(node); return node; }
  };
  if (treeIndent !== undefined) el.style._props['--tree-indent'] = treeIndent;
  return el;
}

let inserted = [];
let navItems = {};
let context;

function loadBar() {
  inserted = [];
  context = vm.createContext({
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: sel => {
        const m = sel.match(/data-slug="([^"]+)"/);
        return m ? (navItems[m[1]] || null) : null;
      },
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      body: { appendChild() {} }
    },
    window: { innerWidth: 1200, innerHeight: 800 },
    getComputedStyle: el => el.style,
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 0,
    escapeHtml: s => String(s == null ? '' : s),
    decodeName: s => s,
    api: async () => [],
    // Defined in utils.js, which the real page loads before this module.
    TREE_INDENT_ROOT: 20,
    TREE_INDENT_STEP: 14,
    console
  });
  // `const ActiveSessionsBar = ...` is a lexical binding, not a property of the context's global —
  // hand it out explicitly, the same way tests/active-sessions-bar.test.js does.
  vm.runInContext(src + '\nglobalThis._ActiveSessionsBar = ActiveSessionsBar;', context);
  return context._ActiveSessionsBar;
}

beforeEach(() => {
  navItems = {};
});

test('session rows indent one level deeper than the project nav item they hang off', () => {
  const bar = loadBar();
  // A project nested two levels into a group tree: 28 + 2 * 14.
  navItems['nested-proj'] = makeEl('56px');
  bar._sessions = [{ slug: 'nested-proj', sessionId: 's1', title: 'Session One', kind: 'os' }];
  bar._renderSidebar();

  const sessionRow = inserted.find(el => !el.className.includes('--new'));
  assert.ok(sessionRow, 'a session row should be inserted');
  assert.strictEqual(sessionRow.style.getPropertyValue('--tree-indent'), '70px');
});

test('an ungrouped project with no --tree-indent keeps the flat 32px session indent', () => {
  const bar = loadBar();
  navItems['flat-proj'] = makeEl();   // no custom property set, as ungrouped rows have none
  bar._sessions = [{ slug: 'flat-proj', sessionId: 's1', title: 'Session One', kind: 'os' }];
  bar._renderSidebar();

  const sessionRow = inserted.find(el => !el.className.includes('--new'));
  assert.strictEqual(sessionRow.style.getPropertyValue('--tree-indent'), '34px',
    'falls back to the base 20px project padding plus one step');
});

test('the "New session" row lines up with the session rows above it', () => {
  const bar = loadBar();
  navItems['nested-proj'] = makeEl('42px');
  bar._sessions = [{ slug: 'nested-proj', sessionId: 's1', title: 'Session One', kind: 'os' }];
  bar._renderSidebar();

  const newRow = inserted.find(el => el.className.includes('--new'));
  assert.ok(newRow, 'the new-session row should be inserted');
  assert.strictEqual(newRow.style.getPropertyValue('--tree-indent'), '56px');
});

test('indent is carried as a custom property, never as an inline padding', () => {
  const bar = loadBar();
  navItems['nested-proj'] = makeEl('56px');
  bar._sessions = [{ slug: 'nested-proj', sessionId: 's1', title: 'Session One', kind: 'os' }];
  bar._renderSidebar();

  for (const row of inserted) {
    assert.strictEqual(row.style.paddingLeft, undefined,
      'an inline padding would override the collapsed-sidebar rule and break the collapsed layout');
  }
});

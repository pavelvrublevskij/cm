const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Every theme in Theme.themes has a stylesheet defining the full variable set, and the footer offers
// a dropdown listing all of them instead of a button that cycles through them.
const PUBLIC = path.join(__dirname, '../public');
const utilsSrc = fs.readFileSync(path.join(PUBLIC, 'js/utils.js'), 'utf-8');
const themeSrc = utilsSrc.slice(utilsSrc.indexOf('const Theme = {'), utilsSrc.indexOf('// Apply theme immediately'));

function makeEl() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', title: '', href: '',
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
    },
  };
}

function loadTheme(openPanels = []) {
  const els = {};
  const store = {};
  const attrs = {};
  const ctx = {
    document: {
      getElementById: id => (els[id] ||= makeEl()),
      documentElement: { getAttribute: k => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } },
      addEventListener: () => {},
      querySelectorAll: sel => (sel === '.action-menu-panel.open' ? openPanels : []),
    },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  };
  vm.runInNewContext(themeSrc + '\nthis.Theme = Theme;', ctx);
  return { Theme: ctx.Theme, els, store, attrs };
}

const varsOf = css => [...css.matchAll(/--([\w-]+):/g)].map(m => m[1]).sort();

test('there are 12 themes, each with a label and an icon', () => {
  const { Theme } = loadTheme();
  assert.strictEqual(Theme.themes.length, 12);
  for (const t of ['nord', 'gruvbox', 'catppuccin', 'tokyo-night', 'solarized-light']) {
    assert.ok(Theme.themes.includes(t), t);
  }
  for (const t of Theme.themes) {
    assert.ok(Theme.labels[t], `label for ${t}`);
    assert.ok(Theme.icons[t], `icon for ${t}`);
  }
});

test('each theme stylesheet defines every variable dark.css defines', () => {
  const { Theme } = loadTheme();
  const expected = varsOf(fs.readFileSync(path.join(PUBLIC, 'css/themes/dark.css'), 'utf-8'));
  for (const t of Theme.themes) {
    const css = fs.readFileSync(path.join(PUBLIC, `css/themes/${t}.css`), 'utf-8');
    assert.ok(css.includes(`[data-theme="${t}"]`), `${t} selector`);
    assert.deepStrictEqual(varsOf(css), expected, `${t} variables`);
  }
});

test('opening the menu lists all themes and marks the current one', () => {
  const { Theme, els } = loadTheme();
  Theme.apply('nord');
  Theme.toggleMenu({ stopPropagation() {} });
  const html = els['theme-menu'].innerHTML;
  assert.ok(els['theme-menu'].classList.contains('open'));
  assert.strictEqual((html.match(/action-menu-item/g) || []).length, 12);
  assert.match(html, /action-menu-item active" onclick="Theme.select\('nord'\)"/);
  Theme.toggleMenu({ stopPropagation() {} });
  assert.ok(!els['theme-menu'].classList.contains('open'));
});

test('selecting a theme applies it, saves it and closes the menu', () => {
  const { Theme, els, store, attrs } = loadTheme();
  Theme.toggleMenu({ stopPropagation() {} });
  Theme.select('tokyo-night');
  assert.strictEqual(attrs['data-theme'], 'tokyo-night');
  assert.strictEqual(store['claude-manager-theme'], 'tokyo-night');
  assert.strictEqual(els['theme-stylesheet'].href, '/css/themes/tokyo-night.css');
  assert.strictEqual(els['theme-label'].textContent, 'Tokyo Night');
  assert.ok(!els['theme-menu'].classList.contains('open'));
});

test('footers use the theme dropdown, not the cycling button', () => {
  for (const f of ['index.html', 'git-window.html']) {
    const html = fs.readFileSync(path.join(PUBLIC, f), 'utf-8');
    assert.ok(html.includes('onclick="Theme.toggleMenu(event)"'), f);
    assert.ok(html.includes('id="theme-menu"'), f);
    assert.ok(!html.includes('Theme.toggle()'), f);
  }
});

test('opening the theme menu closes other open action menus', () => {
  const other = makeEl();
  other.classList.add('open');
  const { Theme } = loadTheme([other]);
  Theme.toggleMenu({ stopPropagation() {} });
  assert.ok(!other.classList.contains('open'));
});

test('theme menu upward positioning outranks the generic .action-menu-panel top rule', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'css/style.css'), 'utf-8');
  assert.match(css, /\.action-menu-panel\.theme-menu-panel\s*\{[^}]*top:\s*auto;[^}]*bottom:/);
});

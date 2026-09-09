const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// renderSessionCard is a pure string-builder off utils.js — give it a document stub whose
// createElement() mimics real textContent -> innerHTML escaping closely enough for assertions.
const src = fs.readFileSync(path.join(__dirname, '../public/js/utils.js'), 'utf-8');
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
    getElementById: () => null
  },
  window: {},
  localStorage: { getItem: () => null, setItem: () => {} }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { renderSessionCard } = sandbox;

function dotClasses(html) {
  return [...html.matchAll(/session-active-dot--(\w+)/g)].map(m => m[1]);
}

test('renderSessionCard: no dot when inactive', () => {
  const html = renderSessionCard({ sessionId: 's1', active: false });
  assert.deepStrictEqual(dotClasses(html), []);
});

test('renderSessionCard: falls back to a single activeKind dot when activeKinds is absent (legacy shape)', () => {
  const html = renderSessionCard({ sessionId: 's1', active: true, activeKind: 'browser' });
  assert.deepStrictEqual(dotClasses(html), ['browser']);
});

test('renderSessionCard: renders one dot per entry in activeKinds', () => {
  const html = renderSessionCard({ sessionId: 's1', active: true, activeKind: 'os', activeKinds: ['os', 'readonly'] });
  assert.deepStrictEqual(dotClasses(html), ['os', 'readonly']);
});

test('renderSessionCard: renders a single readonly-only dot', () => {
  const html = renderSessionCard({ sessionId: 's1', active: true, activeKind: 'readonly', activeKinds: ['readonly'] });
  assert.deepStrictEqual(dotClasses(html), ['readonly']);
});

test('renderSessionCard: empty activeKinds array renders no dot even if active is stale-true', () => {
  const html = renderSessionCard({ sessionId: 's1', active: true, activeKinds: [] });
  assert.deepStrictEqual(dotClasses(html), []);
});

function cardCount(html) {
  return (html.match(/class="session-card"/g) || []).length;
}

function onclicks(html) {
  return [...html.matchAll(/<div class="session-card"[^>]*onclick="([^"]*)"/g)].map(m => m[1]);
}

// ── splitting a session active in two ways into two separately-clickable cards ─────────────────

test('renderSessionCard: os+readonly renders two separate cards, not one merged card', () => {
  const html = renderSessionCard(
    { sessionId: 's1', active: true, activeKind: 'os', activeKinds: ['os', 'readonly'] },
    { slug: 'proj', onclick: "Sessions.open('proj', 's1', 0)" }
  );
  assert.strictEqual(cardCount(html), 2);
});

test('renderSessionCard: the real-kind card keeps the caller-supplied onclick', () => {
  const html = renderSessionCard(
    { sessionId: 's1', active: true, activeKind: 'os', activeKinds: ['os', 'readonly'] },
    { slug: 'proj', onclick: "Sessions.open('proj', 's1', 0)" }
  );
  assert.deepStrictEqual(onclicks(html), ["Sessions.open('proj', 's1', 0)", "Sessions.openReadOnly('proj', 's1')"]);
});

test('renderSessionCard: a readonly-only card always opens read-only, overriding the caller onclick', () => {
  const html = renderSessionCard(
    { sessionId: 's1', active: true, activeKind: 'readonly', activeKinds: ['readonly'] },
    { slug: 'proj', onclick: "App.navigate('session-detail', { slug: 'proj', sessionId: 's1' })" }
  );
  assert.deepStrictEqual(onclicks(html), ["Sessions.openReadOnly('proj', 's1')"]);
});

test('renderSessionCard: an os-only card keeps the caller onclick unchanged', () => {
  const html = renderSessionCard(
    { sessionId: 's1', active: true, activeKind: 'os', activeKinds: ['os'] },
    { slug: 'proj', onclick: "Sessions.open('proj', 's1', 0)" }
  );
  assert.deepStrictEqual(onclicks(html), ["Sessions.open('proj', 's1', 0)"]);
});

test('renderSessionCard: browser+readonly split falls back to s.slug when opts.slug is absent', () => {
  const html = renderSessionCard(
    { sessionId: 's1', slug: 'proj-from-s', active: true, activeKind: 'browser', activeKinds: ['browser', 'readonly'] },
    { onclick: "App.navigate('session-detail', { slug: 'proj-from-s', sessionId: 's1' })" }
  );
  assert.deepStrictEqual(onclicks(html), [
    "App.navigate('session-detail', { slug: 'proj-from-s', sessionId: 's1' })",
    "Sessions.openReadOnly('proj-from-s', 's1')"
  ]);
});

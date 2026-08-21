const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// renderMarkdown and its helpers are pure string transforms — no DOM needed to exercise them,
// but utils.js defines a few unrelated helpers that touch `document`, so the sandbox gets a
// harmless stub rather than nothing.
const src = fs.readFileSync(path.join(__dirname, '../public/js/utils.js'), 'utf-8');
const sandbox = {
  document: { createElement: () => ({}), documentElement: { setAttribute: () => {} }, getElementById: () => null },
  window: {},
  localStorage: { getItem: () => null, setItem: () => {} }
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { stripFrontmatter, slugifyHeading, addHeadingIds, renderMarkdown } = sandbox;

// ── stripFrontmatter ─────────────────────────────────────────────────────────

test('stripFrontmatter drops a leading YAML block', () => {
  const text = '---\ntitle: Test\n---\n\n# Heading\n\nbody';
  assert.strictEqual(stripFrontmatter(text), '\n# Heading\n\nbody');
});

test('stripFrontmatter leaves text with no frontmatter untouched', () => {
  const text = '# Heading\n\nbody with a --- horizontal rule below\n\n---\nmore text';
  assert.strictEqual(stripFrontmatter(text), text);
});

test('stripFrontmatter requires the closing marker on its own line right after the opening one', () => {
  const text = '---\nnot closed properly\n\n# Heading';
  assert.strictEqual(stripFrontmatter(text), text);
});

test('stripFrontmatter handles CRLF line endings', () => {
  const text = '---\r\ntitle: Test\r\n---\r\nbody';
  assert.strictEqual(stripFrontmatter(text), 'body');
});

// ── slugifyHeading ───────────────────────────────────────────────────────────

test('slugifyHeading lowercases, spaces to hyphens, strips punctuation', () => {
  assert.strictEqual(slugifyHeading('Getting Started!'), 'getting-started');
  assert.strictEqual(slugifyHeading('  Trim Me  '), 'trim-me');
  assert.strictEqual(slugifyHeading('API (v2) Reference'), 'api-v2-reference');
});

// ── addHeadingIds ────────────────────────────────────────────────────────────

test('addHeadingIds assigns a GitHub-style slug id to each heading', () => {
  const html = '<h1>My Title</h1><p>text</p><h2>Getting Started</h2>';
  const out = addHeadingIds(html);
  assert.match(out, /<h1 id="my-title">My Title<\/h1>/);
  assert.match(out, /<h2 id="getting-started">Getting Started<\/h2>/);
});

test('addHeadingIds strips inline markup before slugifying but keeps it in the heading body', () => {
  const html = '<h2><code>npm install</code> steps</h2>';
  const out = addHeadingIds(html);
  assert.match(out, /<h2 id="npm-install-steps"><code>npm install<\/code> steps<\/h2>/);
});

test('addHeadingIds dedupes repeated headings', () => {
  const html = '<h2>Notes</h2><h2>Notes</h2><h2>Notes</h2>';
  const out = addHeadingIds(html);
  assert.deepStrictEqual([...out.matchAll(/id="([^"]+)"/g)].map(m => m[1]), ['notes', 'notes-1', 'notes-2']);
});

// ── renderMarkdown ───────────────────────────────────────────────────────────

test('renderMarkdown strips frontmatter even without the marked library available', () => {
  const out = renderMarkdown('---\nx: 1\n---\nhello');
  assert.ok(!out.includes('x: 1'), 'frontmatter must not leak into the rendered output');
  assert.match(out, /hello/);
});

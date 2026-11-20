const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/tab-badge.js'), 'utf-8');

function setup() {
  const link = { href: '/favicon.svg' };
  const images = [];
  class Image { constructor() { images.push(this); } }
  const canvas = {
    getContext: () => ({ drawImage() {}, beginPath() {}, arc() {}, fill() {} }),
    toDataURL: () => 'data:image/png;base64,DOT'
  };
  const document = { title: 'CM', querySelector: () => link, createElement: () => canvas };
  const sandbox = { document, Image, Math };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis._TabBadge = TabBadge;', sandbox);
  return { TabBadge: sandbox._TabBadge, document, link, images };
}

test('waiting items show their count in the title and a dot on the favicon', () => {
  const { TabBadge, document, link, images } = setup();
  TabBadge.set(3);
  assert.strictEqual(document.title, '(3) CM');
  assert.strictEqual(images.length, 1);
  images[0].onload();
  assert.strictEqual(link.href, 'data:image/png;base64,DOT');
});

test('with nothing waiting the title and favicon go back to normal', () => {
  const { TabBadge, document, link, images } = setup();
  TabBadge.set(2);
  images[0].onload();
  TabBadge.set(0);
  assert.strictEqual(document.title, 'CM');
  assert.strictEqual(link.href, '/favicon.svg');
});

test('the dot icon is drawn once and reused', () => {
  const { TabBadge, link, images } = setup();
  TabBadge.set(1);
  images[0].onload();
  TabBadge.set(0);
  TabBadge.set(4);
  assert.strictEqual(images.length, 1);
  assert.strictEqual(link.href, 'data:image/png;base64,DOT');
});

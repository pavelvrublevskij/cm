const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// TermView is the xterm.js + WebSocket lifecycle shared by the session terminal and the git panel's
// shell. Both used to carry their own copy; these tests pin the behaviour they now both depend on.
const src = fs.readFileSync(path.join(__dirname, '../public/js/term-view.js'), 'utf-8');

const harness = {
  els: {},
  sent: [],
  toasts: [],
  statuses: [],
  opens: 0,
  wsUrls: [],
  wsClosed: 0,
  termDisposed: 0,
  fitted: 0,
  observed: [],
  ws: null,
  term: null,
  readyState: 1,
  hasXterm: true,
  timers: [],
};

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
}

function el(id) {
  if (!harness.els[id]) harness.els[id] = makeEl(id);
  return harness.els[id];
}

function FakeTerminal(opts) {
  this.opts = opts;
  this.cols = 80;
  this.rows = 24;
  this.written = [];
  this.keyHandler = null;
  this.dataHandler = null;
  harness.term = this;
}
FakeTerminal.prototype.loadAddon = function () {};
FakeTerminal.prototype.open = function (host) { this.host = host; };
FakeTerminal.prototype.write = function (d) { this.written.push(d); };
FakeTerminal.prototype.focus = function () { this.focused = true; };
FakeTerminal.prototype.onData = function (fn) {
  this.dataHandler = fn;
  const self = this;
  return { dispose() { self.dataDisposed = true; } };
};
FakeTerminal.prototype.attachCustomKeyEventHandler = function (fn) { this.keyHandler = fn; };
FakeTerminal.prototype.hasSelection = function () { return false; };
FakeTerminal.prototype.dispose = function () { harness.termDisposed++; };

function FakeFit() {}
FakeFit.prototype.fit = function () { harness.fitted++; };

function FakeWebSocket(url) {
  this.url = url;
  this.readyState = harness.readyState;
  harness.wsUrls.push(url);
  harness.ws = this;
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.prototype.send = function (p) { harness.sent.push(JSON.parse(p)); };
FakeWebSocket.prototype.close = function () { harness.wsClosed++; };

const context = vm.createContext({
  document: { getElementById: id => (id in harness.els || id === 'host' ? el(id) : null) },
  get window() {
    return harness.hasXterm
      ? { Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit } }
      : {};
  },
  WebSocket: FakeWebSocket,
  ResizeObserver: function (cb) {
    this.cb = cb;
    this.observe = target => { harness.observed.push(target.id); };
    this.disconnect = () => { harness.roDisconnected = true; };
  },
  setTimeout: fn => { harness.timers.push(fn); fn(); },
  navigator: { clipboard: { writeText: async () => {} } },
  toast: (msg, type) => { harness.toasts.push({ msg, type }); },
});
vm.runInContext(src + '\nglobalThis._TermView = TermView;', context);
const TermView = context._TermView;

function create(extra) {
  return TermView.create(Object.assign({
    hostId: 'host',
    url: 'ws://127.0.0.1:3000/api/projects/proj/terminal?mode=shell',
    onStatus: (text, cls) => harness.statuses.push({ text, cls }),
    onOpen: () => { harness.opens++; },
  }, extra || {}));
}

beforeEach(() => {
  harness.els = {};
  harness.sent = [];
  harness.toasts = [];
  harness.statuses = [];
  harness.opens = 0;
  harness.wsUrls = [];
  harness.wsClosed = 0;
  harness.termDisposed = 0;
  harness.fitted = 0;
  harness.observed = [];
  harness.roDisconnected = false;
  harness.ws = null;
  harness.term = null;
  harness.readyState = 1;
  harness.hasXterm = true;
  harness.timers = [];
});

// ── availability ─────────────────────────────────────────────────────────────

test('librariesLoaded reports whether the xterm CDN arrived', () => {
  assert.strictEqual(TermView.librariesLoaded(), true);
  harness.hasXterm = false;
  assert.strictEqual(TermView.librariesLoaded(), false);
});

test('create returns null instead of throwing when the libraries are missing', () => {
  harness.hasXterm = false;
  assert.strictEqual(create(), null);
});

test('create returns null when the host element is absent', () => {
  assert.strictEqual(create({ hostId: 'no-such-host' }), null);
});

// ── connect ──────────────────────────────────────────────────────────────────

test('create mounts a terminal, connects, and observes the host for resizes', () => {
  const view = create();

  assert.ok(view, 'a view is returned');
  assert.deepStrictEqual(harness.wsUrls, ['ws://127.0.0.1:3000/api/projects/proj/terminal?mode=shell']);
  assert.strictEqual(harness.term.host, el('host'));
  assert.deepStrictEqual(harness.observed, ['host']);
});

test('the host is emptied before mounting, so remounting cannot stack terminals', () => {
  el('host').innerHTML = 'STALE';
  create();
  assert.strictEqual(el('host').innerHTML, '');
});

test('status goes connecting then connected, and onOpen fires once', () => {
  const view = create();
  assert.deepStrictEqual(harness.statuses, [{ text: 'connecting...', cls: '' }]);

  harness.ws.onopen();
  assert.deepStrictEqual(harness.statuses[1], { text: 'connected', cls: 'connected' });
  assert.strictEqual(harness.opens, 1);
});

test('opening the socket reports the terminal size to the pty', () => {
  create();
  harness.ws.onopen();
  assert.deepStrictEqual(harness.sent, [{ t: 'r', c: 80, r: 24 }]);
});

test('a close and an error are reflected in the status', () => {
  create();
  harness.ws.onclose();
  assert.deepStrictEqual(harness.statuses.pop(), { text: 'disconnected', cls: 'error' });
  harness.ws.onerror();
  assert.deepStrictEqual(harness.statuses.pop(), { text: 'error', cls: 'error' });
});

test('a WebSocket that cannot be constructed is reported, not thrown', () => {
  const original = context.WebSocket;
  context.WebSocket = function () { throw new Error('refused'); };
  context.WebSocket.OPEN = 1;
  try {
    const view = create();
    assert.ok(view, 'the view still exists');
    assert.deepStrictEqual(harness.statuses.pop(), { text: 'connection failed', cls: 'error' });
    assert.match(harness.term.written.join(''), /refused/);
  } finally {
    context.WebSocket = original;
  }
});

// ── data flow ────────────────────────────────────────────────────────────────

test('typing in the terminal is forwarded to the pty', () => {
  create();
  harness.term.dataHandler('ls\r');
  assert.deepStrictEqual(harness.sent, [{ t: 'i', d: 'ls\r' }]);
});

test('pty output is written to the terminal, non-string frames ignored', () => {
  create();
  harness.ws.onmessage({ data: 'hello' });
  harness.ws.onmessage({ data: { not: 'a string' } });
  assert.deepStrictEqual(harness.term.written, ['hello', '']);
});

test('send is a no-op on a closed socket rather than an error', () => {
  const view = create();
  harness.ws.readyState = 3;
  assert.strictEqual(view.send({ t: 'i', d: 'x' }), false);
  assert.deepStrictEqual(harness.sent, []);
});

test('isConnected tracks the socket state', () => {
  const view = create();
  assert.strictEqual(view.isConnected(), true);
  harness.ws.readyState = 3;
  assert.strictEqual(view.isConnected(), false);
});

test('resize refits and reports, but only while connected', () => {
  const view = create();
  harness.fitted = 0;
  harness.sent.length = 0;
  view.resize();
  assert.strictEqual(harness.fitted, 1);
  assert.deepStrictEqual(harness.sent, [{ t: 'r', c: 80, r: 24 }]);

  harness.ws.readyState = 3;
  harness.sent.length = 0;
  view.resize();
  assert.deepStrictEqual(harness.sent, [], 'nothing is sent to a dead socket');
});

// ── keyboard ─────────────────────────────────────────────────────────────────

test('ctrl+v is left to the browser so paste works', () => {
  create();
  assert.strictEqual(harness.term.keyHandler({ type: 'keydown', ctrlKey: true, key: 'v' }), false);
});

test('ctrl+c with no selection passes through to the pty as an interrupt', () => {
  create();
  assert.strictEqual(harness.term.keyHandler({ type: 'keydown', ctrlKey: true, key: 'c' }), true);
});

test('other keys and modified combinations are not intercepted', () => {
  create();
  assert.strictEqual(harness.term.keyHandler({ type: 'keydown', ctrlKey: false, key: 'a' }), true);
  assert.strictEqual(harness.term.keyHandler({ type: 'keyup', ctrlKey: true, key: 'v' }), true);
  assert.strictEqual(harness.term.keyHandler({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'v' }), true);
});

// ── reconnect and dispose ────────────────────────────────────────────────────

test('reconnect keeps the terminal, replaces the socket and shows a banner', () => {
  const view = create();
  const term = view.term;
  view.reconnect('[restarting]');

  assert.strictEqual(view.term, term);
  assert.strictEqual(harness.wsClosed, 1);
  assert.strictEqual(harness.wsUrls.length, 2);
  assert.match(term.written.join(''), /\[restarting\]/);
  assert.strictEqual(harness.termDisposed, 0, 'the terminal is not thrown away');
});

test('reconnect without a banner writes nothing extra', () => {
  const view = create();
  view.reconnect();
  assert.deepStrictEqual(harness.term.written, []);
});

test('dispose tears down observer, data handler, socket and terminal', () => {
  const view = create();
  view.dispose();

  assert.strictEqual(harness.roDisconnected, true);
  assert.strictEqual(harness.term.dataDisposed, true);
  assert.strictEqual(harness.wsClosed, 1);
  assert.strictEqual(harness.termDisposed, 1);
});

test('dispose is safe to call twice', () => {
  const view = create();
  view.dispose();
  view.dispose();
  assert.strictEqual(harness.wsClosed, 1, 'the socket is only closed once');
});

test('dispose never sends a close message — ending the pty is the caller\'s decision', () => {
  const view = create();
  harness.sent.length = 0;
  view.dispose();
  assert.deepStrictEqual(harness.sent, []);
});

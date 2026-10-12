'use strict';

// The frame client (src/services/plugins/frame.js) reports the frame height to
// the parent (gc-resize): the document's own height, so the frame can shrink
// again, and an open fixed dialog of the plugin with its full height, so it is
// not cut off by the frame.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const frame = require('../src/services/plugins/frame');

function clientScript() {
  const doc = frame.document({ html: '', lang: 'de' });
  const start = doc.indexOf('<script>') + '<script>'.length;
  return doc.slice(start, doc.indexOf('</script>', start));
}

/** A minimal DOM: a page of `page` px and the fixed elements in `fixed`. */
function harness({ page, fixed = [] }) {
  const posted = [];
  const observers = [];
  const els = fixed.map((f) => ({ ...f }));
  const documentElement = { lang: 'de', get offsetHeight() { return page.h; }, scrollHeight: 5000, setAttribute() {} };
  const body = { querySelectorAll: () => els };
  const win = {
    parent: { postMessage: (msg) => posted.push(msg) },
    addEventListener() {},
    getComputedStyle: (el) => ({ position: el.position || 'static', display: el.hidden ? 'none' : 'block', visibility: 'visible' }),
    requestAnimationFrame: (fn) => fn(),
    MutationObserver: function (cb) { this.observe = () => observers.push(cb); },
  };
  for (const el of els) el.getBoundingClientRect = () => (el.hidden ? { width: 0, height: 0, top: 0 } : { width: 400, height: 300, top: el.top || 0 });
  const ctx = { window: win, MutationObserver: win.MutationObserver, document: { documentElement, body }, setTimeout, Object, Error, Promise, Math, Number, String };
  vm.runInNewContext(clientScript(), ctx);
  const mutate = () => observers.forEach((cb) => cb());
  const heights = () => posted.filter((m) => m.type === 'gc-resize').map((m) => m.height);
  return { els, mutate, heights, page };
}

describe('plugin frame height', () => {
  it('reports the document height, not the frame viewport (scrollHeight), so the frame can shrink', () => {
    const h = harness({ page: { h: 340 } });
    h.mutate();
    assert.deepEqual(h.heights(), [340]);
    h.page.h = 200;
    h.mutate();
    assert.deepEqual(h.heights(), [340, 200]);
  });

  it('an open fixed dialog taller than the page grows the frame, closing it shrinks it again', () => {
    const h = harness({ page: { h: 340 }, fixed: [{ position: 'fixed', hidden: true, scrollHeight: 964, top: 0 }] });
    h.mutate();
    h.els[0].hidden = false;
    h.mutate();
    h.els[0].hidden = true;
    h.mutate();
    assert.deepEqual(h.heights(), [340, 964, 340]);
  });

  it('a small fixed element (a toast) inside the page changes nothing; unchanged heights are not re-sent', () => {
    const h = harness({ page: { h: 600 }, fixed: [{ position: 'fixed', scrollHeight: 40, top: 10 }] });
    h.mutate();
    h.mutate();
    assert.deepEqual(h.heights(), [600]);
  });
});

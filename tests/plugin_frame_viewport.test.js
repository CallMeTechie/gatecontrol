'use strict';

// Frame side of GC.viewport (src/services/plugins/frame.js, since 1.199.0): a gc-viewport message of the parent
// sets window.GC.viewport, --gc-viewport-height and fires gc:viewport; anything else is ignored. The parent side
// (public/js/plugin-bridge.js) is checked in a browser: tests/e2e/scenarios/12-plugin-viewport.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frame = require('../src/services/plugins/frame');

function boot() {
  const doc = frame.document({ html: '', lang: 'de' });
  const start = doc.indexOf('<script>') + '<script>'.length;
  let onMessage = null;
  const props = {};
  const events = [];
  const parent = { postMessage() {} };
  const win = {
    parent,
    addEventListener(type, fn) { if (type === 'message') onMessage = fn; },
    dispatchEvent(e) { events.push(e); },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const document = { documentElement: { lang: 'de', style: { setProperty(k, v) { props[k] = v; } }, setAttribute() {} } };
  vm.runInNewContext(doc.slice(start, doc.indexOf('</script>', start)), { window: win, document, setTimeout, clearTimeout, Object, Error, Promise, String, Number, Math, CustomEvent });
  const send = (data, source = parent) => onMessage({ source, data });
  return { GC: win.GC, props, events, send };
}

describe('GC.viewport in a plugin frame', () => {
  it('null until the parent tells; then height / width, the CSS variable and gc:viewport', () => {
    const f = boot();
    assert.equal(f.GC.viewport, null);
    f.send({ type: 'gc-viewport', height: 590.6, width: 1216 });
    assert.deepEqual({ ...f.GC.viewport }, { height: 590, width: 1216 });
    assert.ok(Object.isFrozen(f.GC.viewport));
    assert.equal(f.props['--gc-viewport-height'], '590px');
    assert.deepEqual(f.events.map((e) => [e.type, e.detail.height]), [['gc:viewport', 590]]);
    assert.ok(Object.isFrozen(f.GC), 'GC stays frozen; viewport is a getter');
  });

  it('ignores other senders and implausible values', () => {
    const f = boot();
    f.send({ type: 'gc-viewport', height: 600, width: 100 }, { not: 'the parent' });
    for (const h of [0, 199, 20001, 'x', null, NaN]) f.send({ type: 'gc-viewport', height: h, width: 100 });
    assert.equal(f.GC.viewport, null);
    assert.equal(f.events.length, 0);
    f.send({ type: 'gc-viewport', height: 200, width: -5 });
    assert.deepEqual({ ...f.GC.viewport }, { height: 200, width: 0 });
  });

  it('the parent side: plugin-bridge.js sends it; the kiosk portal has no footer', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugin-bridge.js'), 'utf8');
    assert.match(js, /function sendViewport\(force\)/);
    assert.match(js, /type: 'gc-viewport', height, width/);
    assert.match(js, /function contentBottom\(\)/);
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'portal.css'), 'utf8');
    assert.match(css, /\.pt-kiosk \.pt-footer \{ display: none; \}/);
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'portal', 'portal.njk'), 'utf8');
    assert.match(tpl, /<body class="pt-body\{% if kiosk %\} pt-kiosk\{% endif %\}">/);
  });
});

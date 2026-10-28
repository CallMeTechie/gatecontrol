'use strict';

// Direct links into a plugin tab (docs/plugins.md "Portal"): the query of
// "/portal?<key>=<value>#plg-<id>" reaches that tab's frame, simple keys and
// short values only; the address bar keeps just the hash.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8');
const start = js.indexOf('// ─── Direct links into a plugin tab');
const end = js.indexOf('// ─── Boot', start);
const block = js.slice(start, end);

function run(search, hash, src = '/portal/plugins/gatecontrol-drive/frame') {
  const frame = { attrs: { src }, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; } };
  const panels = { 'panel-plg-gatecontrol-drive': { querySelector: (s) => (s === 'iframe[data-plugin-frame]' ? frame : null) } };
  const replaced = [];
  vm.runInNewContext(block, {
    doc: { getElementById: (id) => panels[id] || null },
    location: { search, hash, pathname: '/portal' },
    history: { replaceState: (a, b, url) => replaced.push(url) },
    URLSearchParams,
    encodeURIComponent,
  });
  return { src: frame.attrs.src, replaced };
}

test('the query of a direct link reaches the frame of the plugin tab named by the hash', () => {
  const r = run('?drive=42', '#plg-gatecontrol-drive');
  assert.equal(r.src, '/portal/plugins/gatecontrol-drive/frame?drive=42');
  assert.deepEqual(r.replaced, ['/portal#plg-gatecontrol-drive']);
});

test('camelCase keys pass (the cloud accounts\' return: cloud=error&cloudError=<code>)', () => {
  const r = run('?drive=import&cloud=error&cloudError=ERR_CLOUD_AUTH', '#plg-gatecontrol-drive');
  assert.equal(r.src, '/portal/plugins/gatecontrol-drive/frame?drive=import&cloud=error&cloudError=ERR_CLOUD_AUTH');
});

test('only simple keys and short values; never section; nothing without a plugin tab or a query', () => {
  const r = run('?drive=7&Bad=1&section=x&x=' + 'a'.repeat(201) + '&n=a%20b', '#plg-gatecontrol-drive');
  assert.equal(r.src, '/portal/plugins/gatecontrol-drive/frame?drive=7&n=a%20b');
  assert.equal(run('?drive=7', '#start').src, '/portal/plugins/gatecontrol-drive/frame');
  assert.equal(run('?drive=7', '#plg-other').replaced.length, 0, 'no such tab: nothing changes');
  assert.equal(run('', '#plg-gatecontrol-drive').replaced.length, 0);
});

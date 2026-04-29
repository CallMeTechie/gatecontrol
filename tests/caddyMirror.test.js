'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildMirrorHandler } = require('../src/services/caddyMirror');

describe('caddyMirror: buildMirrorHandler', () => {
  it('returns the canonical Caddy mirror handler shape', () => {
    const h = buildMirrorHandler([
      { ip: '10.8.0.10', port: 80 },
      { ip: '10.8.0.11', port: 8080 },
    ]);
    assert.equal(h.handler, 'mirror');
    assert.deepEqual(h.targets, [
      { dial: '10.8.0.10:80' },
      { dial: '10.8.0.11:8080' },
    ]);
  });

  it('preserves caller-supplied target order', () => {
    const h = buildMirrorHandler([
      { ip: '10.0.0.3', port: 3 },
      { ip: '10.0.0.1', port: 1 },
      { ip: '10.0.0.2', port: 2 },
    ]);
    assert.deepEqual(h.targets.map(t => t.dial), ['10.0.0.3:3', '10.0.0.1:1', '10.0.0.2:2']);
  });

  it('returns an empty targets array on an empty input list', () => {
    // The callers gate on `mirrorTargets.length > 0` before invoking this
    // helper, but the empty case still has a defined shape — useful when
    // the helper gets re-used elsewhere or the caller-side check changes.
    const h = buildMirrorHandler([]);
    assert.equal(h.handler, 'mirror');
    assert.deepEqual(h.targets, []);
  });
});

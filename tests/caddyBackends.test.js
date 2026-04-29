'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveBackends } = require('../src/services/caddyBackends');

// Tiny in-memory DB stub — only implements the .prepare(...).get(...)
// surface that resolveBackends actually uses. Avoids spinning up SQLite
// for a pure-logic unit test.
function makeStubDb(peers) {
  return {
    prepare(_sql) {
      return {
        get(id) {
          return peers.get(id);
        },
      };
    },
  };
}

describe('caddyBackends: resolveBackends', () => {
  it('returns null when route.backends is unset', () => {
    assert.equal(resolveBackends(makeStubDb(new Map()), {}), null);
    assert.equal(resolveBackends(makeStubDb(new Map()), { backends: '' }), null);
  });

  it('returns null on invalid JSON', () => {
    assert.equal(resolveBackends(makeStubDb(new Map()), { backends: 'not-json' }), null);
  });

  it('returns null when the JSON value is not an array', () => {
    assert.equal(resolveBackends(makeStubDb(new Map()), { backends: '{}' }), null);
    assert.equal(resolveBackends(makeStubDb(new Map()), { backends: '"str"' }), null);
  });

  it('resolves a single backend to { ip, port, weight }', () => {
    const peers = new Map([
      [1, { allowed_ips: '10.8.0.7/32', enabled: 1 }],
    ]);
    const out = resolveBackends(makeStubDb(peers), {
      backends: JSON.stringify([{ peer_id: 1, port: 80, weight: 2 }]),
    });
    assert.deepEqual(out, [{ ip: '10.8.0.7', port: 80, weight: 2 }]);
  });

  it('defaults weight to 1 when not provided', () => {
    const peers = new Map([[1, { allowed_ips: '10.0.0.1/32', enabled: 1 }]]);
    const out = resolveBackends(makeStubDb(peers), {
      backends: JSON.stringify([{ peer_id: 1, port: 80 }]),
    });
    assert.equal(out[0].weight, 1);
  });

  it('drops entries without peer_id', () => {
    const peers = new Map();
    const out = resolveBackends(makeStubDb(peers), {
      backends: JSON.stringify([{ port: 80 }, { peer_id: null, port: 80 }]),
    });
    assert.deepEqual(out, []);
  });

  it('drops entries whose peer is missing from the DB', () => {
    const peers = new Map();
    const out = resolveBackends(makeStubDb(peers), {
      backends: JSON.stringify([{ peer_id: 999, port: 80 }]),
    });
    assert.deepEqual(out, []);
  });

  it('drops entries whose peer is disabled', () => {
    const peers = new Map([
      [1, { allowed_ips: '10.0.0.1/32', enabled: 0 }],
      [2, { allowed_ips: '10.0.0.2/32', enabled: 1 }],
    ]);
    const out = resolveBackends(makeStubDb(peers), {
      backends: JSON.stringify([
        { peer_id: 1, port: 80 },
        { peer_id: 2, port: 80 },
      ]),
    });
    assert.deepEqual(out, [{ ip: '10.0.0.2', port: 80, weight: 1 }]);
  });

  it('preserves caller-supplied order', () => {
    const peers = new Map([
      [3, { allowed_ips: '10.0.0.3/32', enabled: 1 }],
      [1, { allowed_ips: '10.0.0.1/32', enabled: 1 }],
      [2, { allowed_ips: '10.0.0.2/32', enabled: 1 }],
    ]);
    const out = resolveBackends(makeStubDb(peers), {
      backends: JSON.stringify([
        { peer_id: 3, port: 80 },
        { peer_id: 1, port: 80 },
        { peer_id: 2, port: 80 },
      ]),
    });
    assert.deepEqual(out.map(b => b.ip), ['10.0.0.3', '10.0.0.1', '10.0.0.2']);
  });
});

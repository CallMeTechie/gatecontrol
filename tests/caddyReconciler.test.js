'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectDivergence,
  extractCaddyRouteIds,
  runReconciliationCycle,
} = require('../src/services/caddyReconciler');

describe('detectDivergence', () => {
  test('no divergence when sets are equal', () => {
    const r = detectDivergence(new Set(['a', 'b']), new Set(['b', 'a']));
    assert.equal(r.diverged, false);
    assert.deepEqual(r.missingInCaddy, []);
    assert.deepEqual(r.extraInCaddy, []);
  });

  test('reports IDs expected but not in Caddy (ghost routes)', () => {
    const r = detectDivergence(new Set(['a', 'b', 'c']), new Set(['a']));
    assert.equal(r.diverged, true);
    assert.deepEqual(r.missingInCaddy.sort(), ['b', 'c']);
    assert.deepEqual(r.extraInCaddy, []);
  });

  test('reports IDs in Caddy but not expected (zombie routes)', () => {
    const r = detectDivergence(new Set(['a']), new Set(['a', 'x', 'y']));
    assert.equal(r.diverged, true);
    assert.deepEqual(r.missingInCaddy, []);
    assert.deepEqual(r.extraInCaddy.sort(), ['x', 'y']);
  });

  test('reports both sides of divergence', () => {
    const r = detectDivergence(new Set(['a', 'b']), new Set(['b', 'z']));
    assert.equal(r.diverged, true);
    assert.deepEqual(r.missingInCaddy, ['a']);
    assert.deepEqual(r.extraInCaddy, ['z']);
  });

  test('two empty sets are not diverged', () => {
    const r = detectDivergence(new Set(), new Set());
    assert.equal(r.diverged, false);
  });
});

describe('extractCaddyRouteIds', () => {
  test('returns empty set on null or missing apps', () => {
    assert.equal(extractCaddyRouteIds(null).size, 0);
    assert.equal(extractCaddyRouteIds({}).size, 0);
    assert.equal(extractCaddyRouteIds({ apps: {} }).size, 0);
    assert.equal(extractCaddyRouteIds({ apps: { http: {} } }).size, 0);
    assert.equal(extractCaddyRouteIds({ apps: { http: { servers: {} } } }).size, 0);
  });

  test('collects @id from every server route across multiple servers', () => {
    const cfg = {
      apps: {
        http: {
          servers: {
            srv0: {
              routes: [
                { '@id': 'gc_route_1', match: [{ host: ['a'] }] },
                { '@id': 'gc_route_2' },
                { match: [{ host: ['no-id'] }] }, // no @id — should be ignored
              ],
            },
            srv_l4: {
              routes: [{ '@id': 'gc_route_99' }],
            },
          },
        },
      },
    };
    const ids = extractCaddyRouteIds(cfg);
    assert.deepEqual([...ids].sort(), ['gc_route_1', 'gc_route_2', 'gc_route_99']);
  });

  test('ignores non-string @id values (malformed config)', () => {
    const cfg = {
      apps: { http: { servers: { s: { routes: [{ '@id': 123 }, { '@id': null }] } } } },
    };
    assert.equal(extractCaddyRouteIds(cfg).size, 0);
  });
});

describe('runReconciliationCycle', () => {
  function fakeLogger() {
    const calls = [];
    return {
      warn: (o, m) => calls.push(['warn', o, m]),
      error: (o, m) => calls.push(['error', o, m]),
      info: (o, m) => calls.push(['info', o, m]),
      debug: (m) => calls.push(['debug', m]),
      calls,
    };
  }

  test('no divergence — returns ok result, no warning', async () => {
    const logger = fakeLogger();
    const result = await runReconciliationCycle({
      listDbRouteIds: () => new Set(['gc_route_1', 'gc_route_2']),
      getCaddyConfig: async () => ({
        apps: { http: { servers: { srv0: { routes: [
          { '@id': 'gc_route_1' }, { '@id': 'gc_route_2' },
        ] } } } },
      }),
      logger,
    });
    assert.equal(result.diverged, false);
    assert.equal(logger.calls.filter(c => c[0] === 'warn').length, 0);
  });

  test('Caddy unreachable — reports skipped, no warning', async () => {
    const logger = fakeLogger();
    const result = await runReconciliationCycle({
      listDbRouteIds: () => new Set(['gc_route_1']),
      getCaddyConfig: async () => null,
      logger,
    });
    assert.equal(result.skipped, true);
    assert.equal(logger.calls.filter(c => c[0] === 'warn').length, 0);
  });

  test('divergence detected — logs warn, does NOT auto-repair by default', async () => {
    const logger = fakeLogger();
    let synced = false;
    const result = await runReconciliationCycle({
      listDbRouteIds: () => new Set(['gc_route_1', 'gc_route_2']),
      getCaddyConfig: async () => ({
        apps: { http: { servers: { srv0: { routes: [{ '@id': 'gc_route_1' }] } } } },
      }),
      syncToCaddy: async () => { synced = true; },
      autoRepair: false,
      logger,
    });
    assert.equal(result.diverged, true);
    assert.equal(result.repaired, false);
    assert.deepEqual(result.missingInCaddy, ['gc_route_2']);
    assert.equal(synced, false, 'autoRepair=false must not call syncToCaddy');
    assert.equal(logger.calls.filter(c => c[0] === 'warn').length, 1);
  });

  test('divergence with autoRepair=true calls syncToCaddy', async () => {
    const logger = fakeLogger();
    let synced = false;
    const result = await runReconciliationCycle({
      listDbRouteIds: () => new Set(['gc_route_1', 'gc_route_2']),
      getCaddyConfig: async () => ({
        apps: { http: { servers: { srv0: { routes: [{ '@id': 'gc_route_1' }] } } } },
      }),
      syncToCaddy: async () => { synced = true; },
      autoRepair: true,
      logger,
    });
    assert.equal(result.diverged, true);
    assert.equal(result.repaired, true);
    assert.equal(synced, true);
    // logger.info was called with a single string arg → check c[1] (o-slot)
    assert.ok(logger.calls.some(c =>
      c[0] === 'info' && (/re-synced/.test(c[1] || '') || /re-synced/.test(c[2] || ''))
    ));
  });

  test('autoRepair failure is reported without crashing the cycle', async () => {
    const logger = fakeLogger();
    const result = await runReconciliationCycle({
      listDbRouteIds: () => new Set(['gc_route_1']),
      getCaddyConfig: async () => ({
        apps: { http: { servers: { srv0: { routes: [] } } } },
      }),
      syncToCaddy: async () => { throw new Error('caddy rejected'); },
      autoRepair: true,
      logger,
    });
    assert.equal(result.diverged, true);
    assert.equal(result.repaired, false);
    assert.equal(result.repairError, 'caddy rejected');
    assert.ok(logger.calls.some(c => c[0] === 'error' && /auto-repair failed/.test(c[2] || '')));
  });

  test('zombie route detected (in Caddy, not DB)', async () => {
    const logger = fakeLogger();
    const result = await runReconciliationCycle({
      listDbRouteIds: () => new Set(['gc_route_1']),
      getCaddyConfig: async () => ({
        apps: { http: { servers: { srv0: { routes: [
          { '@id': 'gc_route_1' }, { '@id': 'gc_route_99' },
        ] } } } },
      }),
      logger,
    });
    assert.equal(result.diverged, true);
    assert.deepEqual(result.extraInCaddy, ['gc_route_99']);
    assert.deepEqual(result.missingInCaddy, []);
  });
});

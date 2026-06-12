'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const view = require('../public/js/routes-view');

const http = (over = {}) => ({
  id: 1, domain: 'a.example.com', route_type: 'http', enabled: 1,
  peer_enabled: 1, target_kind: 'peer', ...over,
});
const l4 = (over = {}) => ({
  id: 2, domain: null, route_type: 'l4', l4_protocol: 'tcp',
  l4_listen_port: '2022', l4_tls_mode: 'none', enabled: 1,
  peer_enabled: 1, target_kind: 'peer', ...over,
});

describe('routeStatus', () => {
  it('disabled beats everything', () => {
    assert.equal(view.routeStatus(http({ enabled: 0, monitoring_enabled: 1, monitoring_status: 'down' })), 'disabled');
  });
  it('monitoring down → down', () => {
    assert.equal(view.routeStatus(http({ monitoring_enabled: 1, monitoring_status: 'down' })), 'down');
  });
  it('offline gateway peer → down', () => {
    assert.equal(view.routeStatus(http({ target_kind: 'gateway', target_peer_enabled: 0 })), 'down');
  });
  it('healthy → active', () => {
    assert.equal(view.routeStatus(http()), 'active');
  });
});

describe('routeGroupKey', () => {
  it('bundle wins over domain', () => {
    assert.equal(view.routeGroupKey(http({ bundle_id: 7 })), 'b:7');
  });
  it('domain is case-insensitive', () => {
    assert.equal(view.routeGroupKey(http({ domain: 'SSH.Example.COM' })), 'd:ssh.example.com');
  });
  it('domainless routes share the no-domain bucket', () => {
    assert.equal(view.routeGroupKey(l4()), view.NO_DOMAIN_KEY);
  });
});

describe('buildGroups', () => {
  it('groups bundle members, same-domain routes and no-domain L4s', () => {
    const routes = [
      http({ id: 1, bundle_id: 5, bundle_name: 'NAS', domain: 'nas.example.com' }),
      l4({ id: 2, bundle_id: 5, bundle_name: 'NAS' }),
      http({ id: 3, domain: 'solo.example.com' }),
      http({ id: 4, domain: 'pair.example.com' }),
      l4({ id: 5, domain: 'pair.example.com', l4_tls_mode: 'passthrough' }),
      l4({ id: 6 }),
    ];
    const groups = view.buildGroups(routes);
    assert.equal(groups.length, 4);

    const bundle = groups.find((g) => g.isBundle);
    assert.equal(bundle.label, 'NAS');
    assert.equal(bundle.routes.length, 2);
    assert.equal(bundle.routes[0].route_type, 'http', 'http member sorts first');

    const solo = groups.find((g) => g.key === 'd:solo.example.com');
    assert.equal(solo.single, true, 'lone non-bundle route renders without chrome');

    const pair = groups.find((g) => g.key === 'd:pair.example.com');
    assert.equal(pair.single, false);
    assert.equal(pair.routes.length, 2);

    assert.equal(groups[groups.length - 1].key, view.NO_DOMAIN_KEY, 'no-domain bucket sorts last');
  });

  it('derives the worst status across members (mixed when partially disabled)', () => {
    const groups = view.buildGroups([
      http({ id: 1, domain: 'x.example.com' }),
      l4({ id: 2, domain: 'x.example.com', l4_tls_mode: 'passthrough', enabled: 0 }),
    ]);
    assert.equal(groups[0].status, 'mixed');

    const downGroups = view.buildGroups([
      http({ id: 1, domain: 'y.example.com', monitoring_enabled: 1, monitoring_status: 'down' }),
      l4({ id: 2, domain: 'y.example.com', l4_tls_mode: 'passthrough' }),
    ]);
    assert.equal(downGroups[0].status, 'down');
  });
});

describe('filterRoutes', () => {
  const routes = [
    http({ id: 1, domain: 'web.example.com' }),
    l4({ id: 2, description: 'ssh forward' }),
    http({ id: 3, domain: 'gw.example.com', target_kind: 'gateway', target_peer_enabled: 1 }),
    http({ id: 4, domain: 'pool.example.com', target_kind: 'gateway', target_pool_id: 3, target_peer_enabled: 1 }),
    http({ id: 5, domain: 'off.example.com', enabled: 0 }),
  ];

  it('filters by type', () => {
    assert.deepEqual(view.filterRoutes(routes, { type: 'l4' }).map((r) => r.id), [2]);
  });
  it('filters by status', () => {
    assert.deepEqual(view.filterRoutes(routes, { status: 'disabled' }).map((r) => r.id), [5]);
  });
  it('filters by target kind incl. pool', () => {
    assert.deepEqual(view.filterRoutes(routes, { target: 'pool' }).map((r) => r.id), [4]);
    assert.deepEqual(view.filterRoutes(routes, { target: 'gateway' }).map((r) => r.id), [3]);
  });
  it('combines chips with text search (AND)', () => {
    assert.deepEqual(view.filterRoutes(routes, { type: 'http', q: 'web' }).map((r) => r.id), [1]);
    assert.deepEqual(view.filterRoutes(routes, { type: 'l4', q: 'web' }), []);
  });
  it('searches descriptions and bundle names', () => {
    assert.deepEqual(view.filterRoutes(routes, { q: 'ssh forward' }).map((r) => r.id), [2]);
    const withBundle = [http({ id: 9, bundle_id: 1, bundle_name: 'Mein Service' })];
    assert.equal(view.filterRoutes(withBundle, { q: 'mein serv' }).length, 1);
  });
});

describe('sortRoutes', () => {
  it('sorts by status: down → mixed/disabled → active', () => {
    const sorted = view.sortRoutes([
      http({ id: 1, domain: 'a' }),
      http({ id: 2, domain: 'b', enabled: 0 }),
      http({ id: 3, domain: 'c', monitoring_enabled: 1, monitoring_status: 'down' }),
    ], 'status');
    assert.deepEqual(sorted.map((r) => r.id), [3, 2, 1]);
  });
  it('sorts by type: http first', () => {
    const sorted = view.sortRoutes([l4({ id: 1 }), http({ id: 2 })], 'type');
    assert.deepEqual(sorted.map((r) => r.id), [2, 1]);
  });
  it('sorts by domain, domainless last', () => {
    const sorted = view.sortRoutes([l4({ id: 1 }), http({ id: 2, domain: 'z' }), http({ id: 3, domain: 'a' })], 'domain');
    assert.deepEqual(sorted.map((r) => r.id), [3, 2, 1]);
  });
});

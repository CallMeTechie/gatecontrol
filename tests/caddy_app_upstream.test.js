'use strict';

// Every reverse_proxy to the local Node app waits for it during a container
// (re)start instead of failing with "connection refused" → 502.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const handlersOf = (hs, out = []) => {
  for (const h of hs || []) {
    out.push(h);
    if (h.handler === 'subroute') for (const r of h.routes || []) handlersOf(r.handle, out);
  }
  return out;
};

describe('caddyAppUpstream: app upstreams wait during a restart', () => {
  let buildCaddyConfig, appUpstream, buildForwardAuthSubrequest, buildRouteAuthProxy;
  before(async () => {
    await setup();
    ({ buildCaddyConfig } = require('../src/services/caddyConfig'));
    ({ appUpstream } = require('../src/services/caddyAppUpstream'));
    ({ buildForwardAuthSubrequest, buildRouteAuthProxy } = require('../src/services/caddyAuthSubroute'));
  });
  after(teardown);

  it('appUpstream: one local upstream plus try_duration / try_interval', () => {
    assert.deepEqual(appUpstream(3000), {
      upstreams: [{ dial: '127.0.0.1:3000' }],
      load_balancing: { try_duration: '10s', try_interval: '250ms' },
    });
    assert.equal(appUpstream(4000).upstreams[0].dial, '127.0.0.1:4000');
    assert.notEqual(appUpstream().upstreams, appUpstream().upstreams, 'fresh objects');
  });

  it('no retry_match: after a connection only GET is retried (a POST is never sent twice)', () => {
    assert.equal('retry_match' in appUpstream().load_balancing, false);
    assert.equal('retries' in appUpstream().load_balancing, false);
  });

  it('route-auth pages and the forward-auth subrequest carry it', () => {
    assert.deepEqual(buildRouteAuthProxy().handle[0].load_balancing, appUpstream().load_balancing);
    assert.deepEqual(buildForwardAuthSubrequest('a.example.com').load_balancing, appUpstream().load_balancing);
  });

  it('every reverse_proxy in the generated config that dials the app carries it', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'a.example.com', route_type: 'http', target_kind: 'peer',
      target_ip: '10.8.0.7', target_port: 80, enabled: 1, https_enabled: 1,
      auth_type: 'email_password',
    }]);
    const all = Object.values(cfg.apps.http.servers).flatMap((srv) => (srv.routes || []).flatMap((r) => handlersOf(r.handle)));
    const toApp = all.filter((h) => h.handler === 'reverse_proxy' && (h.upstreams || []).some((u) => /^127\.0\.0\.1:/.test(u.dial)));
    assert.ok(toApp.length >= 2, `found ${toApp.length} app proxies`);
    for (const h of toApp) assert.deepEqual(h.load_balancing, appUpstream().load_balancing, JSON.stringify(h.upstreams));
    const toBackend = all.find((h) => h.handler === 'reverse_proxy' && (h.upstreams || []).some((u) => u.dial === '10.8.0.7:80'));
    assert.ok(toBackend && !(toBackend.load_balancing && toBackend.load_balancing.try_duration), 'backends are not affected');
  });
});

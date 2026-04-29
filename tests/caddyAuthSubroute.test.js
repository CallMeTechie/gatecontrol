'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRouteAuthProxy,
  buildForwardAuthSubrequest,
  buildAuthHandlerChain,
} = require('../src/services/caddyAuthSubroute');

describe('caddyAuthSubroute: buildRouteAuthProxy', () => {
  it('intercepts /route-auth/* and proxies to local Node app', () => {
    const out = buildRouteAuthProxy();
    assert.deepEqual(out, {
      match: [{ path: ['/route-auth/*'] }],
      handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: '127.0.0.1:3000' }],
      }],
    });
  });

  it('returns a fresh object each call (no shared mutation between routes)', () => {
    const a = buildRouteAuthProxy();
    const b = buildRouteAuthProxy();
    assert.notEqual(a, b);
    assert.notEqual(a.match, b.match);
  });
});

describe('caddyAuthSubroute: buildForwardAuthSubrequest', () => {
  it('embeds the route domain in headers and the login redirect URL', () => {
    const out = buildForwardAuthSubrequest('app.example.com');
    assert.equal(out.headers.request.set['X-Route-Domain'][0], 'app.example.com');
    const loginRedirect = out.handle_response[1].routes[0].handle[0].headers.Location[0];
    assert.match(loginRedirect, /\/route-auth\/login\?route=app\.example\.com&redirect=\{http\.request\.uri\}/);
  });

  it('passes the forwarded method + URI through as Caddy placeholders', () => {
    const out = buildForwardAuthSubrequest('x.example.com');
    assert.equal(out.headers.request.set['X-Forwarded-Method'][0], '{http.request.method}');
    assert.equal(out.headers.request.set['X-Forwarded-Uri'][0], '{http.request.uri}');
  });

  it('rewrites the upstream subrequest to a GET on /route-auth/verify', () => {
    const out = buildForwardAuthSubrequest('x.example.com');
    assert.deepEqual(out.rewrite, { method: 'GET', uri: '/route-auth/verify' });
  });

  it('handle_response: 2xx → vars no-op, default → 302 redirect', () => {
    const out = buildForwardAuthSubrequest('x.example.com');
    const ok = out.handle_response[0];
    assert.deepEqual(ok.match, { status_code: [2] });
    assert.equal(ok.routes[0].handle[0].handler, 'vars');

    const redirect = out.handle_response[1].routes[0].handle[0];
    assert.equal(redirect.handler, 'static_response');
    assert.equal(redirect.status_code, 302);
  });
});

describe('caddyAuthSubroute: buildAuthHandlerChain', () => {
  const baseRoute = { id: 1, domain: 'r.example.com' };
  const reverseProxy = { handler: 'reverse_proxy', upstreams: [{ dial: '10.0.0.1:80' }] };

  it('emits forward-auth + reverseProxy on a minimal route', () => {
    const handlers = buildAuthHandlerChain({
      route: baseRoute, reverseProxy, customHeaders: null, mirrorTargets: null,
    });
    assert.equal(handlers.length, 2);
    assert.equal(handlers[0].handler, 'reverse_proxy', 'forward-auth subrequest first');
    assert.equal(handlers[0].rewrite.uri, '/route-auth/verify');
    assert.equal(handlers[1], reverseProxy, 'final handler is the route reverseProxy');
  });

  it('debug_enabled prepends a trace handler ABOVE forward-auth', () => {
    const handlers = buildAuthHandlerChain({
      route: { ...baseRoute, debug_enabled: 1 },
      reverseProxy, customHeaders: null, mirrorTargets: null,
    });
    assert.equal(handlers[0].handler, 'trace');
    assert.equal(handlers[0].tag, 'route-1');
    assert.equal(handlers[1].handler, 'reverse_proxy');
    assert.equal(handlers[1].rewrite.uri, '/route-auth/verify');
  });

  it('bot_blocker_enabled prepends the defender config — sits ABOVE trace if both', () => {
    const handlers = buildAuthHandlerChain({
      route: { ...baseRoute, debug_enabled: 1, bot_blocker_enabled: 1 },
      reverseProxy, customHeaders: null, mirrorTargets: null,
    });
    // Order: bot_blocker (last unshift), trace, forward_auth, reverseProxy
    assert.equal(handlers[0].handler, 'defender');
    assert.equal(handlers[1].handler, 'trace');
    assert.equal(handlers[2].rewrite.uri, '/route-auth/verify');
  });

  it('rate_limit_enabled appends a rate_limit handler BELOW forward-auth', () => {
    const handlers = buildAuthHandlerChain({
      route: { ...baseRoute, rate_limit_enabled: 1, rate_limit_window: '1m', rate_limit_requests: 60 },
      reverseProxy, customHeaders: null, mirrorTargets: null,
    });
    const rl = handlers.find(h => h.handler === 'rate_limit');
    assert.ok(rl);
    assert.equal(rl.rate_limits.static.max_events, 60);
  });

  it('mirror handler appended when mirrorTargets non-empty', () => {
    const handlers = buildAuthHandlerChain({
      route: baseRoute, reverseProxy,
      customHeaders: null,
      mirrorTargets: [{ ip: '10.0.0.2', port: 80 }],
    });
    const mirror = handlers.find(h => h.handler === 'mirror');
    assert.ok(mirror);
    assert.deepEqual(mirror.targets, [{ dial: '10.0.0.2:80' }]);
  });

  it('compress_enabled appends an encode handler', () => {
    const handlers = buildAuthHandlerChain({
      route: { ...baseRoute, compress_enabled: 1 },
      reverseProxy, customHeaders: null, mirrorTargets: null,
    });
    const enc = handlers.find(h => h.handler === 'encode');
    assert.ok(enc);
    assert.deepEqual(enc.encodings, { zstd: {}, brotli: {}, gzip: {} });
  });

  it('custom request headers append below forward-auth', () => {
    const handlers = buildAuthHandlerChain({
      route: baseRoute, reverseProxy,
      customHeaders: { request: [{ name: 'X-Custom', value: 'v' }] },
      mirrorTargets: null,
    });
    const headers = handlers.find(h => h.handler === 'headers');
    assert.ok(headers);
    assert.deepEqual(headers.request.set, { 'X-Custom': ['v'] });
  });

  it('full feature stack: order is bot_blocker → trace → forward_auth → headers → rate_limit → mirror → encode → reverseProxy', () => {
    const handlers = buildAuthHandlerChain({
      route: {
        ...baseRoute,
        debug_enabled: 1,
        bot_blocker_enabled: 1,
        rate_limit_enabled: 1,
        rate_limit_window: '1m',
        rate_limit_requests: 60,
        compress_enabled: 1,
      },
      reverseProxy,
      customHeaders: { request: [{ name: 'X-Trace-Id', value: 'abc' }] },
      mirrorTargets: [{ ip: '10.0.0.2', port: 80 }],
    });
    const order = handlers.map(h => h.handler);
    // forward_auth is the first reverse_proxy with rewrite to /route-auth/verify
    assert.equal(order[0], 'defender');
    assert.equal(order[1], 'trace');
    assert.equal(order[2], 'reverse_proxy'); // forward auth subrequest
    assert.equal(handlers[2].rewrite.uri, '/route-auth/verify');
    assert.equal(order[3], 'headers');
    assert.equal(order[4], 'rate_limit');
    assert.equal(order[5], 'mirror');
    assert.equal(order[6], 'encode');
    assert.equal(handlers[7], reverseProxy);
  });
});

'use strict';

// public/js/session-guard.js: an admin page whose session is gone stops polling
// the API and goes to the login (the gateway page asked every 30 s and got 401s).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'session-guard.js'), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function page(answer) {
  const calls = [];
  const window = {
    location: { href: 'https://gc.example.test/gateways', origin: 'https://gc.example.test' },
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      return Promise.resolve({ status: answer(url) });
    },
  };
  vm.runInNewContext(SRC, { window, URL });
  return { window, calls };
}

describe('session guard', () => {
  it('401 of a poll and of /ping → no further API request, on to /login', async () => {
    const { window, calls } = page(() => 401);
    const res = await window.fetch('/api/v1/gateway-pools/state');
    assert.equal(res.status, 401, 'the caller still gets its answer');
    await flush();
    assert.deepEqual(calls, ['/api/v1/gateway-pools/state', '/api/v1/ping']);
    assert.equal(window.location.href, '/login');
    let settled = false;
    window.fetch('/api/v1/gateways').then(() => { settled = true; }, () => { settled = true; });
    window.fetch('/api/v1/gateway-locations').then(() => { settled = true; });
    await flush();
    assert.equal(settled, false, 'never settles: no error shown, no next timer armed');
    assert.equal(calls.length, 2, 'nothing more leaves the page');
  });

  it('401 of an endpoint while the session is alive (ping 200) → nothing changes', async () => {
    const { window, calls } = page((u) => (u === '/api/v1/ping' ? 200 : 401));
    await window.fetch('/api/v1/settings/wireguard');
    await flush();
    assert.equal(window.location.href, 'https://gc.example.test/gateways');
    const r = await window.fetch('/api/v1/gateways');
    assert.equal(r.status, 401);
    assert.equal(calls.filter((u) => u === '/api/v1/gateways').length, 1);
  });

  it('several 401s at once → one probe; other origins and non-API paths are not watched', async () => {
    const { window, calls } = page((u) => (u === '/api/v1/ping' ? 200 : 401));
    await Promise.all([window.fetch('/api/v1/gateways'), window.fetch('/api/v1/gateway-locations'), window.fetch('/api/v1/gateway-pools/state')]);
    await flush();
    assert.equal(calls.filter((u) => u === '/api/v1/ping').length, 1);
    await window.fetch('https://other.example.com/api/v1/x');
    await window.fetch('/static/thing.json');
    await flush();
    assert.equal(calls.filter((u) => u === '/api/v1/ping').length, 1);
  });

  it('the layout loads it before app.js and the page scripts', () => {
    const layout = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'layout.njk'), 'utf8');
    const guard = layout.indexOf('/js/session-guard.js');
    assert.ok(guard > 0 && guard < layout.indexOf('/js/app.js') && guard < layout.indexOf('{% block scripts %}'));
  });
});

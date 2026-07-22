'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CookieJar, requestWithJar, followRedirects } = require('../src/services/skoda/skodaHttp');

function fakeRes({ status = 200, headers = {}, setCookies = [] } = {}) {
  const h = new Headers(headers);
  for (const c of setCookies) h.append('set-cookie', c);
  return { status, headers: h };
}

test('CookieJar stores cookies per host and builds header', () => {
  const jar = new CookieJar();
  jar.storeFrom(fakeRes({ setCookies: ['SESSION=abc; Path=/; HttpOnly', 'csrf=x1; Path=/'] }), 'https://identity.vwgroup.io/oidc/v1/authorize');
  jar.storeFrom(fakeRes({ setCookies: ['other=zzz'] }), 'https://mysmob.api.connect.skoda-auto.cz/x');
  assert.equal(jar.headerFor('https://identity.vwgroup.io/signin'), 'SESSION=abc; csrf=x1');
  assert.equal(jar.headerFor('https://mysmob.api.connect.skoda-auto.cz/y'), 'other=zzz');
  assert.equal(jar.headerFor('https://example.com/'), null);
});

test('CookieJar overwrites cookie with same name', () => {
  const jar = new CookieJar();
  jar.storeFrom(fakeRes({ setCookies: ['SESSION=old'] }), 'https://a.example/');
  jar.storeFrom(fakeRes({ setCookies: ['SESSION=new'] }), 'https://a.example/');
  assert.equal(jar.headerFor('https://a.example/'), 'SESSION=new');
});

test('requestWithJar sends cookie header and stores new cookies', async () => {
  const jar = new CookieJar();
  jar.storeFrom(fakeRes({ setCookies: ['a=1'] }), 'https://a.example/');
  let seenHeaders = null;
  const fetchImpl = async (url, opts) => { seenHeaders = opts.headers; return fakeRes({ setCookies: ['b=2'] }); };
  await requestWithJar(jar, 'https://a.example/next', {}, fetchImpl);
  assert.equal(seenHeaders.cookie, 'a=1');
  assert.equal(jar.headerFor('https://a.example/'), 'a=1; b=2');
});

test('followRedirects follows 302 chain and stops at stopPrefix', async () => {
  const jar = new CookieJar();
  const hops = [
    fakeRes({ status: 302, headers: { location: 'https://b.example/step2' }, setCookies: ['s1=1'] }),
    fakeRes({ status: 302, headers: { location: '/step3' } }),
    fakeRes({ status: 302, headers: { location: 'myskoda://redirect/login/#code=THECODE' } }),
  ];
  let calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, method: opts.method || 'GET' }); return hops.shift(); };
  const { location } = await followRedirects(jar, 'https://a.example/start', { method: 'POST', body: 'x' },
    { stopPrefix: 'myskoda://', fetchImpl });
  assert.equal(location, 'myskoda://redirect/login/#code=THECODE');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET'); // Redirects werden als GET gefolgt
  assert.equal(calls[1].url, 'https://b.example/step2');
  assert.equal(calls[2].url, 'https://b.example/step3'); // relative Location aufgelöst
});

test('followRedirects throws after maxHops', async () => {
  const jar = new CookieJar();
  const fetchImpl = async () => fakeRes({ status: 302, headers: { location: 'https://a.example/loop' } });
  await assert.rejects(
    followRedirects(jar, 'https://a.example/', {}, { maxHops: 3, fetchImpl }),
    /too many redirects/
  );
});

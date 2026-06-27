'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

// Portal login must "target the portal": after logging in via the portal, the
// user returns to /portal (not the admin /dashboard). Implemented via a
// validated, internal-only returnTo that is restricted to the portal path
// (open-redirect guard). Admin login is unchanged when no returnTo is given.

let app;
before(async () => { ({ app } = await setup()); });
after(async () => { await teardown(); });

async function freshLogin({ returnToQuery, returnToBody } = {}) {
  const a = supertest.agent(app);
  const url = '/login' + (returnToQuery !== undefined ? `?returnTo=${encodeURIComponent(returnToQuery)}` : '');
  const page = await a.get(url);
  const m = page.text.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrf = m ? m[1] : '';
  const body = { username: 'admin', password: 'TestPass123!', _csrf: csrf };
  if (returnToBody !== undefined) body.returnTo = returnToBody;
  const res = await a.post('/login').type('form').send(body);
  return { a, page, res };
}

test('portal login: returnTo=/portal redirects back to /portal', async () => {
  const { res } = await freshLogin({ returnToBody: '/portal' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/portal');
});

test('admin login unchanged: no returnTo → /dashboard', async () => {
  const { res } = await freshLogin({});
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('open-redirect guard: external returnTo rejected → /dashboard', async () => {
  const { res } = await freshLogin({ returnToBody: '//evil.example.com/x' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('non-portal internal returnTo rejected → /dashboard', async () => {
  const { res } = await freshLogin({ returnToBody: '/peers' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('GET /login?returnTo=/portal renders a hidden returnTo field carrying /portal', async () => {
  const a = supertest.agent(app);
  const page = await a.get('/login?returnTo=/portal');
  assert.match(page.text, /name="returnTo"[^>]*value="\/portal"/);
});

test('GET /login sanitizes an external returnTo out of the form', async () => {
  const a = supertest.agent(app);
  const page = await a.get('/login?returnTo=' + encodeURIComponent('//evil.example.com'));
  assert.doesNotMatch(page.text, /evil\.example\.com/);
});

test('guestOnly: authenticated GET /login?returnTo=/portal → /portal', async () => {
  const { a } = await freshLogin({});                 // now authenticated
  const res = await a.get('/login?returnTo=/portal');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/portal');
});

test('guestOnly: authenticated GET /login without returnTo → / (unchanged)', async () => {
  const { a } = await freshLogin({});
  const res = await a.get('/login');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
});

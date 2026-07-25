'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let ctx, settings, caddyConfig, origSync;

before(async () => {
  ctx = await setup();
  settings = require('../src/services/settings');
  caddyConfig = require('../src/services/caddyConfig');
  origSync = caddyConfig.syncToCaddy;
});
after(async () => {
  if (caddyConfig && origSync) caddyConfig.syncToCaddy = origSync;
  await teardown();
});
beforeEach(() => { settings.set('caddy.acme_email', ''); caddyConfig.syncToCaddy = origSync; });

function put(body) {
  return ctx.agent.put('/api/v1/settings/acme-email').set('x-csrf-token', ctx.csrfToken).send(body);
}

test('a valid address is stored and pushed', async () => {
  let calls = 0;
  caddyConfig.syncToCaddy = async () => { calls += 1; };
  const res = await put({ email: '  me@example.com  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.warning, undefined);
  assert.equal(settings.get('caddy.acme_email'), 'me@example.com'); // getrimmt gespeichert
  assert.equal(calls, 1);
});

test('an empty string clears the setting and falls back to the environment', async () => {
  caddyConfig.syncToCaddy = async () => {};
  for (const body of [{ email: '' }, { email: '   ' }]) {
    settings.set('caddy.acme_email', 'old@example.com');
    const res = await put(body);
    assert.equal(res.status, 200);
    assert.equal(settings.get('caddy.acme_email'), '');
  }
});

test('a missing or non-string field is a client error, never a delete command', async () => {
  caddyConfig.syncToCaddy = async () => { throw new Error('darf nicht aufgerufen werden'); };
  for (const body of [{}, { email: null }, { email: 42 }, { email: { a: 1 } }]) {
    settings.set('caddy.acme_email', 'keep@example.com');
    const res = await put(body);
    assert.equal(res.status, 400, `Body ${JSON.stringify(body)} ergab ${res.status}`);
    assert.equal(settings.get('caddy.acme_email'), 'keep@example.com', 'Wert wurde angetastet');
  }
});

test('an invalid address is rejected without pushing', async () => {
  let calls = 0;
  caddyConfig.syncToCaddy = async () => { calls += 1; };
  settings.set('caddy.acme_email', 'keep@example.com');
  const res = await put({ email: 'no-at-sign' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'Fehlertext fehlt');           // übersetzt, Wortlaut nicht festnageln
  assert.equal(settings.get('caddy.acme_email'), 'keep@example.com');
  assert.equal(calls, 0);
});

test('a throwing push keeps the value and warns', async () => {
  caddyConfig.syncToCaddy = async () => { throw new Error('caddy down'); };
  const res = await put({ email: 'me@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.warning, 'settings.acme_email.push_failed');
  assert.equal(settings.get('caddy.acme_email'), 'me@example.com');
});

test('a push refused by the ownership guard (false) also warns', async () => {
  // syncToCaddy wirft in diesem Fall NICHT, es liefert false
  // (caddyConfig.js:962 read-error, :969 foreign).
  caddyConfig.syncToCaddy = async () => false;
  const res = await put({ email: 'me@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.warning, 'settings.acme_email.push_failed');
  assert.equal(settings.get('caddy.acme_email'), 'me@example.com');
});

test('the push runs even when the value is unchanged (retry after a failed push)', async () => {
  let calls = 0;
  caddyConfig.syncToCaddy = async () => { calls += 1; };
  settings.set('caddy.acme_email', 'me@example.com');
  await put({ email: 'me@example.com' });
  assert.equal(calls, 1, 'ein Retry mit demselben Wert muss erneut pushen');
});

test('an API token cannot write the ACME contact address', async () => {
  const tokens = require('../src/services/tokens');
  const { rawToken } = tokens.create({ name: 'acme-tok', scopes: ['settings'] }, '127.0.0.1');
  settings.set('caddy.acme_email', 'keep@example.com');
  // Frische Anfrage OHNE Session-Cookie — requireAuth prüft die Session zuerst.
  const res = await supertest(ctx.app)
    .put('/api/v1/settings/acme-email')
    .set('X-Api-Token', rawToken)
    .send({ email: 'attacker@example.com' });
  assert.equal(res.status, 403);
  assert.equal(settings.get('caddy.acme_email'), 'keep@example.com');
});

test('a token cannot slip past the guard with a trailing slash or different casing', async () => {
  // Express: strict:false/caseSensitive:false — diese Pfade treffen dieselbe Route.
  const tokens = require('../src/services/tokens');
  const { rawToken } = tokens.create({ name: 'acme-tok-variants', scopes: ['settings'] }, '127.0.0.1');
  for (const path of ['/api/v1/settings/acme-email/', '/api/v1/settings/ACME-EMAIL']) {
    settings.set('caddy.acme_email', 'keep@example.com');
    const res = await supertest(ctx.app)
      .put(path)
      .set('X-Api-Token', rawToken)
      .send({ email: 'attacker@example.com' });
    assert.equal(res.status, 403, `${path} ergab ${res.status}`);
    assert.equal(settings.get('caddy.acme_email'), 'keep@example.com', `${path} hat geschrieben`);
  }
});

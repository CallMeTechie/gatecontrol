'use strict';

// Settings → Lizenz: upload / remove of the signed eol.json
// (POST/DELETE /api/v1/license/eol), the "Produkt eingestellt" card, the
// offline line with the fallback date and the waiting entries.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const JWK = { kty: 'OKP', crv: 'Ed25519', kid: 'key-a', x: publicKey.export({ format: 'jwk' }).x };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signEd(payload, key = privateKey) {
  const h = b64({ typ: 'JWT', alg: 'EdDSA', kid: 'key-a' });
  const p = b64(payload);
  return `${h}.${p}.${crypto.sign(null, Buffer.from(h + '.' + p), key).toString('base64url')}`;
}
const eolFile = (over = {}, key) => JSON.stringify({ v: 1, product: 'gatecontrol', token: signEd({
  iss: 'callmetechie.de', kind: 'eol', v: 1, product: 'gatecontrol', scope: 'lifetime', iat: Math.floor(Date.now() / 1000) - 60,
  message: { de: 'Danke für alles.', en: 'Thanks for everything.' }, ...over,
}, key) });

let agent, license, config;

before(async () => {
  await setup();
  agent = getAgent();
  license = require('../src/services/license');
  config = require('../config/default');
  config.license.pubkeys = JSON.stringify({ keys: [JWK] });
  config.license.eolUrl = '';
  config.license.eolFile = '';
});
after(() => { license._applyLicenseForTest(null); config.license.pubkeys = ''; teardown(); });
beforeEach(async () => {
  license._resetV2ForTest();
  license._applyLicenseForTest(null);
  await new Promise((r) => setTimeout(r, 0));
});

function section(html) {
  const a = html.indexOf('data-section="lizenz" aria-labelledby');
  return html.slice(a, html.indexOf('data-section="gefahr" aria-labelledby', a));
}

test('a forged file is rejected with 400 and nothing is stored', async () => {
  const r = await agent.post('/api/v1/license/eol').set('X-CSRF-Token', getCsrf()).send({ content: eolFile({}, other.privateKey) });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'signature');
  assert.equal(require('../src/services/settings').get('license.eol', ''), '');
  const bad = await agent.post('/api/v1/license/eol').set('X-CSRF-Token', getCsrf()).send({ content: 42 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'malformed');
});

test('a valid file is taken over, shown, and can be removed', async () => {
  const r = await agent.post('/api/v1/license/eol').set('X-CSRF-Token', getCsrf()).send({ content: eolFile({ scope: 'all' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.eol.scope, 'all');
  assert.equal(r.body.eol.source, 'upload');

  const page = section(withoutScripts((await agent.get('/settings').expect(200)).text));
  assert.match(page, /id="st-lic-eol"[^>]*data-active="1"/);
  assert.match(page, /data-scope="all"/);
  assert.ok(page.includes('Produkt eingestellt – keine Updates mehr') || page.includes('Product discontinued – no more updates'), page);
  assert.ok(page.includes('Danke für alles.') || page.includes('Thanks for everything.'));
  assert.match(page, /id="st-lic-eol-remove"/);
  assert.doesNotMatch(page, /st\.lic\.[a-z_]+/, 'no raw i18n keys');

  const d = await agent.delete('/api/v1/license/eol').set('X-CSRF-Token', getCsrf());
  assert.equal(d.status, 200);
  assert.equal(d.body.eol, null);
  const after = section(withoutScripts((await agent.get('/settings').expect(200)).text));
  assert.match(after, /id="st-lic-eol"[^>]*data-active="0"/);
  assert.match(after, /id="st-lic-eol-none"/);
});

test('offline grace: the page says until when, without raw keys', async () => {
  const fallbackAt = new Date(Date.now() + 4 * 86400 * 1000).toISOString();
  license._applyLicenseForTest({
    plan: 'lifetime', features: { webhooks: true }, verification: 'signed_offline',
    offline: { last_ok_at: new Date(Date.now() - 10 * 86400 * 1000).toISOString(), fallback_at: fallbackAt },
  });
  const page = section(withoutScripts((await agent.get('/settings').expect(200)).text));
  assert.match(page, /id="st-lic-offline"[^>]*data-days-left="4"/);
  const d = fallbackAt.slice(0, 10).split('-');
  assert.ok(page.includes(`${d[2]}.${d[1]}.${d[0]}`) || page.includes(fallbackAt.slice(0, 10)), page);
  assert.doesNotMatch(page, /st\.lic\.[a-z_]+/);
  const api = await agent.get('/api/v1/license');
  assert.equal(api.body.offline.days_left, 4);
});

test('entries switched off by the licence are counted on the page', async () => {
  const { getDb } = require('../src/db/connection');
  getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, license_disabled) VALUES ('waiting', 'pk-waiting', '10.8.0.99/32', 0, 1)").run();
  try {
    const page = section(withoutScripts((await agent.get('/settings').expect(200)).text));
    assert.match(page, /id="st-lic-disabled"/);
    assert.ok(/1 Peers|1 peers/.test(page), page.slice(0, 400));
  } finally {
    getDb().prepare("DELETE FROM peers WHERE name = 'waiting'").run();
  }
});

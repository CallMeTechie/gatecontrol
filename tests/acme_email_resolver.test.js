'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let caddyConfig, settings, config;

before(async () => {
  await setup();
  caddyConfig = require('../src/services/caddyConfig');
  settings = require('../src/services/settings');
  config = require('../config/default');
});
after(async () => { await teardown(); });
beforeEach(() => {
  settings.set('caddy.acme_email', '');
  settings.set('portal.base_domain', '');
  config.caddy.email = '';
});

test('the stored setting wins over the environment', () => {
  config.caddy.email = 'env@example.com';
  settings.set('caddy.acme_email', 'db@example.com');
  assert.equal(caddyConfig.effectiveAcmeEmail(), 'db@example.com');
});

test('an empty setting falls back to the environment', () => {
  config.caddy.email = 'env@example.com';
  assert.equal(caddyConfig.effectiveAcmeEmail(), 'env@example.com');
});

test('both empty yields an empty string', () => {
  assert.equal(caddyConfig.effectiveAcmeEmail(), '');
});

test('the stored value is trimmed', () => {
  settings.set('caddy.acme_email', '  db@example.com  ');
  assert.equal(caddyConfig.effectiveAcmeEmail(), 'db@example.com');
});

test('a never-written key behaves exactly like an empty one', () => {
  const { getDb } = require('../src/db/connection');
  getDb().prepare('DELETE FROM settings WHERE key = ?').run('caddy.acme_email');
  config.caddy.email = 'env@example.com';
  assert.equal(caddyConfig.effectiveAcmeEmail(), 'env@example.com');
});

function makePortalPublic() {
  const { getDb } = require('../src/db/connection');
  getDb().prepare("INSERT OR IGNORE INTO domains (domain, status) VALUES ('example.com','verified')").run();
  settings.set('portal.base_domain', 'example.com');
  settings.set('portal.prefix', 'home');
}
function acmeEmailsIn(cfg) {
  return ((((cfg.apps || {}).tls || {}).automation || {}).policies || [])
    .flatMap((p) => (p.issuers || []).map((i) => i.email)).filter(Boolean);
}

test('the resolved address reaches the built caddy config', async () => {
  makePortalPublic();
  settings.set('caddy.acme_email', 'db@example.com');
  const cfg = await caddyConfig.buildCaddyConfig();
  assert.ok(acmeEmailsIn(cfg).includes('db@example.com'), JSON.stringify((cfg.apps || {}).tls));
});

test('an installation that never wrote the key still gets the .env address', async () => {
  // Erfolgskriterium 7: Bestandsinstallationen behalten ihre apps.tls-Policies.
  const { getDb } = require('../src/db/connection');
  getDb().prepare('DELETE FROM settings WHERE key = ?').run('caddy.acme_email');
  makePortalPublic();
  config.caddy.email = 'env@example.com';
  const cfg = await caddyConfig.buildCaddyConfig();
  assert.ok(acmeEmailsIn(cfg).includes('env@example.com'), 'Bestandsinstallation verlor ihre .env-Adresse');
});

test('without any address there is no tls block at all (unchanged behaviour)', async () => {
  // beforeEach hat portal.base_domain geleert -> homeHost ist wieder intern.
  const cfg = await caddyConfig.buildCaddyConfig();
  assert.ok(!cfg.apps || !cfg.apps.tls, 'apps.tls darf ohne Adresse gar nicht existieren');
});

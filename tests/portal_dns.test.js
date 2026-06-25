'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-portal-dns-'));
process.env.GC_DB_PATH = path.join(tmpDir, 'd.db');
process.env.GC_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.GC_DNS_HOSTS_FILE = path.join(tmpDir, 'peers.hosts');
process.env.GC_DNS_DOMAIN = 'gc.internal';
process.env.GC_WG_GATEWAY_IP = '10.8.0.1';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let dns, settings;
beforeEach(async () => { await setup(); dns = require('../src/services/dns'); settings = require('../src/services/settings'); });
afterEach(teardown);

test('publishes internal default home host by default', () => {
  assert.match(dns.renderHostsContent(), /10\.8\.0\.1\thome\.gc\.internal/);
});
test('publishes the configured public portal host -> gateway IP', () => {
  settings.set('portal.base_domain', 'domaincaster.com');
  settings.set('portal.prefix', 'home');
  const c = dns.renderHostsContent();
  assert.match(c, /10\.8\.0\.1\thome\.domaincaster\.com/);
  assert.doesNotMatch(c, /home\.gc\.internal/);   // old entry gone
});

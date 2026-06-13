'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let pihole, piholeConfig;
beforeEach(async () => { await setup(); pihole = require('../src/services/pihole'); piholeConfig = require('../src/services/piholeConfig'); });
afterEach(teardown);

test('applyDnsChain is a no-op when disabled and does not throw', () => {
  piholeConfig.save({ enabled: false, instances: [] });
  assert.doesNotThrow(() => pihole.applyDnsChain());
});

test('dns.reloadDnsmasq is exported and does not throw when dnsmasq absent', () => {
  const dns = require('../src/services/dns');
  assert.equal(typeof dns.reloadDnsmasq, 'function');
  assert.doesNotThrow(() => dns.reloadDnsmasq());
});

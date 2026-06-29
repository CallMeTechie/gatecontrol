'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(async () => { await teardown(); });

test('portalConfig exposes widgets.smarthome (default true)', () => {
  const portalConfig = require('../src/services/portalConfig');
  assert.equal(typeof portalConfig().widgets.smarthome, 'boolean');
  assert.equal(portalConfig().widgets.smarthome, true);
});

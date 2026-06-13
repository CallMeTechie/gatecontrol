'use strict';

const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let injectLicense;
let license;

before(async () => {
  await setup();
  injectLicense = require('../src/middleware/license').injectLicense;
  license = require('../src/services/license');
});

after(() => teardown());

function runMiddleware(req, res) {
  return new Promise((resolve, reject) => {
    injectLicense(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

describe('pihole capability flag in res.locals.license.features', () => {
  test('features.pihole.available is always true', async () => {
    const res = { locals: {} };
    await runMiddleware({}, res);
    assert.equal(res.locals.license.features.pihole.available, true);
  });

  test('features.pihole.licensed is false when pihole_integration not in license', async () => {
    license._overrideForTest({ pihole_integration: false });
    const res = { locals: {} };
    await runMiddleware({}, res);
    assert.equal(res.locals.license.features.pihole.licensed, false);
  });

  test('features.pihole.licensed is true when pihole_integration is licensed', async () => {
    license._overrideForTest({ pihole_integration: true });
    const res = { locals: {} };
    await runMiddleware({}, res);
    assert.equal(res.locals.license.features.pihole.licensed, true);
    // restore
    license._overrideForTest({ pihole_integration: false });
  });

  test('features.pihole.attribution key is present (from pihole cache)', async () => {
    const res = { locals: {} };
    await runMiddleware({}, res);
    assert.ok('attribution' in res.locals.license.features.pihole,
      'features.pihole must expose attribution from pihole.getCache()');
  });

  test('features.pihole does not mutate the license service cachedFeatures', async () => {
    const res = { locals: {} };
    await runMiddleware({}, res);
    const rawFeatures = license.getFeatures();
    assert.equal(rawFeatures.pihole, undefined,
      'adding pihole to res.locals must not mutate the license service cache');
  });
});

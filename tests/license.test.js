const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('License Service', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-license-'));
  const tokenPath = path.join(tmpDir, '.license-token');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Community mode (no license key)', () => {
    let license;

    before(async () => {
      delete process.env.GC_LICENSE_KEY;
      delete process.env.GC_LICENSE_SIGNING_KEY;
      delete require.cache[require.resolve('../src/services/license')];
      license = require('../src/services/license');
      await license.validateLicense();
    });

    it('should return community plan', () => {
      assert.equal(license.getPlan(), 'community');
    });

    it('should have community feature limits', () => {
      const features = license.getFeatures();
      assert.equal(features.vpn_peers, 5);
      assert.equal(features.http_routes, 3);
      assert.equal(features.l4_routes, 0);
    });

    it('should have compression enabled (community feature)', () => {
      assert.equal(license.hasFeature('compression'), true);
    });

    it('should have webhooks disabled', () => {
      assert.equal(license.hasFeature('webhooks'), false);
    });

    it('should report correct limits', () => {
      assert.equal(license.getFeatureLimit('vpn_peers'), 5);
      assert.equal(license.getFeatureLimit('http_routes'), 3);
      assert.equal(license.getFeatureLimit('l4_routes'), 0);
    });

    it('should check isWithinLimit correctly', () => {
      assert.equal(license.isWithinLimit('vpn_peers', 3), true);
      assert.equal(license.isWithinLimit('vpn_peers', 5), false);
      assert.equal(license.isWithinLimit('vpn_peers', 6), false);
      assert.equal(license.isWithinLimit('l4_routes', 0), false);
    });

    it('should return license info', () => {
      const info = license.getLicenseInfo();
      assert.equal(info.plan, 'community');
      assert.equal(info.valid, true);
      assert.equal(info.features.vpn_peers, 5);
    });
  });

  describe('Hardware fingerprint', () => {
    it('should return a 64-char hex string', () => {
      const license = require('../src/services/license');
      const fp = license._getHardwareFingerprint();
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it('should be stable across calls', () => {
      const license = require('../src/services/license');
      const fp1 = license._getHardwareFingerprint();
      const fp2 = license._getHardwareFingerprint();
      assert.equal(fp1, fp2);
    });
  });
});

describe('License API Integration', () => {
  const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
  const license = require('../src/services/license');

  before(async () => {
    await setup();
  });

  after(() => {
    teardown();
  });

  describe('GET /api/v1/license', () => {
    it('should return community plan info', async () => {
      const agent = getAgent();
      const res = await agent.get('/api/v1/license').expect(200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.plan, 'community');
      assert.equal(res.body.valid, true);
      assert.ok(res.body.features, 'should include features');
    });
  });

  describe('POST /api/v1/license/activate', () => {
    it('should return 400 when license key is missing', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/license/activate')
        .set('x-csrf-token', csrf)
        .send({ signing_key: 'some-key' })
        .expect(400);
      assert.equal(res.body.ok, false);
    });
  });

  describe('Feature guard — webhooks blocked in community mode', () => {
    let savedFeatures;

    before(() => {
      // Save current (unlocked) features and reset to community defaults
      savedFeatures = license.getFeatures();
      license._overrideForTest({ ...license.COMMUNITY_FALLBACK });
    });

    after(() => {
      // Restore unlocked features for other tests
      license._overrideForTest(savedFeatures);
    });

    it('should return 403 when creating a webhook in community mode', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/webhooks')
        .set('x-csrf-token', csrf)
        .send({ url: 'https://example.com/hook', events: ['peer.created'] })
        .expect(403);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.feature, 'webhooks');
      assert.ok(res.body.upgrade_url, 'should include upgrade URL');
    });
  });
});

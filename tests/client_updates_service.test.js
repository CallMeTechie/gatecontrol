'use strict';

// services/clientUpdates: version parsing, policy validation, per-peer
// channel, version recording (throttled) and the version overview.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let cu;
let getDb;

function seedPeer(name, extra = {}) {
  const db = getDb();
  const id = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES (?, ?, '10.8.0.9/32', 1)")
    .run(name, `PUB_${name}_${crypto.randomBytes(4).toString('hex')}=`).lastInsertRowid;
  for (const [k, v] of Object.entries(extra)) {
    db.prepare(`UPDATE peers SET ${k} = ? WHERE id = ?`).run(v, id);
  }
  return id;
}

before(async () => {
  await setup();
  cu = require('../src/services/clientUpdates');
  getDb = require('../src/db/connection').getDb;
});
after(() => teardown());

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key LIKE 'client_update.%'").run();
  db.prepare('DELETE FROM peers').run();
  cu._resetForTest();
});

describe('version helpers', () => {
  it('parses plain, v-prefixed and suffixed versions', () => {
    assert.deepEqual(cu.parseVersion('1.22.3'), [1, 22, 3]);
    assert.deepEqual(cu.parseVersion('v2.0.10'), [2, 0, 10]);
    assert.deepEqual(cu.parseVersion('1.24.0-beta.1'), [1, 24, 0]);
    assert.equal(cu.parseVersion('1.2'), null);
    assert.equal(cu.parseVersion('abc'), null);
    assert.equal(cu.parseVersion(null), null);
    assert.equal(cu.parseVersion('1.2.3; DROP TABLE'), null);
  });

  it('compares numerically, not lexically', () => {
    assert.equal(cu.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(cu.compareVersions('1.9.9', '1.10.0'), -1);
    assert.equal(cu.compareVersions('v1.2.3', '1.2.3'), 0);
    assert.equal(cu.compareVersions('x', '1.2.3'), null);
  });

  it('normalises reported versions, products and platforms', () => {
    assert.equal(cu.normalizeReportedVersion(' v1.22.3 '), '1.22.3');
    assert.equal(cu.normalizeReportedVersion('1.22.3<script>'), null);
    assert.equal(cu.normalizeReportedVersion('9'.repeat(60)), null);
    assert.equal(cu.normalizeProduct('GateControl-Pro'), 'pro');
    assert.equal(cu.normalizeProduct('community'), 'community');
    assert.equal(cu.normalizeProduct('android'), 'android');
    assert.equal(cu.normalizeProduct('evil'), null);
    assert.equal(cu.normalizePlatform('win32'), 'windows');
    assert.equal(cu.normalizePlatform('Android'), 'android');
    assert.equal(cu.normalizePlatform('<b>'), null);
  });
});

describe('policy', () => {
  it('defaults to stable and no minimum versions', () => {
    assert.deepEqual(cu.getPolicy(), { defaultChannel: 'stable', minVersions: { pro: null, community: null } });
  });

  it('validates and saves channel + minimum versions, reporting only real changes', () => {
    const r = cu.validatePolicyInput({ default_channel: 'beta', min_versions: { pro: 'v1.22.0', community: '' } });
    assert.equal(r.error, undefined);
    assert.deepEqual(Object.keys(r.changes).sort(), ['default_channel', 'min_version_pro']);
    cu.savePolicy(r.next);
    assert.deepEqual(cu.getPolicy(), { defaultChannel: 'beta', minVersions: { pro: '1.22.0', community: null } });

    const again = cu.validatePolicyInput({ default_channel: 'beta', min_versions: { pro: '1.22.0' } });
    assert.deepEqual(again.changes, {});

    const cleared = cu.validatePolicyInput({ min_versions: { pro: null } });
    assert.deepEqual(cleared.changes, { min_version_pro: { from: '1.22.0', to: null } });
  });

  it('rejects invalid input', () => {
    assert.equal(cu.validatePolicyInput({ default_channel: 'nightly' }).error, 'invalid_channel');
    assert.equal(cu.validatePolicyInput({ default_channel: ['beta'] }).error, 'invalid_channel');
    assert.equal(cu.validatePolicyInput({ min_versions: { pro: '1.2' } }).error, 'invalid_min_version');
    assert.equal(cu.validatePolicyInput({ min_versions: { pro: '1.2.3-beta' } }).error, 'invalid_min_version');
    assert.equal(cu.validatePolicyInput({ min_versions: { pro: 123 } }).error, 'invalid_min_version');
    assert.equal(cu.validatePolicyInput({ min_versions: 'x' }).error, 'invalid_min_version');
    assert.equal(cu.validatePolicyInput({ min_versions: { android: '1.0.0' } }).error, 'invalid_product');
  });

  it('ignores a tampered settings value', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.default_channel', 'nightly')").run();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.min_version.pro', 'garbage')").run();
    assert.deepEqual(cu.getPolicy(), { defaultChannel: 'stable', minVersions: { pro: null, community: null } });
  });

  it('effective channel: peer override wins, NULL/unknown falls back to the default', () => {
    const policy = { defaultChannel: 'beta', minVersions: { pro: null, community: null } };
    assert.equal(cu.effectiveChannel({ update_channel: null }, policy), 'beta');
    assert.equal(cu.effectiveChannel({ update_channel: 'stable' }, policy), 'stable');
    assert.equal(cu.effectiveChannel({ update_channel: 'bogus' }, policy), 'beta');
  });

  it('below minimum only for Windows products with a minimum set', () => {
    const policy = { defaultChannel: 'stable', minVersions: { pro: '1.22.0', community: null } };
    assert.equal(cu.isBelowMinimum('pro', '1.21.9', policy), true);
    assert.equal(cu.isBelowMinimum('pro', '1.22.0', policy), false);
    assert.equal(cu.isBelowMinimum('community', '0.0.1', policy), false);
    assert.equal(cu.isBelowMinimum('android', '0.0.1', policy), false);
    assert.equal(cu.isBelowMinimum('pro', 'garbage', policy), false);
  });
});

describe('per-peer channel', () => {
  it('sets, reports changes and clears', () => {
    const id = seedPeer('ch');
    assert.deepEqual(cu.setPeerChannel(id, 'beta'), { changed: true, from: null, to: 'beta' });
    assert.deepEqual(cu.setPeerChannel(id, 'beta'), { changed: false, from: 'beta', to: 'beta' });
    assert.deepEqual(cu.setPeerChannel(id, ''), { changed: true, from: 'beta', to: null });
    assert.throws(() => cu.setPeerChannel(id, 'nightly'), /invalid channel/);
    assert.throws(() => cu.setPeerChannel(999999, 'beta'), /not found/);
  });
});

describe('version recording', () => {
  it('stores version/product/platform and keeps a known product on product-less reports', () => {
    const id = seedPeer('rec');
    assert.equal(cu.recordClientVersion(id, { version: '1.22.3', product: 'pro', platform: 'windows' }, 1000), true);
    let row = getDb().prepare('SELECT client_version, client_product, client_platform, client_seen_at FROM peers WHERE id = ?').get(id);
    assert.equal(row.client_version, '1.22.3');
    assert.equal(row.client_product, 'pro');
    assert.equal(row.client_platform, 'windows');
    assert.ok(row.client_seen_at);

    // heartbeat of the same app: no product header → product stays 'pro'
    assert.equal(cu.recordClientVersion(id, { version: '1.22.4', platform: 'windows' }, 2000), true);
    row = getDb().prepare('SELECT client_version, client_product FROM peers WHERE id = ?').get(id);
    assert.deepEqual({ ...row }, { client_version: '1.22.4', client_product: 'pro' });
  });

  it('throttles unchanged reports to one write per 5 minutes', () => {
    const id = seedPeer('thr');
    assert.equal(cu.recordClientVersion(id, { version: '1.0.0', platform: 'android' }, 10_000), true);
    assert.equal(cu.recordClientVersion(id, { version: '1.0.0', platform: 'android' }, 20_000), false);
    assert.equal(cu.recordClientVersion(id, { version: '1.0.0', platform: 'android' }, 10_000 + 5 * 60 * 1000 + 1), true);
    const row = getDb().prepare('SELECT client_product, client_platform FROM peers WHERE id = ?').get(id);
    assert.deepEqual({ ...row }, { client_product: 'android', client_platform: 'android' });
  });

  it('ignores invalid input', () => {
    const id = seedPeer('bad');
    assert.equal(cu.recordClientVersion(id, { version: 'not-a-version' }), false);
    assert.equal(cu.recordClientVersion(id, {}), false);
    assert.equal(cu.recordClientVersion('x', { version: '1.0.0' }), false);
    assert.equal(getDb().prepare('SELECT client_version FROM peers WHERE id = ?').get(id).client_version, null);
  });
});

describe('overview', () => {
  it('counts per product and version, newest first, and flags below-minimum', () => {
    seedPeer('a', { client_version: '1.22.0', client_product: 'pro' });
    seedPeer('b', { client_version: '1.22.0', client_product: 'pro' });
    seedPeer('c', { client_version: '1.9.0', client_product: 'pro' });
    seedPeer('d', { client_version: '1.10.0', client_product: 'pro' });
    seedPeer('e', { client_version: '1.30.1', client_product: 'community' });
    seedPeer('f', { client_version: '1.13.3', client_product: 'android' });
    seedPeer('g');
    const policy = { defaultChannel: 'stable', minVersions: { pro: '1.10.0', community: null } };
    const ov = cu.getOverview(policy);
    assert.deepEqual(ov.products.map(p => p.product), ['pro', 'community', 'android']);
    const pro = ov.products[0];
    assert.deepEqual(pro.versions.map(v => [v.version, v.count, v.below_min]), [
      ['1.22.0', 2, false], ['1.10.0', 1, false], ['1.9.0', 1, true],
    ]);
    assert.equal(pro.total, 4);
    assert.equal(pro.below_min, 1);
    assert.equal(pro.min_version, '1.10.0');
    assert.equal(ov.products[2].min_version, null);
    assert.equal(ov.unreported, 1);
  });

  it('decoratePeer adds effective channel and below-minimum flag', () => {
    const policy = { defaultChannel: 'stable', minVersions: { pro: '2.0.0', community: null } };
    const p = cu.decoratePeer({ id: 1, update_channel: 'beta', client_product: 'pro', client_version: '1.0.0' }, policy);
    assert.equal(p.update_channel_effective, 'beta');
    assert.equal(p.client_below_min, true);
    assert.equal(p.client_min_version, '2.0.0');
  });
});

'use strict';

// MQTT device accounts (services/edge/mqtt.js): the mosquitto `$7$` hash
// against a vector made by mosquitto_passwd 2.0.18, the ACL rules, and that a
// password is never stored.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const mqtt = require('../src/services/edge/mqtt');

// `mosquitto_passwd -c -b pw.txt sensor1 'S3cret!pass'` (mosquitto 2.0.18)
const VECTOR = { user: 'sensor1', password: 'S3cret!pass',
  hash: '$7$101$3Iqjx/htwJpqDHlv$Oe5zzF2BA/Gjl+nAFubLkMY0srerchv7ZzYOae4IlENE0dTrZcTgHsI1DyBj3GcpvY7Ss35P0im/BZ1itw4WYg==' };

describe('mosquitto password hash', () => {
  it('reproduces mosquitto_passwd output for the same salt', () => {
    const salt = Buffer.from('3Iqjx/htwJpqDHlv', 'base64');
    assert.equal(mqtt.hashPassword(VECTOR.password, { salt }), VECTOR.hash);
  });

  it('verifies the mosquitto vector and rejects a wrong password', () => {
    assert.equal(mqtt.verifyPassword(VECTOR.password, VECTOR.hash), true);
    assert.equal(mqtt.verifyPassword('S3cret!pasS', VECTOR.hash), false);
    assert.equal(mqtt.verifyPassword(VECTOR.password, '$6$abc$def'), false);
  });

  it('format: $7$101$<16 base64 = 12 bytes salt>$<88 base64 = 64 bytes>, fresh salt each time', () => {
    const a = mqtt.hashPassword('x');
    const b = mqtt.hashPassword('x');
    assert.match(a, /^\$7\$101\$[A-Za-z0-9+/]{16}\$[A-Za-z0-9+/]{86}==$/);
    assert.notEqual(a, b);
    assert.equal(mqtt.verifyPassword('x', a), true);
  });
});

describe('ACL rules', () => {
  it('normalises strings and objects, refuses wildcard roots, $SYS and bad access', () => {
    assert.deepEqual(mqtt.normaliseAcl(['shellies/a/#', { topic: 'cmd/a', access: 'read' }]),
      [{ access: 'readwrite', topic: 'shellies/a/#' }, { access: 'read', topic: 'cmd/a' }]);
    for (const bad of [['#'], ['+/x'], ['$SYS/#'], [{ topic: 'a', access: 'all' }], ['a', 'a']]) {
      assert.throws(() => mqtt.normaliseAcl(bad), (e) => e.code === 'invalid', JSON.stringify(bad));
    }
  });

  it('plugin topics: only below the manifest topics', () => {
    assert.equal(mqtt.topicsAllowed(['shellies/#'], [{ topic: 'shellies/kitchen/#' }]), true);
    assert.equal(mqtt.topicsAllowed(['shellies/#'], [{ topic: 'shellies/kitchen/#' }, { topic: 'tasmota/#' }]), false);
  });
});

describe('accounts', () => {
  let peerId;
  before(async () => {
    require('../src/db/migrations').runMigrations();
    require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
    const gw = await require('../src/services/gateways').createGateway({ name: 'mqtt-gw' });
    peerId = gw.peer.id;
  });

  it('create: password once, only the hash in the database, default ACL', () => {
    const r = mqtt.create(peerId, { username: 'lamp-1', label: 'Lamp' });
    assert.match(r.password, /^[A-Za-z0-9_-]{24}$/);
    assert.deepEqual(r.account.acl, [{ access: 'readwrite', topic: 'devices/lamp-1/#' }]);
    const row = require('../src/db/connection').getDb().prepare('SELECT * FROM mqtt_accounts WHERE id = ?').get(r.account.id);
    assert.equal(JSON.stringify(row).includes(r.password), false, 'the password is not stored');
    assert.equal(mqtt.verifyPassword(r.password, row.hash), true);
    assert.equal('hash' in r.account, false, 'the account view has no hash');
  });

  it('vendor prefix, duplicates, reserved names', () => {
    const r = mqtt.create(peerId, { username: 'shelly1', vendorPrefix: 'shellies' });
    assert.deepEqual(r.account.acl, [{ access: 'readwrite', topic: 'shellies/shelly1/#' }]);
    assert.throws(() => mqtt.create(peerId, { username: 'shelly1' }), (e) => e.code === 'exists');
    assert.throws(() => mqtt.create(peerId, { username: 'gc-edge' }), (e) => e.code === 'invalid');
    assert.throws(() => mqtt.create(peerId, { username: 'Bad:Name' }), (e) => e.code === 'invalid');
  });

  it('state: unlocked accounts with hash and ACL; locked ones are left out; a new password changes the hash', () => {
    const r = mqtt.create(peerId, { username: 'plug-2' });
    const before = mqtt.forState(peerId).find((a) => a.user === 'plug-2');
    assert.ok(before && before.hash.startsWith('$7$101$'));
    mqtt.setLocked(peerId, r.account.id, true);
    assert.equal(mqtt.forState(peerId).some((a) => a.user === 'plug-2'), false);
    mqtt.setLocked(peerId, r.account.id, false);
    const pw = mqtt.resetPassword(peerId, r.account.id);
    const after = mqtt.forState(peerId).find((a) => a.user === 'plug-2');
    assert.notEqual(after.hash, before.hash);
    assert.equal(mqtt.verifyPassword(pw, after.hash), true);
    assert.equal(mqtt.remove(peerId, r.account.id), true);
    assert.equal(mqtt.forState(peerId).some((a) => a.user === 'plug-2'), false);
  });
});

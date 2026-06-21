// tests/rdp_form_logic.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/js/rdp-form-logic.js');

describe('rdp-form-logic', () => {
  it('defaultPortFor', () => {
    assert.equal(L.defaultPortFor('rdp'), 3389);
    assert.equal(L.defaultPortFor('vnc'), 5900);
    assert.equal(L.defaultPortFor('ssh'), 22);
    assert.equal(L.defaultPortFor('telnet'), 23);
  });
  it('stepsForProtocol: rdp has the real 6 steps; ssh omits experience', () => {
    assert.deepEqual(L.stepsForProtocol('rdp'),
      ['connection','auth','experience','security','wol','access']);
    assert.ok(!L.stepsForProtocol('ssh').includes('experience'));
    for (const p of ['rdp','vnc','ssh','telnet'])
      for (const k of ['connection','auth','wol','access'])
        assert.ok(L.stepsForProtocol(p).includes(k), `${p} missing ${k}`);
  });
  it('stepsForProtocol: browser step inserted before access when browserEnabled', () => {
    const s = L.stepsForProtocol('ssh', { browserEnabled: 1 });
    assert.ok(s.includes('browser'));
    assert.equal(s.indexOf('browser') === s.indexOf('access') - 1, true);
  });
  it('visibleFieldsFor: ssh shows key auth, hides domain/rdp-audio', () => {
    const v = L.visibleFieldsFor('ssh', { browserEnabled: 1 });
    assert.equal(v.ssh_private_key, true);
    assert.equal(v.domain, false);
    assert.equal(v.rdp_disable_audio, false);
  });
  it('visibleFieldsFor: DA-2 gateway hides ALL sftp + audio incl rdp_disable_audio', () => {
    const gw = L.visibleFieldsFor('rdp', { browserEnabled: 1, accessMode: 'gateway', sftpEnabled: 1 });
    assert.equal(gw.sftp_username, false);
    assert.equal(gw.rdp_disable_audio, false);  // M1: audio field gated on internal too
    const internal = L.visibleFieldsFor('rdp', { browserEnabled: 1, accessMode: 'internal', sftpEnabled: 1 });
    assert.equal(internal.sftp_username, true);
    assert.equal(internal.rdp_disable_audio, true);
  });
  it('visibleFieldsFor: credential_mode none suppresses required user/pass', () => {
    const v = L.visibleFieldsFor('rdp', { credentialMode: 'none' });
    assert.equal(v.username_required, false);
    const v2 = L.visibleFieldsFor('rdp', { credentialMode: 'full' });
    assert.equal(v2.username_required, true);
  });
  it('foreignFieldsOnSwitch never includes shared username/password', () => {
    for (const p of ['rdp','vnc','ssh','telnet']) {
      const f = L.foreignFieldsOnSwitch(p);
      assert.ok(!f.includes('username'));
      assert.ok(!f.includes('password'));
    }
    assert.ok(L.foreignFieldsOnSwitch('ssh').includes('domain'));
    assert.ok(L.foreignFieldsOnSwitch('ssh').includes('sftp_username'));   // secondary sftp foreign to ssh
    assert.ok(L.foreignFieldsOnSwitch('telnet').includes('ssh_private_key'));
  });
  it('serializeForm: matrix — switch to ssh/rdp/telnet nulls the right foreign fields', () => {
    const toSsh = L.serializeForm({ protocol: 'ssh', domain: 'D', ssh_private_key: 'K' });
    assert.equal(toSsh.domain, null);
    assert.equal(toSsh.ssh_private_key, 'K');
    const toRdp = L.serializeForm({ protocol: 'rdp', ssh_private_key: 'K', sftp_username: 's' });
    assert.equal(toRdp.ssh_private_key, null);
    assert.equal(toRdp.sftp_username, 's');         // secondary sftp valid for rdp
    const toTel = L.serializeForm({ protocol: 'telnet', sftp_username: 's', ssh_private_key: 'K' });
    assert.equal(toTel.sftp_username, null);
    assert.equal(toTel.ssh_private_key, null);
    // shared username/password must SURVIVE a protocol switch (never nulled as foreign)
    const kept = L.serializeForm({ protocol: 'rdp', username: 'u', password: 'p', ssh_private_key: 'K' });
    assert.equal(kept.username, 'u');
    assert.equal(kept.password, 'p');
    assert.equal(kept.ssh_private_key, null);
  });
  it('hydrateForm: drops *_encrypted, keeps non-sensitive + has_* flags', () => {
    const s = L.hydrateForm({ id: 1, protocol: 'ssh', host: 'h', username_encrypted: 'x',
      has_ssh_private_key: true, sftp_host: '10.0.0.6' });
    assert.equal('username_encrypted' in s, false);
    assert.equal(s.has_ssh_private_key, true);
    assert.equal(s.sftp_host, '10.0.0.6');
  });
});

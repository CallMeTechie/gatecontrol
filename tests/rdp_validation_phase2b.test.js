// tests/rdp_validation_phase2b.test.js — env header before any require
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it } = require('node:test'); const assert = require('node:assert/strict');
const { validatePhase2bRoute } = require('../src/services/rdp');
// validatePhase2bRoute(route, creds) → {field:msg} | null. `route` is the MERGED row; `creds` is the
// plaintext credentials available (from the patch, or decrypted-existing on a browser_enabled flip).

const ssh = { protocol:'ssh', host:'h', access_mode:'internal', browser_enabled:1 };
const rdpGw = { protocol:'rdp', host:'h', access_mode:'gateway', gateway_listen_port:3389, browser_enabled:1 };

describe('validatePhase2bRoute', () => {
  it('ssh without username → error', () => {
    assert.notEqual(validatePhase2bRoute(ssh, { password:'p' }), null);
  });
  it('ssh with neither password nor key → error', () => {
    assert.notEqual(validatePhase2bRoute(ssh, { username:'u' }), null);
  });
  it('ssh with username+password → OK', () => {
    assert.equal(validatePhase2bRoute(ssh, { username:'u', password:'p' }), null);
  });
  it('sftp enabled on gateway route → error (DA-2)', () => {
    assert.notEqual(validatePhase2bRoute({ ...rdpGw, browser_enable_sftp:1, sftp_username:'s' }, { sftp_password:'x' }), null);
  });
  it('vnc audio enabled on gateway route → error (DA-2)', () => {
    assert.notEqual(validatePhase2bRoute({ protocol:'vnc', host:'h', access_mode:'gateway', gateway_listen_port:5900, browser_enabled:1, browser_enable_audio:1, audio_servername:'a' }, {}), null);
  });
  it('rdp+sftp without sftp_username → error', () => {
    assert.notEqual(validatePhase2bRoute({ protocol:'rdp', host:'h', access_mode:'internal', browser_enabled:1, browser_enable_sftp:1 }, { sftp_password:'x' }), null);
  });
  it('non-ASCII credential on a browser_enabled route → error (DA-3)', () => {
    assert.notEqual(validatePhase2bRoute(rdpGw_internal(), { username:'u', password:'pä' }), null);
  });
  it('non-ASCII credential on a native-only route (browser_enabled=0) → OK (no native regression)', () => {
    assert.equal(validatePhase2bRoute({ protocol:'rdp', host:'h', access_mode:'internal', browser_enabled:0 }, { username:'u', password:'pä' }), null);
  });
  it('native username-only ssh route (browser_enabled=0) → OK (no native regression)', () => {
    assert.equal(validatePhase2bRoute({ protocol:'ssh', host:'h', access_mode:'internal', browser_enabled:0 }, { username:'u' }), null);
  });
  it('ssh with username+private key → OK', () => {
    assert.equal(validatePhase2bRoute(ssh, { username:'u', ssh_private_key:'KEY' }), null);
  });
  it('ssh with passphrase but no key → error', () => {
    assert.notEqual(validatePhase2bRoute(ssh, { username:'u', password:'p', ssh_passphrase:'pp' }), null);
  });
  it('ssh with passphrase and key → OK', () => {
    assert.equal(validatePhase2bRoute(ssh, { username:'u', ssh_private_key:'KEY', ssh_passphrase:'pp' }), null);
  });
  it('rdp+sftp on internal with sftp_username+sftp_password → OK', () => {
    assert.equal(validatePhase2bRoute(
      { protocol:'rdp', host:'h', access_mode:'internal', browser_enabled:1, browser_enable_sftp:1, sftp_username:'s' },
      { sftp_password:'sp' }
    ), null);
  });
  it('non-ASCII ssh_private_key on a browser_enabled route → error (DA-3)', () => {
    assert.notEqual(validatePhase2bRoute(ssh, { username:'u', ssh_private_key:'K\xc3\xa9Y' }), null);
  });
});

function rdpGw_internal() { return { protocol:'rdp', host:'h', access_mode:'internal', browser_enabled:1 }; }

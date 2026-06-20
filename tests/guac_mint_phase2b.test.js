// tests/guac_mint_phase2b.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
const license = require('../src/services/license');
const rdpSvc = require('../src/services/rdp');

let agent, csrf, db;
before(async () => {
  const c = await setup(); agent = c.agent; csrf = c.csrfToken; db = getDb();
  license._overrideForTest({ ...license.COMMUNITY_FALLBACK, browser_sessions: true, remote_desktop: true });
});
after(() => { license._overrideForTest({ ...license.COMMUNITY_FALLBACK }); teardown(); });

describe('mint phase2b', () => {
  it('ssh route mints 200 (was 400 in 2a)', async () => {
    const r = await rdpSvc.create({ name: 's1', host: '10.0.0.7', protocol: 'ssh', port: 22, username: 'u', password: 'p' });
    await rdpSvc.update(r.id, { browser_enabled: true });
    const res = await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.token);
  });
  it('telnet route mints 200', async () => {
    const r = await rdpSvc.create({ name: 't1', host: '10.0.0.8', protocol: 'telnet', port: 23 });
    await rdpSvc.update(r.id, { browser_enabled: true });
    await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(200);
  });
  it('broken OPTIONAL sftp cred on an SFTP-disabled rdp route still mints 200 (DA-5 scoping)', async () => {
    const r = await rdpSvc.create({ name: 'b1', host: '10.0.0.5', protocol: 'rdp', port: 3389, username: 'u', password: 'p' });
    await rdpSvc.update(r.id, { browser_enabled: true });
    // corrupt an OPTIONAL (unused) encrypted field directly; browser_enable_sftp stays 0
    db.prepare("UPDATE rdp_routes SET sftp_password_encrypted='not-valid-ciphertext' WHERE id=?").run(r.id);
    await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(200);
  });
  it('broken REQUIRED ssh key → 409 (v2.1 #1: configured-ness branch, not decrypted value)', async () => {
    const r = await rdpSvc.create({ name: 'b2', host: '10.0.0.7', protocol: 'ssh', port: 22, username: 'u', ssh_private_key: 'KEYBODY' });
    await rdpSvc.update(r.id, { browser_enabled: true });
    db.prepare("UPDATE rdp_routes SET ssh_private_key_encrypted='not-valid-ciphertext' WHERE id=?").run(r.id);
    await agent.post(`/api/v1/client/rdp/${r.id}/browser-session`).set('X-CSRF-Token', csrf).expect(409);
  });
});

'use strict';

// Trusting a NAS's own certificate without a PEM file (docs/storage-targets.md
// "Certificates", services/storageTargets/trust.js): a small https WebDAV
// server of this test with a self-signed certificate for "synology", like a
// Synology's default one. Through a VPN device the first contact remembers
// it; "Direkt zur Adresse" never does — there "Diesem Gerät vertrauen"
// (POST /:id/trust) stores exactly the certificate shown. A renewed
// certificate is refused with tls_changed until "Neues Zertifikat
// vertrauen". Also: the verdicts of trust.js, and SMB encryption
// ("Verbindung verschlüsseln (SMB3)") through an smbclient shim.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// smbclient shim (drivers/smb.js reads GC_SMBCLIENT when it is loaded): records argv,
// answers like smbclient — or like one whose server cannot encrypt (file `noenc`)
const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stg-trust-shim-'));
const rec = path.join(shimRoot, 'rec');
fs.mkdirSync(rec);
const shim = path.join(shimRoot, 'smbclient');
fs.writeFileSync(shim, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const rec = ${JSON.stringify(rec)};
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(path.join(rec, String(fs.readdirSync(rec).length).padStart(3, '0') + '.json'), JSON.stringify({ args: process.argv.slice(2), stdin }));
if (fs.existsSync(path.join(rec, '..', 'noenc')) && process.argv.includes('--client-protection=encrypt')) {
  process.stdout.write("Encryption required and server doesn't support SMB3 encryption - failing connect\\ntree connect failed: NT_STATUS_NOT_SUPPORTED\\n");
  process.exit(1);
}
process.exit(0);
`, { mode: 0o755 });
process.env.GC_SMBCLIENT = shim;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { setup, teardown } = require('./helpers/setup');

const NAS = 'nas.heim.example'; // resolves only where a test says so (net._setLookupForTest)
let agent, csrf, db, tmp, certs, srv, gw;

const api = (method, p) => agent[method](p).set('X-CSRF-Token', csrf);
const targets = () => require('../src/services/storageTargets');
const trust = () => require('../src/services/storageTargets/trust');
const net = () => require('../src/services/storageTargets/net');

/** Self-signed certificates for "synology" (the NAS, and the NAS after a renewal), one for NAS itself. */
function makeCerts(dir) {
  const one = (name, cn) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.pem', '-days', '30',
      '-subj', '/CN=' + cn, '-addext', 'subjectAltName=DNS:' + cn], { cwd: dir, stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, name + '.key'), 'utf8'), cert: fs.readFileSync(path.join(dir, name + '.pem'), 'utf8') };
  };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=Heim-CA'], { cwd: dir, stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=synology'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'leaf.cnf'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:synology\n');
  execFileSync('openssl', ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '30', '-extfile', 'leaf.cnf'], { cwd: dir, stdio: 'ignore' });
  const r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { syn: one('syn', 'synology'), renewed: one('renewed', 'synology'), ca: r('ca.pem'), leaf: { key: r('leaf.key'), cert: r('leaf.pem') } };
}
const fpOf = (pem) => new (require('node:crypto').X509Certificate)(pem).fingerprint256.replace(/:/g, '').toLowerCase();

/** A WebDAV server just big enough for the check (Basic gc:pw): PROPFIND, PUT, HEAD, GET with Range, DELETE. */
async function davServer(pair) {
  const files = new Map();
  const seen = [];
  const s = https.createServer({ key: pair.key, cert: pair.cert }, (q, res) => {
    seen.push(q.method);
    if (q.headers.authorization !== 'Basic ' + Buffer.from('gc:pw').toString('base64')) { res.writeHead(401); res.end(); return; }
    const parts = [];
    q.on('data', (c) => parts.push(c));
    q.on('end', () => {
      const p = decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/+$/, '');
      if (q.method === 'PROPFIND') { res.writeHead(207, { 'content-type': 'application/xml' }); res.end('<d:multistatus xmlns:d="DAV:"></d:multistatus>'); return; }
      if (q.method === 'MKCOL') { res.writeHead(405); res.end(); return; }
      if (q.method === 'PUT') { files.set(p, Buffer.concat(parts)); res.writeHead(201); res.end(); return; }
      const f = files.get(p);
      if (q.method === 'DELETE') { files.delete(p); res.writeHead(f ? 204 : 404); res.end(); return; }
      if (!f) { res.writeHead(404); res.end(); return; }
      const r = /^bytes=(\d+)-(\d+)$/.exec(q.headers.range || '');
      if (r && q.method === 'GET') { const part = f.subarray(Number(r[1]), Number(r[2]) + 1); res.writeHead(206, { 'content-length': part.length }); res.end(part); return; }
      res.writeHead(200, { 'content-length': f.length });
      res.end(q.method === 'GET' ? f : undefined);
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, seen, renew: (p) => s.setSecureContext({ key: p.key, cert: p.cert }), close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}

function activity(event) {
  return db.prepare('SELECT message, severity FROM activity_log WHERE event_type = ? ORDER BY id').all(event);
}

before(async () => {
  ({ agent, csrfToken: csrf } = await setup());
  db = require('../src/db/connection').getDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stg-trust-'));
  certs = makeCerts(tmp);
  srv = await davServer(certs.syn);
  gw = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('Home Gateway', 'pk-gw', '127.0.0.1/32', 1, 'gateway')").run().lastInsertRowid);
});
after(async () => {
  net()._setLookupForTest(null);
  if (srv) await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(shimRoot, { recursive: true, force: true });
  teardown();
});

describe('trust.js: the verdicts', () => {
  const diag = (reason, extra = {}) => ({ reason, cert: { names: ['synology'], subject: 'CN=synology', fingerprint: 'ab'.repeat(32) }, chain: [], ...extra });
  it('assess: unknown → untrusted (changed once one is stored); name and dates stay errors; GateControl decrypting is never trusted', () => {
    for (const r of ['self_signed', 'untrusted_ca', 'missing_intermediate', 'untrusted']) {
      assert.equal(trust().assess(diag(r)), 'untrusted', r);
      assert.equal(trust().assess(diag(r), { stored: true }), 'changed', r);
    }
    assert.equal(trust().assess(diag('not_stored'), { stored: true }), 'changed');
    for (const r of ['name', 'expired', 'not_yet_valid']) assert.equal(trust().assess(diag(r)), r);
    assert.equal(trust().assess(diag('self_signed'), { decrypts: true }), 'decrypts');
    assert.equal(trust().assess(diag(null)), null);
    assert.equal(trust().assess({ reason: 'not_tls', cert: null, chain: [] }), null);
    assert.deepEqual(['untrusted', 'changed', 'name', 'expired', 'decrypts'].map(trust().trustable), [true, true, false, false, false]);
  });
  it('autoTrust: only an unknown certificate, nothing stored, never reached before, through a tunnel', () => {
    const ok = { state: 'untrusted', stored: false, seen: false, tunnel: true };
    assert.equal(trust().autoTrust(ok), true);
    for (const [k, v] of [['state', 'changed'], ['state', 'name'], ['stored', true], ['seen', true], ['tunnel', false]]) {
      assert.equal(trust().autoTrust({ ...ok, [k]: v }), false, k + '=' + v);
    }
  });
  it('a tunnel ends in a VPN / LAN / loopback address, never a public one; direct is no tunnel', async () => {
    for (const a of ['10.8.0.8', '192.168.178.20', '127.0.0.1', '100.64.1.2', 'fd00::5']) assert.equal(trust().privateAddress(a), true, a);
    for (const a of ['203.0.113.9', '8.8.8.8', '2001:db8::1', 'nonsense']) assert.equal(trust().privateAddress(a), false, a);
    assert.equal(await trust().tunnelled('host', () => ({ host: '127.0.0.1', port: 443 })), false);
    assert.equal(await trust().tunnelled('peer', () => ({ host: '127.0.0.1', port: 443 })), true);
    assert.equal(await trust().tunnelled('route', () => ({ host: '8.8.8.8', port: 443 })), false);
    assert.equal(await trust().tunnelled('peer', () => { throw new Error('peer off'); }), false);
  });
  it('the device name: the first DNS name, else the common name', () => {
    assert.equal(trust().deviceName({ names: ['192.168.1.10', '*.nas', 'ds218.local'], subject: 'CN=x' }), 'ds218.local');
    assert.equal(trust().deviceName({ names: [], subject: 'CN=synology, O=Synology Inc.' }), 'synology');
  });
});

describe('through a VPN device: remembered on first contact', () => {
  let id;
  it('saving and checking stores the NAS\'s certificate on its own and says so (activity log)', async () => {
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'DS218+', url: `https://${NAS}:5006/GateControl`,
      via: { kind: 'peer', peerId: gw }, port: srv.port, username: 'gc', password: 'pw' }).expect(201);
    id = r.body.target.id;
    assert.equal(r.body.target.tlsCaInfo, null);
    const c = (await api('post', `/api/v1/storage-targets/${id}/check`).send({}).expect(200)).body;
    assert.equal(c.check.ok, true, JSON.stringify(c.check));
    assert.equal(c.check.trusted.auto, true);
    assert.equal(c.check.trusted.cert.device, 'synology');
    assert.equal(c.check.trusted.cert.fingerprint, fpOf(certs.syn.cert));
    assert.equal(c.target.tlsCaInfo.length, 1);
    assert.equal(c.target.tlsCaInfo[0].device, 'synology');
    assert.equal(c.target.tlsCaInfo[0].fingerprint, fpOf(certs.syn.cert));
    assert.match(c.target.tlsCaInfo[0].validTo, /^\d{4}-\d\d-\d\dT/);
    assert.equal(c.target.config.tlsCa.trim(), certs.syn.cert.trim());
    assert.match(activity('storage_target_cert_remembered').pop().message, /DS218\+.*remembered on first contact/);
    // the next check: the stored certificate, nothing new remembered
    const again = (await api('post', `/api/v1/storage-targets/${id}/check`).send({}).expect(200)).body.check;
    assert.equal(again.ok, true);
    assert.equal(again.trusted, undefined);
  });

  it('"Prüfen" before saving hands the certificate back (the dialog keeps it in the field)', async () => {
    const c = (await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', label: 'X', url: `https://${NAS}:5006/GateControl`,
      via: { kind: 'peer', peerId: gw }, port: srv.port, username: 'gc', password: 'pw' }).expect(200)).body.check;
    assert.equal(c.ok, true);
    assert.equal(c.trusted.auto, true);
    assert.equal(c.trusted.cert.pem.trim(), certs.syn.cert.trim());
  });

  it('a renewed certificate is refused with tls_changed — even through the VPN — and logged once', async () => {
    srv.renew(certs.renewed);
    try {
      const c = (await api('post', `/api/v1/storage-targets/${id}/check`).send({}).expect(200)).body;
      assert.equal(c.check.ok, false);
      assert.equal(c.check.error, 'tls_changed');
      assert.equal(c.check.tls.state, 'changed');
      assert.equal(c.check.tls.cert.fingerprint, fpOf(certs.renewed.cert));
      assert.equal(c.check.trusted, undefined);
      assert.equal(c.target.tlsCaInfo[0].fingerprint, fpOf(certs.syn.cert), 'the stored certificate stays');
      assert.match(c.target.check.error, /^tls_changed: /);
      await api('post', `/api/v1/storage-targets/${id}/check`).send({}).expect(200);
      const log = activity('storage_target_cert_changed');
      assert.equal(log.length, 1, 'one entry for one change');
      assert.match(log[0].message, new RegExp(fpOf(certs.renewed.cert)));
      assert.equal(log[0].severity, 'warning');

      // "Neues Zertifikat vertrauen": the fingerprint the page showed — another one is refused
      const wrong = await api('post', `/api/v1/storage-targets/${id}/trust`).send({ fingerprint: fpOf(certs.syn.cert) });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.code, 'cert_mismatch');
      const bad = await api('post', `/api/v1/storage-targets/${id}/trust`).send({ fingerprint: 'nope' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.field, 'fingerprint');
      const ok = (await api('post', `/api/v1/storage-targets/${id}/trust`).send({ fingerprint: fpOf(certs.renewed.cert).toUpperCase().match(/../g).join(':') }).expect(200)).body;
      assert.equal(ok.replaced, true);
      assert.equal(ok.check.ok, true, JSON.stringify(ok.check));
      assert.equal(ok.target.tlsCaInfo[0].fingerprint, fpOf(certs.renewed.cert));
      assert.match(activity('storage_target_cert_trusted').pop().message, /new certificate of the NAS trusted/);
    } finally { srv.renew(certs.syn); }
  });

  it('a target reached before (its last check passed) is never trusted on its own', async () => {
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'Seen', url: `https://${NAS}:5006/Seen`,
      via: { kind: 'peer', peerId: gw }, port: srv.port, username: 'gc', password: 'pw' }).expect(201);
    db.prepare("UPDATE storage_targets SET checked_at = datetime('now'), check_ok = 1 WHERE id = ?").run(r.body.target.id);
    const c = (await api('post', `/api/v1/storage-targets/${r.body.target.id}/check`).send({}).expect(200)).body.check;
    assert.equal(c.ok, false);
    assert.equal(c.error, 'tls');
    assert.equal(c.tls.state, 'untrusted');
    assert.equal(c.trusted, undefined);
  });
});

describe('"Direkt zur Adresse": never on its own, "Diesem Gerät vertrauen" is the click', () => {
  before(() => net()._setLookupForTest(async (h) => (h === NAS ? [{ address: '127.0.0.1', family: 4 }] : [])));
  after(() => net()._setLookupForTest(null));

  it('the check shows the plain card data; trusting stores exactly that certificate', async () => {
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'Direkt', url: `https://${NAS}:${srv.port}/GateControl`, username: 'gc', password: 'pw' }).expect(201);
    const id = r.body.target.id;
    const c = (await api('post', `/api/v1/storage-targets/${id}/check`).send({}).expect(200)).body;
    assert.equal(c.check.ok, false);
    assert.equal(c.check.error, 'tls');
    assert.equal(c.check.tls.state, 'untrusted');
    assert.equal(c.check.tls.device, 'synology');
    assert.deepEqual(c.check.tls.trust, { leaf: true, chain: false });
    assert.equal(c.check.trusted, undefined);
    assert.equal(c.target.tlsCaInfo, null, 'nothing stored without the click');
    const before = srv.seen.length;
    const t = (await api('post', `/api/v1/storage-targets/${id}/trust`).send({ fingerprint: c.check.tls.cert.fingerprint }).expect(200)).body;
    assert.equal(t.replaced, false);
    assert.equal(t.cert.device, 'synology');
    assert.equal(t.check.ok, true, JSON.stringify(t.check));
    assert.ok(srv.seen.length > before);
    assert.equal(t.target.config.tlsCa.trim(), certs.syn.cert.trim());
    assert.match(activity('storage_target_cert_trusted').pop().message, /"Direkt": certificate of the NAS trusted/);
  });

  it('a name that does not fit stays an error with its names, not something to trust (not_trustable)', async () => {
    // a home CA stored, the NAS's leaf issued by it for "synology": the chain is fine, the URL names NAS
    const leafSrv = await davServer(certs.leaf);
    try {
      const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'Name', url: `https://${NAS}:${leafSrv.port}/x`,
        username: 'gc', password: 'pw', tlsCa: certs.ca }).expect(201);
      const c = (await api('post', `/api/v1/storage-targets/${r.body.target.id}/check`).send({}).expect(200)).body.check;
      assert.equal(c.error, 'tls');
      assert.equal(c.tls.state, 'name');
      assert.deepEqual(c.tls.cert.names, ['synology']);
      assert.deepEqual(c.tls.trust, { leaf: false, chain: false });
      const t = await api('post', `/api/v1/storage-targets/${r.body.target.id}/trust`).send({ fingerprint: c.tls.cert.fingerprint });
      assert.equal(t.status, 409);
      assert.equal(t.body.code, 'not_trustable');
      assert.equal(t.body.reason, 'name');
      // exactly that certificate pinned (an expert's choice under "Erweitert"): valid under every name
      assert.equal((await targets().checkInput('webdav', { label: 'N', url: `https://${NAS}:${leafSrv.port}/x`, username: 'gc', password: 'pw', tlsCa: certs.leaf.cert })).ok, true);
      await api('delete', `/api/v1/storage-targets/${r.body.target.id}`).expect(200);
    } finally { await leafSrv.close(); }
  });
});

describe('SMB: "Verbindung verschlüsseln (SMB3)"', () => {
  const smb = () => require('../src/services/storageTargets/drivers/smb');
  const records = () => fs.readdirSync(rec).sort().map((f) => JSON.parse(fs.readFileSync(path.join(rec, f), 'utf8')));
  const reset = (noenc) => {
    for (const f of fs.readdirSync(rec)) fs.unlinkSync(path.join(rec, f));
    const p = path.join(shimRoot, 'noenc');
    if (noenc) fs.writeFileSync(p, '1'); else fs.rmSync(p, { force: true });
  };
  const base = { label: 'NAS', host: '127.0.0.1', share: 'home', username: 'u', password: 'p' };

  it('new targets encrypt; a target from before keeps its behaviour until it is changed', async () => {
    assert.equal(targets().normalise('smb', base).config.encrypt, true);
    assert.equal(targets().normalise('smb', { ...base, encrypt: false }).config.encrypt, false);
    assert.throws(() => targets().normalise('smb', { ...base, encrypt: 'yes' }), (e) => e.field === 'encrypt');
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'smb', ...base }).expect(201);
    assert.equal(r.body.target.config.encrypt, true);
    // a row from before the switch (no `encrypt`): an edit without the field keeps it off
    const cfg = JSON.parse(db.prepare('SELECT config_json FROM storage_targets WHERE id = ?').get(r.body.target.id).config_json);
    delete cfg.encrypt;
    db.prepare('UPDATE storage_targets SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), r.body.target.id);
    const u = await api('patch', `/api/v1/storage-targets/${r.body.target.id}`).send({ ...base, label: 'NAS alt' }).expect(200);
    assert.equal(u.body.target.config.encrypt, false);
    const on = await api('patch', `/api/v1/storage-targets/${r.body.target.id}`).send({ ...base, encrypt: true }).expect(200);
    assert.equal(on.body.target.config.encrypt, true);
    await api('delete', `/api/v1/storage-targets/${r.body.target.id}`).expect(200);
  });

  it('smbclient gets --client-protection=encrypt only when it is on', async () => {
    reset(false);
    await smb().create({ host: '127.0.0.1', share: 'home', username: 'u', encrypt: true }, { password: 'p' }).prepare();
    await smb().create({ host: '127.0.0.1', share: 'home', username: 'u', encrypt: false }, { password: 'p' }).prepare();
    await smb().create({ host: '127.0.0.1', share: 'home', username: 'u' }, { password: 'p' }).prepare();
    const [a, b, c] = records();
    assert.ok(a.args.includes('--client-protection=encrypt'));
    assert.ok(!b.args.includes('--client-protection=encrypt'));
    assert.ok(!c.args.includes('--client-protection=encrypt'), 'a config from before: as before');
    assert.ok(!a.args.join(' ').includes('p\n') && !a.args.includes('p'), 'the password stays in the auth file');
  });

  it('a share that cannot encrypt → no_encryption, with the Synology hint on the page', async () => {
    reset(true);
    await assert.rejects(smb().create({ host: '127.0.0.1', share: 'home', username: 'u', encrypt: true }, { password: 'p' }).prepare(), { code: 'no_encryption' });
    const c = (await api('post', '/api/v1/storage-targets/check').send({ kind: 'smb', ...base }).expect(200)).body.check;
    assert.equal(c.ok, false);
    assert.equal(c.error, 'no_encryption');
    // switched off it connects (unencrypted)
    const off = (await api('post', '/api/v1/storage-targets/check').send({ kind: 'smb', ...base, encrypt: false }).expect(200)).body.check;
    assert.notEqual(off.error, 'no_encryption');
    assert.equal(smb().noEncryption('tree connect failed: NT_STATUS_NOT_SUPPORTED', true), true);
    assert.equal(smb().noEncryption('tree connect failed: NT_STATUS_NOT_SUPPORTED', false), false);
    assert.equal(smb().noEncryption('NT_STATUS_LOGON_FAILURE', true), false);
    reset(false);
  });
});

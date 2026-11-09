'use strict';

// Off-site backups and the NAS's own certificate (services/offsite withTrust,
// storageTargets/trust.js), S3 through a VPN device ("Verbindung", as WebDAV),
// SMB encryption. Small https servers of this test with a self-signed
// certificate for "synology": a WebDAV server and a fake S3 that re-derives
// the SigV4 signature from what arrived (Host: the endpoint's, not the
// address dialled). Through a VPN device the first contact remembers the
// certificate; "Direkt zur Adresse" needs "Diesem Gerät vertrauen" (POST
// /targets/:id/trust); a renewed certificate is refused until "Neues
// Zertifikat vertrauen". smbclient is a shim on PATH.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-trust-shim-'));
const bin = path.join(shimRoot, 'bin');
const rec = path.join(shimRoot, 'rec');
fs.mkdirSync(bin);
fs.mkdirSync(rec);
process.env.PATH = `${bin}:${process.env.PATH}`;
fs.writeFileSync(path.join(bin, 'smbclient'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const rec = ${JSON.stringify(rec)};
fs.writeFileSync(path.join(rec, String(fs.readdirSync(rec).length).padStart(3, '0') + '.json'), JSON.stringify({ args: process.argv.slice(2) }));
if (fs.existsSync(path.join(rec, '..', 'noenc')) && process.argv.includes('--client-protection=encrypt')) {
  process.stdout.write("Encryption required and server doesn't support SMB3 encryption - failing connect\\n");
  process.exit(1);
}
process.exit(0);
`, { mode: 0o755 });

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const { archiveFile, downloadBuffer } = require('./helpers/offsiteFiles');

const NAS = 'nas.heim.example'; // resolves only where a test says so
const API = '/api/v1/settings/backup';
const AK = 'AKTRUST1';
const SK = 'trust/secret+key';
let db, tmp, certs, dav, s3srv, gw;

const req = (method, url, body) => {
  const r = getAgent()[method](url).set('X-CSRF-Token', getCsrf());
  return body === undefined ? r : r.send(body);
};
const offsite = () => require('../src/services/offsite');
const s3 = () => require('../src/services/offsite/s3');
const net = () => require('../src/services/storageTargets/net');
const fpOf = (pem) => new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();

function makeCerts(dir) {
  const one = (name, cn) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.pem', '-days', '30',
      '-subj', '/CN=' + cn, '-addext', 'subjectAltName=DNS:' + cn], { cwd: dir, stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, name + '.key'), 'utf8'), cert: fs.readFileSync(path.join(dir, name + '.pem'), 'utf8') };
  };
  return { syn: one('syn', 'synology'), renewed: one('renewed', 'synology') };
}

async function listen(handler, pair) {
  const s = https.createServer({ key: pair.key, cert: pair.cert }, handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, renew: (p) => s.setSecureContext({ key: p.key, cert: p.cert }), close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}

/** WebDAV (Basic gc:pw): PROPFIND depth 0/1, MKCOL, PUT, GET, DELETE. */
async function davServer(pair) {
  const files = new Map();
  const seen = [];
  const srv = await listen((q, res) => {
    seen.push({ method: q.method, host: q.headers.host, sni: q.socket.servername || null });
    const parts = [];
    q.on('data', (c) => parts.push(c));
    q.on('end', () => {
      if (q.headers.authorization !== 'Basic ' + Buffer.from('gc:pw').toString('base64')) { res.writeHead(401); res.end(); return; }
      const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
      if (q.method === 'PROPFIND') {
        const items = [`<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
        if (q.headers.depth === '1') for (const [fp, b] of files) if (fp.startsWith(p)) items.push(`<d:response><d:href>${fp}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${b.length}</d:getcontentlength></d:prop></d:propstat></d:response>`);
        res.writeHead(207); res.end(`<d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`); return;
      }
      if (q.method === 'MKCOL') { res.writeHead(405); res.end(); return; }
      if (q.method === 'PUT') { files.set(p, Buffer.concat(parts)); res.writeHead(201); res.end(); return; }
      if (q.method === 'DELETE') { files.delete(p); res.writeHead(204); res.end(); return; }
      const f = files.get(p);
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-length': f.length }); res.end(f);
    });
  }, pair);
  return Object.assign(srv, { files, seen });
}

// the headers the S3 transport signs besides host and x-amz-date
const SIGNABLE = ['content-type', 'x-amz-content-sha256'];

/** A fake S3 (path style, bucket "bk") that checks every SigV4 signature against what arrived. */
async function s3Server(pair) {
  const objects = new Map();
  const seen = [];
  const verify = (q, body) => {
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(q.headers.authorization || '');
    if (!m || m[1] !== AK) return false;
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (q.headers['x-amz-content-sha256'] !== hash) return false;
    const d = q.headers['x-amz-date'];
    const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
    // the names come from a fixed list, never from the request (no property named by the client)
    const signed = m[3].split(';');
    const headers = Object.create(null);
    for (const n of SIGNABLE) if (signed.includes(n)) headers[n] = q.headers[n];
    if (signed.some((n) => n !== 'host' && n !== 'x-amz-date' && !SIGNABLE.includes(n))) return false;
    const h = s3().signRequest({ method: q.method, url: new URL(`https://${q.headers.host}${q.url}`), headers, payloadHash: hash, region: m[2], accessKeyId: AK, secretAccessKey: SK, date });
    return /Signature=([0-9a-f]{64})$/.exec(h.authorization)[1] === m[4];
  };
  const srv = await listen((q, res) => {
    const parts = [];
    q.on('data', (c) => parts.push(c));
    q.on('end', () => {
      const body = Buffer.concat(parts);
      seen.push({ method: q.method, host: q.headers.host, sni: q.socket.servername || null });
      if (!verify(q, body)) { res.writeHead(403); res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); return; }
      const u = new URL(q.url, 'http://x');
      const key = u.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
      if (q.method === 'PUT') { objects.set(key, body); res.writeHead(200); res.end(); return; }
      if (q.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
      if (q.method === 'GET' && !key) {
        const prefix = u.searchParams.get('prefix') || '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200); res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('')}</ListBucketResult>`);
        return;
      }
      if (q.method === 'GET' && objects.has(key)) { res.writeHead(200); res.end(objects.get(key)); return; }
      res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>');
    });
  }, pair);
  return Object.assign(srv, { objects, seen });
}

function activity(event) { return db.prepare('SELECT message, severity FROM activity_log WHERE event_type = ? ORDER BY id').all(event); }

before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-trust-'));
  certs = makeCerts(tmp);
  dav = await davServer(certs.syn);
  s3srv = await s3Server(certs.syn);
  gw = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('Home Gateway', 'pk-gw', '127.0.0.1/32', 1, 'gateway')").run().lastInsertRowid);
  require('../src/services/license')._overrideForTest({ scheduled_backups: true });
});
after(async () => {
  net()._setLookupForTest(null);
  for (const s of [dav, s3srv]) if (s) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(shimRoot, { recursive: true, force: true });
  teardown();
});

describe('WebDAV through a VPN device: remembered on first contact, a change refused', () => {
  let id;
  it('the first test remembers the NAS\'s certificate on its own (activity log); the next one uses it', async () => {
    const c = await req('post', `${API}/targets`, { name: 'DS218+', type: 'webdav', config: { url: `https://${NAS}:5006/GateControl/`, username: 'gc', password: 'pw',
      via: { kind: 'peer', peerId: gw, port: dav.port } } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    id = c.body.target.id;
    assert.equal(c.body.target.config.tls_ca, null);
    assert.equal(c.body.target.config.tls_seen, undefined, 'internal');
    const t = await req('post', `${API}/targets/${id}/test`, {});
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.trusted.device, 'synology');
    assert.equal(t.body.trusted.fingerprint, fpOf(certs.syn.cert));
    const row = offsite().getTarget(id);
    assert.equal(row.config.tls_ca.trim(), certs.syn.cert.trim());
    assert.equal(row.config.tls_ca_info[0].device, 'synology');
    assert.match(activity('offsite_target_cert_remembered').pop().message, /DS218\+.*remembered on first contact/);
    const again = await req('post', `${API}/targets/${id}/test`, {});
    assert.equal(again.status, 200);
    assert.equal(again.body.trusted, undefined);
    assert.ok(dav.seen.every((s) => s.host === `${NAS}:5006` && s.sni === NAS));
  });

  it('a renewed certificate: refused with hint cert_changed and the card data — never accepted, logged once', async () => {
    dav.renew(certs.renewed);
    try {
      const t = await req('post', `${API}/targets/${id}/test`, {});
      assert.equal(t.status, 502);
      assert.equal(t.body.code, 'TRANSPORT_FAILED');
      assert.equal(t.body.hint, 'cert_changed');
      assert.equal(t.body.tls.state, 'changed');
      assert.equal(t.body.tls.cert.fingerprint, fpOf(certs.renewed.cert));
      assert.equal(t.body.tls.cert.device, 'synology');
      assert.equal(offsite().getTarget(id).config.tls_ca.trim(), certs.syn.cert.trim(), 'the stored certificate stays');
      // an upload is refused the same way; the list shows the hint
      await req('put', `${API}/offsite`, { passphrase: 'offsite passphrase 42' }).expect(200);
      const run = await req('post', `${API}/targets/${id}/run`, {});
      assert.equal(run.status, 502);
      assert.equal(run.body.hint, 'cert_changed');
      assert.equal(run.body.tls.state, 'changed');
      const listed = (await req('get', `${API}/targets`)).body.targets.find((x) => x.id === id);
      assert.equal(listed.last_error_hint, 'cert_changed');
      assert.equal(activity('offsite_target_cert_changed').length, 1, 'one entry for one change');
      assert.equal(activity('offsite_target_cert_changed')[0].severity, 'warning');

      // "Neues Zertifikat vertrauen": only the certificate the page showed
      const wrong = await req('post', `${API}/targets/${id}/trust`, { fingerprint: fpOf(certs.syn.cert) });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.code, 'CERT_MISMATCH');
      assert.equal((await req('post', `${API}/targets/${id}/trust`, { fingerprint: 'x' })).body.code, 'INVALID_FINGERPRINT');
      const ok = await req('post', `${API}/targets/${id}/trust`, { fingerprint: t.body.tls.cert.fingerprint });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.replaced, true);
      assert.match(activity('offsite_target_cert_trusted').pop().message, /new certificate of the NAS trusted/);
      assert.equal((await req('post', `${API}/targets/${id}/test`, {})).status, 200);
      const up = await req('post', `${API}/targets/${id}/run`, {});
      assert.equal(up.status, 200, JSON.stringify(up.body));
    } finally { dav.renew(certs.syn); }
  });

  it('a target reached before is never trusted on its own', async () => {
    const t = offsite().createTarget({ name: 'Seen', type: 'webdav', config: { url: `https://${NAS}:5006/Seen/`, username: 'gc', password: 'pw', via: { kind: 'peer', peerId: gw, port: dav.port } } });
    db.prepare("UPDATE backup_targets SET last_status = 'ok' WHERE id = ?").run(t.id);
    // a config from before tls_seen: its last upload decides
    const { encrypt, decrypt } = require('../src/utils/crypto');
    const cfg = JSON.parse(decrypt(db.prepare('SELECT config_enc FROM backup_targets WHERE id = ?').get(t.id).config_enc));
    delete cfg.tls_seen;
    db.prepare('UPDATE backup_targets SET config_enc = ? WHERE id = ?').run(encrypt(JSON.stringify(cfg)), t.id);
    const r = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(r.status, 502);
    assert.equal(r.body.hint, 'cert_untrusted');
    assert.equal(offsite().getTarget(t.id).config.tls_ca, null);
  });
});

describe('"Direkt zur Adresse": "Diesem Gerät vertrauen" is the click', () => {
  before(() => net()._setLookupForTest(async (h) => (h === NAS ? [{ address: '127.0.0.1', family: 4 }] : [])));
  after(() => net()._setLookupForTest(null));

  it('WebDAV: the test shows the card data, nothing is stored; trusting stores exactly that certificate', async () => {
    const t = offsite().createTarget({ name: 'Direkt', type: 'webdav', config: { url: `https://${NAS}:${dav.port}/Direkt/`, username: 'gc', password: 'pw' } });
    const r = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(r.status, 502);
    assert.equal(r.body.hint, 'cert_untrusted');
    assert.equal(r.body.tls.state, 'untrusted');
    assert.equal(r.body.trusted, undefined);
    assert.equal(offsite().getTarget(t.id).config.tls_ca, null);
    const ok = await req('post', `${API}/targets/${t.id}/trust`, { fingerprint: r.body.tls.cert.fingerprint });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.replaced, false);
    assert.equal(ok.body.target.config.tls_ca_info[0].fingerprint, fpOf(certs.syn.cert));
    assert.equal((await req('post', `${API}/targets/${t.id}/test`, {})).status, 200);
  });

  it('S3 direct: the same card and click', async () => {
    const t = offsite().createTarget({ name: 'MinIO direkt', type: 's3', config: { endpoint: `https://${NAS}:${s3srv.port}`, region: 'eu-test-1', bucket: 'bk',
      prefix: 'direct', access_key_id: AK, secret_access_key: SK, path_style: true } });
    const r = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(r.status, 502);
    assert.equal(r.body.hint, 'cert_untrusted');
    assert.equal(r.body.tls.state, 'untrusted');
    assert.equal((await req('post', `${API}/targets/${t.id}/trust`, { fingerprint: r.body.tls.cert.fingerprint })).status, 200);
    const again = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });
});

describe('S3 through a VPN device ("Verbindung") with the trust handling', () => {
  it('the transport: to the peer\'s address; Host (signed), SNI and the certificate check stay the endpoint\'s', async () => {
    const cfg = offsite().normalizeConfig('s3', { endpoint: `https://${NAS}:9000`, region: 'eu-test-1', bucket: 'bk', prefix: 'gc', access_key_id: AK,
      secret_access_key: SK, path_style: true, via: { kind: 'peer', peerId: gw, port: s3srv.port }, tls_ca: certs.syn.cert });
    assert.deepEqual(cfg.via, { kind: 'peer', peerId: gw, port: s3srv.port });
    s3srv.seen.length = 0;
    assert.match(await s3().test(cfg), /write \+ delete ok/);
    const data = crypto.randomBytes(200 * 1024 + 3);
    // the archive FILE, streamed through the tunnel (signed with its SHA-256, read from the file)
    await s3().upload(cfg, 'gatecontrol-20261109-030000.gcbk', archiveFile(data));
    assert.deepEqual((await s3().list(cfg)).map((f) => [f.name, f.size]), [['gatecontrol-20261109-030000.gcbk', data.length]]);
    assert.ok((await downloadBuffer(s3(), cfg, 'gatecontrol-20261109-030000.gcbk')).equals(data));
    await s3().remove(cfg, 'gatecontrol-20261109-030000.gcbk');
    assert.ok(s3srv.seen.length >= 6);
    assert.ok(s3srv.seen.every((s) => s.host === `${NAS}:9000` && s.sni === NAS), JSON.stringify(s3srv.seen.slice(0, 2)));
    // without the certificate: refused, with the system's code for the page
    await assert.rejects(s3().list({ ...cfg, tls_ca: null }), (e) => e.code === 'TRANSPORT' && /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/.test(e.sys));
    // a wrong secret still says what S3 said
    await assert.rejects(s3().list({ ...cfg, secret_access_key: 'nope' }), (e) => e.code === 'TRANSPORT' && e.remoteStatus === 403 && /SignatureDoesNotMatch/.test(e.message));
  });

  it('over the API: the first test remembers the certificate; the backup goes up and comes back', async () => {
    const c = await req('post', `${API}/targets`, { name: 'MinIO NAS', type: 's3', keep: 2, config: { endpoint: `https://${NAS}:9000`, region: 'eu-test-1', bucket: 'bk',
      prefix: 'nas', access_key_id: AK, secret_access_key: SK, path_style: true, via: { kind: 'peer', peerId: gw, port: s3srv.port } } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.deepEqual(c.body.target.config.via, { kind: 'peer', peerId: gw, port: s3srv.port });
    const t = await req('post', `${API}/targets/${c.body.target.id}/test`, {});
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.trusted.device, 'synology');
    assert.equal(offsite().getTarget(c.body.target.id).config.tls_ca_info[0].fingerprint, fpOf(certs.syn.cert));
    await req('put', `${API}/offsite`, { passphrase: 'offsite passphrase 42' }).expect(200);
    const run = await req('post', `${API}/targets/${c.body.target.id}/run`, {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.ok(s3srv.objects.get(`nas/${run.body.file}`).subarray(0, 5).toString() === 'GCBK1');
    const v = await req('post', `${API}/targets/${c.body.target.id}/verify`, {});
    assert.equal(v.status, 200, JSON.stringify(v.body));
  });

  it('validation: a connection through a VPN device needs an endpoint; a bad certificate names its field', async () => {
    const base = { region: 'eu-test-1', bucket: 'bk', access_key_id: AK, secret_access_key: SK };
    const r1 = await req('post', `${API}/targets`, { name: 'x', type: 's3', config: { ...base, via: { kind: 'peer', peerId: gw } } });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.field, 'endpoint');
    const r2 = await req('post', `${API}/targets`, { name: 'x', type: 's3', config: { ...base, endpoint: 'https://minio.example', tls_ca: 'nope' } });
    assert.equal(r2.body.field, 'tls_ca');
    const r3 = await req('post', `${API}/targets`, { name: 'x', type: 's3', config: { ...base, endpoint: 'https://minio.example', via: { kind: 'peer', peerId: 999999 } } });
    assert.equal(r3.body.field, 'via');
    // without via: the endpoint itself, as before
    assert.deepEqual(offsite().normalizeConfig('s3', { ...base }).via, { kind: 'host' });
  });
});

describe('SMB: "Verbindung verschlüsseln (SMB3)"', () => {
  const records = () => fs.readdirSync(rec).sort().map((f) => JSON.parse(fs.readFileSync(path.join(rec, f), 'utf8')));
  const reset = (noenc) => {
    for (const f of fs.readdirSync(rec)) fs.unlinkSync(path.join(rec, f));
    const p = path.join(shimRoot, 'noenc');
    if (noenc) fs.writeFileSync(p, '1'); else fs.rmSync(p, { force: true });
  };
  const smb = () => require('../src/services/offsite/smb');

  it('on for new targets; a target from before keeps its behaviour until it is changed; the argument follows', async () => {
    const cfg = offsite().normalizeConfig('smb', { host: 'nas', share: 'backup', username: 'u', password: 'p' });
    assert.equal(cfg.encrypt, true);
    assert.ok(smb().baseArgs(cfg, '/tmp/auth').includes('--client-protection=encrypt'));
    assert.ok(!smb().baseArgs({ ...cfg, encrypt: false }, '/tmp/auth').includes('--client-protection=encrypt'));
    assert.ok(!smb().baseArgs({ host: 'nas', share: 'backup' }, '/tmp/auth').includes('--client-protection=encrypt'), 'a config from before: as before');
    const bad = await req('post', `${API}/targets`, { name: 'x', type: 'smb', config: { host: 'nas', share: 'b', encrypt: 'yes' } });
    assert.equal(bad.body.field, 'encrypt');
    // a stored config without `encrypt`: an edit without the field keeps it off, the switch turns it on
    const t = offsite().createTarget({ name: 'Alt', type: 'smb', enabled: false, config: { host: 'nas', share: 'backup', username: 'u', password: 'p' } });
    const { encrypt, decrypt } = require('../src/utils/crypto');
    const stored = JSON.parse(decrypt(db.prepare('SELECT config_enc FROM backup_targets WHERE id = ?').get(t.id).config_enc));
    delete stored.encrypt;
    db.prepare('UPDATE backup_targets SET config_enc = ? WHERE id = ?').run(encrypt(JSON.stringify(stored)), t.id);
    assert.equal((await req('put', `${API}/targets/${t.id}`, { name: 'Alt 2' })).body.target.config.encrypt, undefined);
    assert.equal((await req('put', `${API}/targets/${t.id}`, { config: { path: 'gc' } })).body.target.config.encrypt, false);
    assert.equal((await req('put', `${API}/targets/${t.id}`, { config: { encrypt: true } })).body.target.config.encrypt, true);
  });

  it('a share that cannot encrypt: a plain message with the Synology hint (hint smb_no_encryption, also on the list)', async () => {
    reset(true);
    const t = offsite().createTarget({ name: 'Fritz', type: 'smb', config: { host: 'fritz.box', share: 'usb', username: 'u', password: 'p' } });
    const r = await req('post', `${API}/targets/${t.id}/test`, {});
    assert.equal(r.status, 502);
    assert.equal(r.body.hint, 'smb_no_encryption');
    assert.equal(r.body.error, smb().NO_ENCRYPTION_TEXT);
    assert.ok(records().some((x) => x.args.includes('--client-protection=encrypt')));
    await req('put', `${API}/offsite`, { passphrase: 'offsite passphrase 42' }).expect(200);
    await req('post', `${API}/targets/${t.id}/run`, {});
    assert.equal((await req('get', `${API}/targets`)).body.targets.find((x) => x.id === t.id).last_error_hint, 'smb_no_encryption');
    // switched off: it connects without
    await req('put', `${API}/targets/${t.id}`, { config: { encrypt: false } }).expect(200);
    assert.equal((await req('post', `${API}/targets/${t.id}/test`, {})).status, 200);
    reset(false);
    await req('put', `${API}/targets/${t.id}`, { enabled: false }).expect(200);
  });
});

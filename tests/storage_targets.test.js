'use strict';

// Storage targets (docs/storage-targets.md): admin API, validation, secrets
// write-only, the check against a folder of this server, "in use" rules,
// the SigV4 signer against AWS's published example, the address rules and
// the backup round trip. The drivers against real SMB / WebDAV / S3 servers:
// tests/storage_targets_live.test.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf, tmp;
before(async () => {
  ({ app, agent, csrfToken: csrf } = await setup());
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-stg-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  teardown();
});

function db() { return require('../src/db/connection').getDb(); }

/** A self-signed certificate (openssl) → { key, cert } PEM. */
function selfSigned(cn) {
  const dir = fs.mkdtempSync(path.join(tmp, 'cert-'));
  require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=' + cn], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8') };
}
const api = (method, p) => agent[method](p).set('X-CSRF-Token', csrf);
const targets = () => require('../src/services/storageTargets');

describe('access', () => {
  it('admin session only: member 403, API token 403, nobody 401', async () => {
    const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
    db().prepare("INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES ('stg-member', ?, 'user', 1)").run(hash);
    const a = supertest.agent(app);
    const page = await a.get('/login');
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    await a.post('/login').type('form').send({ username: 'stg-member', password: 'Plain!Pass1234', _csrf: c }).expect(302);
    assert.equal((await a.get('/api/v1/storage-targets')).status, 403);
    const token = require('../src/services/tokens').create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    assert.equal((await supertest(app).get('/api/v1/storage-targets').set('Authorization', `Bearer ${token}`)).status, 403);
    assert.ok([401, 302].includes((await supertest(app).get('/api/v1/storage-targets')).status));
  });

  it('renders the storage page in the plugin area', async () => {
    const r = await agent.get('/settings/plugins/storage').expect(200);
    assert.match(r.text, /data-view="storage"/);
    assert.match(r.text, /href="\/settings\/plugins\/storage"/);
  });
});

describe('a folder of this server', () => {
  let id;
  it('creates, checks (write, read, range, delete, free space) and lists it', async () => {
    const dir = path.join(tmp, 'disk1');
    fs.mkdirSync(dir);
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'local', label: 'USB-Platte', path: dir }).expect(201);
    id = r.body.target.id;
    assert.equal(r.body.target.kind, 'local');
    assert.equal(r.body.target.display, dir);
    assert.equal(r.body.target.check, null);
    const c = await api('post', `/api/v1/storage-targets/${id}/check`).expect(200);
    assert.equal(c.body.check.ok, true, JSON.stringify(c.body.check));
    assert.deepEqual(c.body.check.steps.map((s) => s.step), ['connect', 'folder', 'write', 'read', 'delete']);
    assert.ok(c.body.check.free > 0);
    assert.equal(c.body.target.check.ok, true);
    assert.deepEqual(fs.readdirSync(dir), [], 'the test file is gone');
    const l = await api('get', '/api/v1/storage-targets').expect(200);
    assert.equal(l.body.targets.length, 1);
  });

  it('a missing folder fails the check with not_found and keeps the result', async () => {
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'local', label: 'Fehlt', path: path.join(tmp, 'nope') }).expect(201);
    const c = await api('post', `/api/v1/storage-targets/${r.body.target.id}/check`).expect(200);
    assert.equal(c.body.check.ok, false);
    assert.equal(c.body.check.error, 'not_found');
    assert.equal(c.body.target.check.ok, false);
    await api('delete', `/api/v1/storage-targets/${r.body.target.id}`).expect(200);
  });

  it('refuses system folders, relative paths and the data folder outside /storage', async () => {
    for (const p of ['/etc/gc', '/', 'relative/dir', '/proc/1', require('../src/services/plugins/constants').dataRoot() + '/plugin-media']) {
      const r = await api('post', '/api/v1/storage-targets').send({ kind: 'local', label: 'x', path: p });
      assert.equal(r.status, 400, p);
      assert.equal(r.body.field, 'path');
    }
    const ok = await api('post', '/api/v1/storage-targets').send({ kind: 'local', label: 'Daten', path: require('../src/services/plugins/constants').dataRoot() + '/storage/drive' }).expect(201);
    await api('delete', `/api/v1/storage-targets/${ok.body.target.id}`).expect(200);
  });

  it('a target in use keeps its place and cannot be deleted', async () => {
    targets().registerUsage((tid) => (tid === id ? [{ kind: 'area', plugin: 'gatecontrol-drive', area: 'family', label: 'Familie' }] : []));
    const l = await api('get', `/api/v1/storage-targets/${id}`).expect(200);
    assert.equal(l.body.target.usedBy.length, 1);
    assert.equal((await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'Neu', path: path.join(tmp, 'other') })).status, 409);
    await api('patch', `/api/v1/storage-targets/${id}`).send({ label: 'Neuer Name', path: path.join(tmp, 'disk1') }).expect(200);
    assert.equal((await api('delete', `/api/v1/storage-targets/${id}`)).status, 409);
  });

  it('copies on the folder (since 1.215.0, gc.media.copy): never over an existing file, never outside the folder', async () => {
    const dir = path.join(tmp, 'copy1');
    fs.mkdirSync(dir);
    const d = await targets().driverOf({ kind: 'local', config: { path: dir }, secret: {} });
    const { Readable } = require('node:stream');
    const data = Buffer.from('Inhalt der Quelle');
    await d.put('a/quelle.txt', { length: data.length, open: (s, e) => Readable.from([data.subarray(s, e + 1)]) });
    await d.copy('a/quelle.txt', 'b/c/kopie.txt');
    assert.equal(fs.readFileSync(path.join(dir, 'b/c/kopie.txt'), 'utf8'), 'Inhalt der Quelle');
    assert.notEqual(fs.statSync(path.join(dir, 'b/c/kopie.txt')).ino, fs.statSync(path.join(dir, 'a/quelle.txt')).ino, 'a file of its own');
    fs.writeFileSync(path.join(dir, 'b/belegt.txt'), 'bleibt');
    await assert.rejects(d.copy('a/quelle.txt', 'b/belegt.txt'), (e) => e.code === 'exists');
    assert.equal(fs.readFileSync(path.join(dir, 'b/belegt.txt'), 'utf8'), 'bleibt');
    await assert.rejects(d.copy('a/fehlt.txt', 'b/x.txt'), (e) => e.code === 'not_found');
    await assert.rejects(d.copy('a/quelle.txt', '../draussen.txt'), (e) => e.code === 'failed');
    assert.equal(fs.existsSync(path.join(tmp, 'draussen.txt')), false);
    assert.equal(fs.readdirSync(path.join(dir, 'b')).filter((n) => n.startsWith('.gc-upload-')).length, 0, 'no temporary file left');
  });
});

describe('secrets and validation', () => {
  it('stores secrets encrypted, answers only whether they are set, keeps them on an empty field', async () => {
    const r = await api('post', '/api/v1/storage-targets').send({
      kind: 's3', label: 'Hetzner', endpoint: 'https://fsn1.your-objectstorage.com/', bucket: 'gc-drive', region: 'eu-central',
      prefix: '/family/', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'S3cr3t/Key+Value',
    }).expect(201);
    const t = r.body.target;
    assert.equal(t.encrypted, true);
    assert.deepEqual(t.secretSet, { secretAccessKey: true });
    assert.equal(JSON.stringify(r.body).includes('S3cr3t'), false);
    assert.equal(t.config.prefix, 'family');
    assert.equal(t.config.endpoint, 'https://fsn1.your-objectstorage.com');
    const row = db().prepare('SELECT * FROM storage_targets WHERE id = ?').get(t.id);
    assert.equal(row.config_json.includes('S3cr3t'), false);
    assert.equal(row.secret_enc.includes('S3cr3t'), false);
    const u = await api('patch', `/api/v1/storage-targets/${t.id}`).send({ label: 'Hetzner 2', endpoint: 'https://fsn1.your-objectstorage.com', bucket: 'gc-drive', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: '' }).expect(200);
    assert.equal(u.body.target.secretSet.secretAccessKey, true);
    const row2 = db().prepare('SELECT * FROM storage_targets WHERE id = ?').get(t.id);
    assert.equal(JSON.parse(require('../src/utils/crypto').decrypt(row2.secret_enc)).secretAccessKey, 'S3cr3t/Key+Value');
    await api('delete', `/api/v1/storage-targets/${t.id}`).expect(200);
  });

  it('S3 needs the secret key; SMB and WebDAV accounts may have none', async () => {
    const s3 = await api('post', '/api/v1/storage-targets').send({ kind: 's3', label: 'x', endpoint: 'https://s3.example.com', bucket: 'abc', accessKeyId: 'AKID' });
    assert.equal(s3.status, 400);
    assert.equal(s3.body.field, 'secretAccessKey');
    const smb = await api('post', '/api/v1/storage-targets').send({ kind: 'smb', label: 'NAS', host: 'nas.fritz.box', share: 'home', folder: 'GateControl/Drive', username: 'gc' }).expect(201);
    assert.equal(smb.body.target.display, 'smb://nas.fritz.box/home/GateControl/Drive');
    assert.deepEqual(smb.body.target.config.via, { kind: 'host', host: 'nas.fritz.box', port: 445 });
    await api('delete', `/api/v1/storage-targets/${smb.body.target.id}`).expect(200);
  });

  it('rejects bad input field by field', async () => {
    const cases = [
      [{ kind: 'ftp', label: 'x' }, 'kind'],
      [{ kind: 'local', label: '', path: tmp }, 'label'],
      [{ kind: 'smb', label: 'x', host: 'bad host!', share: 'home' }, 'host'],
      [{ kind: 'smb', label: 'x', host: 'nas', port: 70000, share: 'home' }, 'port'],
      [{ kind: 'smb', label: 'x', host: 'nas', share: 'ho"me' }, 'share'],
      [{ kind: 'smb', label: 'x', host: 'nas', share: 'home', folder: 'a/../b' }, 'folder'],
      [{ kind: 'smb', label: 'x', host: 'nas', share: 'home', password: 'a\nb' }, 'password'],
      [{ kind: 'smb', label: 'x', via: { kind: 'peer', peerId: 999 }, share: 'home' }, 'via'],
      [{ kind: 'webdav', label: 'x', url: 'ftp://nas/dav' }, 'url'],
      [{ kind: 'webdav', label: 'x', url: 'https://user:pw@nas/dav' }, 'url'],
      [{ kind: 'webdav', label: 'x', url: 'https://nas/dav', tlsCa: 'abc' }, 'tlsCa'],
      [{ kind: 'webdav', label: 'x', url: 'https://nas/dav', tlsCa: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----' }, 'tlsCa'],
      [{ kind: 's3', label: 'x', endpoint: 'https://s3', bucket: 'UPPER', accessKeyId: 'AKID', secretAccessKey: 's' }, 'bucket'],
    ];
    for (const [body, field] of cases) {
      const r = await api('post', '/api/v1/storage-targets').send(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.field, field, JSON.stringify(body));
    }
  });

  it('the own certificate of a target (PEM) is stored and shown with subject and fingerprint', async () => {
    const pem = selfSigned('synology').cert;
    const r = await api('post', '/api/v1/storage-targets').send({ kind: 'webdav', label: 'NC', url: 'https://cloud.example.com/remote.php/dav/files/gc/', username: 'gc', password: 'pw', tlsCa: 'text before\n' + pem }).expect(201);
    assert.match(r.body.target.config.tlsCa, /^-----BEGIN CERTIFICATE-----/);
    assert.equal(r.body.target.tlsCaInfo.length, 1);
    assert.match(r.body.target.tlsCaInfo[0].subject, /synology/);
    assert.match(r.body.target.tlsCaInfo[0].fingerprint, /^[0-9a-f]{64}$/);
    await api('delete', `/api/v1/storage-targets/${r.body.target.id}`).expect(200);
  });

  it('TLS is always verified: a self-signed server works only with its certificate stored', async () => {
    const https = require('node:https');
    const net = require('../src/services/storageTargets/net');
    const { StorageError } = require('../src/services/storageTargets/errors');
    const own = selfSigned('synology');
    const other = selfSigned('other');
    const srv = https.createServer({ key: own.key, cert: own.cert }, (q, res) => res.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${srv.address().port}/`;
    try {
      await assert.rejects(net.request({ url }), (e) => StorageError.from(e).code === 'tls');
      const ok = await net.request({ url, tlsCa: own.cert });
      assert.equal(ok.status, 200);
      assert.equal((await net.readBody(ok.stream)).toString(), 'ok');
      await assert.rejects(net.request({ url, tlsCa: other.cert }), (e) => StorageError.from(e).code === 'tls');
    } finally { srv.close(); }
  });

  it('checks unsaved settings without storing anything', async () => {
    const dir = path.join(tmp, 'disk2');
    fs.mkdirSync(dir);
    const before = db().prepare('SELECT COUNT(*) AS n FROM storage_targets').get().n;
    const r = await api('post', '/api/v1/storage-targets/check').send({ kind: 'local', label: 'Probe', path: dir }).expect(200);
    assert.equal(r.body.check.ok, true);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM storage_targets').get().n, before);
    const unreachable = await api('post', '/api/v1/storage-targets/check').send({ kind: 'webdav', label: 'Probe', url: 'http://127.0.0.1:9/dav' }).expect(200);
    assert.equal(unreachable.body.check.ok, false);
    assert.equal(unreachable.body.check.error, 'unreachable');
  });
});

describe('S3 signature V4', () => {
  it('matches the GET example of the AWS documentation', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "GET Object"
    const h = require('../src/services/storageTargets/drivers/s3').sign({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {},
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(h.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('encodes keys like SigV4 wants (spaces, umlauts, slashes kept)', () => {
    const { uriEncode } = require('../src/services/storageTargets/drivers/s3');
    assert.equal(uriEncode('/a b/ä~(x)', true), '/a%20b/%C3%A4~%28x%29');
    assert.equal(uriEncode('a/b'), 'a%2Fb');
  });
});

describe('addresses', () => {
  it('allows public, private and loopback addresses, never metadata or link-local', () => {
    const net = require('../src/services/storageTargets/net');
    assert.equal(net.addressAllowed('8.8.8.8', 443), true);
    assert.equal(net.addressAllowed('192.168.178.20', 445), true);
    assert.equal(net.addressAllowed('127.0.0.1', 9000), true);
    assert.equal(net.addressAllowed('169.254.169.254', 80), false);
    assert.equal(net.addressAllowed('fe80::1', 80), false);
    assert.equal(net.addressAllowed('224.0.0.1', 80), false);
    assert.equal(net.addressAllowed('0.0.0.0', 80), false);
  });

  it('a name pointing at the metadata service is refused before connecting', async () => {
    const net = require('../src/services/storageTargets/net');
    net._setLookupForTest(async () => [{ address: '169.254.169.254', family: 4 }]);
    try {
      await assert.rejects(net.request({ url: 'http://metadata.example/latest' }), (e) => e.code === 'blocked_address');
    } finally { net._setLookupForTest(null); }
  });
});

describe('backup', () => {
  it('exports targets with their id and the secret as stored; a restore brings them back', async () => {
    const backup = require('../src/services/backup');
    const created = targets().create('webdav', { label: 'Synology', url: 'https://nas:5006/drive', username: 'gc', password: 'Geheim!' });
    const b = JSON.parse(JSON.stringify(backup.createBackup()));
    const e = b.data.storage_targets.find((x) => x.target_ref === created.id);
    assert.ok(e);
    assert.equal(e.kind, 'webdav');
    assert.equal(JSON.stringify(e).includes('Geheim!'), false);
    db().prepare('DELETE FROM storage_targets').run();
    await backup.restoreBackup(b);
    const back = targets().get(created.id);
    assert.equal(back.label, 'Synology');
    assert.equal(back.secretSet.password, true);
    assert.equal(backup.getBackupSummary(b).storage_targets, b.data.storage_targets.length);
  });
});

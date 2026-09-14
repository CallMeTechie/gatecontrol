'use strict';

// Off-site backup targets API (docs/feature-release-b.md §7): CRUD with
// per-type validation, secrets never in answers, license gate, test/run/files
// against a fake WebDAV server, retention (only own gatecontrol-*.gcbk),
// upload after an automatic backup, SSE `backup`, SSH key, l4-candidates.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-bk-'));
process.env.GC_BACKUP_DIR = backupDir;
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const PASS = 'offsite passphrase 42';
const API = '/api/v1/settings/backup';
let dav; // fake WebDAV server state
let davBase;
let server;
let license;
let db;

function startDav() {
  const files = new Map();
  const cols = new Set(['/', '/dav/']);
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('bob:davpass').toString('base64')) { res.writeHead(401); res.end(); return; }
      if (dav.failPut && req.method === 'PUT') { res.writeHead(507); res.end(); return; }
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (req.method === 'PROPFIND') {
        if (!cols.has(p)) { res.writeHead(404); res.end(); return; }
        const items = [`<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
        if (req.headers.depth === '1') {
          for (const [fp, b] of files) if (fp.startsWith(p) && !fp.slice(p.length).includes('/')) items.push(`<d:response><d:href>${encodeURI(fp)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${b.length}</d:getcontentlength></d:prop></d:propstat></d:response>`);
        }
        res.writeHead(207); res.end(`<d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`); return;
      }
      if (req.method === 'MKCOL') { cols.add(p); res.writeHead(201); res.end(); return; }
      if (req.method === 'PUT') { files.set(p, Buffer.concat(chunks)); res.writeHead(201); res.end(); return; }
      if (req.method === 'DELETE') { files.delete(p); res.writeHead(204); res.end(); return; }
      res.writeHead(405); res.end();
    });
  });
  dav = { files, cols, failPut: false };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { davBase = `http://127.0.0.1:${server.address().port}`; r(); }));
}

const agentReq = (method, url, body) => {
  const r = getAgent()[method](url).set('X-CSRF-Token', getCsrf());
  return body === undefined ? r : r.send(body);
};

before(async () => {
  await setup();
  await startDav();
  license = require('../src/services/license');
  db = require('../src/db/connection').getDb();
});
after(() => { server.close(); teardown(); fs.rmSync(backupDir, { recursive: true, force: true }); });

describe('off-site settings', () => {
  it('passphrase is write-only; include_key defaults to true', async () => {
    let res = await getAgent().get(`${API}/offsite`);
    assert.deepEqual(res.body, { ok: true, passphrase_set: false, include_key: true });
    res = await agentReq('put', `${API}/offsite`, { passphrase: 'too short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PASSPHRASE_TOO_SHORT');
    res = await agentReq('put', `${API}/offsite`, { passphrase: PASS, include_key: true });
    assert.deepEqual(res.body, { ok: true, passphrase_set: true, include_key: true });
    const stored = require('../src/services/settings').get('backup.offsite.passphrase_enc');
    assert.ok(stored && !stored.includes(PASS), 'stored encrypted');
    res = await getAgent().get(`${API}/offsite`);
    assert.ok(!JSON.stringify(res.body).includes(PASS));
    res = await agentReq('put', `${API}/offsite`, { include_key: 'yes' });
    assert.equal(res.status, 400);
  });
});

describe('targets CRUD + validation', () => {
  let davId;

  it('creates a WebDAV target; answer has has_password, never the password', async () => {
    const res = await agentReq('post', `${API}/targets`, {
      name: 'NAS WebDAV', type: 'webdav', keep: 2,
      config: { url: `${davBase}/dav/gc/`, username: 'bob', password: 'davpass' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = res.body.target;
    davId = t.id;
    assert.equal(t.type, 'webdav');
    assert.equal(t.enabled, true);
    assert.equal(t.keep, 2);
    assert.deepEqual(t.config, { url: `${davBase}/dav/gc/`, username: 'bob', has_password: true });
    assert.equal(t.last_status, null);
    const row = db.prepare('SELECT config_enc FROM backup_targets WHERE id = ?').get(davId);
    assert.ok(!row.config_enc.includes('davpass'), 'config encrypted at rest');
    const list = await getAgent().get(`${API}/targets`);
    assert.ok(!JSON.stringify(list.body).includes('davpass'));
  });

  it('per-type validation', async () => {
    const cases = [
      [{ name: 'x', type: 'ftp', config: {} }, 'INVALID_TYPE'],
      [{ name: '', type: 'sftp', config: { host: 'nas', username: 'u' } }, 'INVALID_NAME'],
      [{ name: 'x', type: 'sftp', config: { host: '-oProxyCommand=evil', username: 'u' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'sftp', config: { host: 'nas', username: '-l' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'sftp', config: { host: 'nas', username: 'u', path: '../etc' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'sftp', config: { host: 'nas', username: 'u', port: 70000 } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'smb', config: { host: 'nas', share: 'a;b' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'smb', config: { host: 'nas', share: 'backup', path: 'a"b' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'smb', config: { host: 'nas', share: 'backup', password: 'a\nb' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 's3', config: { bucket: 'b', access_key_id: 'AK' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 's3', config: { bucket: 'bk', access_key_id: 'AKID', secret_access_key: 's', endpoint: 'ftp://x' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'webdav', config: { url: 'https://u:p@x/' } }, 'INVALID_CONFIG'],
      [{ name: 'x', type: 'webdav', keep: 0, config: { url: 'https://x/' } }, 'INVALID_KEEP'],
    ];
    for (const [body, code] of cases) {
      const res = await agentReq('post', `${API}/targets`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, code, JSON.stringify(body));
      assert.equal(res.body.ok, false);
    }
  });

  it('creates sftp / smb / s3 targets with defaults; secrets hidden', async () => {
    const sftp = await agentReq('post', `${API}/targets`, { name: 'SSH', type: 'sftp', config: { host: '10.8.0.1', port: 2222, username: 'backup', path: '/volume1/gc' } });
    assert.equal(sftp.status, 201);
    assert.deepEqual(sftp.body.target.config, { host: '10.8.0.1', port: 2222, username: 'backup', path: '/volume1/gc' });
    const smb = await agentReq('post', `${API}/targets`, { name: 'SMB', type: 'smb', enabled: false, config: { host: 'nas.lan', share: 'backup', path: 'gc', username: 'u', password: 'smbpw', domain: 'WORKGROUP' } });
    assert.equal(smb.status, 201);
    assert.deepEqual(smb.body.target.config, { host: 'nas.lan', port: 445, share: 'backup', path: 'gc', username: 'u', has_password: true, domain: 'WORKGROUP' });
    assert.equal(smb.body.target.enabled, false);
    const s3 = await agentReq('post', `${API}/targets`, { name: 'S3', type: 's3', enabled: false, config: { endpoint: 'https://s3.example.com/', region: 'eu-central-1', bucket: 'gc-backups', prefix: '/host1', access_key_id: 'AKIA1', secret_access_key: 'shh', path_style: true } });
    assert.equal(s3.status, 201, JSON.stringify(s3.body));
    assert.deepEqual(s3.body.target.config, { endpoint: 'https://s3.example.com', region: 'eu-central-1', bucket: 'gc-backups', prefix: 'host1', access_key_id: 'AKIA1', has_secret_access_key: true, path_style: true });
    // sftp targets are disabled for the transfer tests below (no server here)
    await agentReq('put', `${API}/targets/${sftp.body.target.id}`, { enabled: false });
  });

  it('PUT keeps secrets unless sent; type is immutable; 404 for unknown ids', async () => {
    const smbRow = db.prepare("SELECT id FROM backup_targets WHERE type = 'smb'").get();
    let res = await agentReq('put', `${API}/targets/${smbRow.id}`, { name: 'SMB 2', config: { path: 'gc/new' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.target.name, 'SMB 2');
    assert.equal(res.body.target.config.path, 'gc/new');
    assert.equal(res.body.target.config.has_password, true);
    const { decrypt } = require('../src/utils/crypto');
    const cfg = JSON.parse(decrypt(db.prepare('SELECT config_enc FROM backup_targets WHERE id = ?').get(smbRow.id).config_enc));
    assert.equal(cfg.password, 'smbpw');
    res = await agentReq('put', `${API}/targets/${smbRow.id}`, { config: { clear_password: true } });
    assert.equal(res.body.target.config.has_password, false);
    res = await agentReq('put', `${API}/targets/${smbRow.id}`, { type: 's3' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TYPE_IMMUTABLE');
    res = await agentReq('put', `${API}/targets/9999`, { name: 'x' });
    assert.equal(res.status, 404);
    res = await agentReq('put', `${API}/targets/abc`, { name: 'x' });
    assert.equal(res.status, 400);
  });

  it('license gate scheduled_backups on changes and transfers (reads stay open)', async () => {
    license._overrideForTest({ scheduled_backups: false });
    try {
      for (const [m, u, b] of [['post', `${API}/targets`, { name: 'x', type: 'webdav', config: { url: 'https://x/' } }], ['put', `${API}/offsite`, { include_key: true }], ['post', `${API}/targets/${davId}/run`, {}], ['post', `${API}/targets/${davId}/test`, {}], ['get', `${API}/ssh-key`]]) {
        const res = await agentReq(m, u, b);
        assert.equal(res.status, 403, `${m} ${u}`);
        assert.equal(res.body.feature, 'scheduled_backups');
      }
      assert.equal((await getAgent().get(`${API}/targets`)).status, 200);
      assert.equal((await getAgent().get(`${API}/offsite`)).status, 200);
    } finally {
      license._overrideForTest({ scheduled_backups: true });
    }
  });

  it('token auth is refused (session only), even with full-access', async () => {
    const tokens = require('../src/services/tokens');
    const { rawToken } = tokens.create({ name: 'offsite-tok', scopes: ['full-access'] }, '127.0.0.1');
    const supertest = require('supertest');
    const app = require('../src/app').createApp();
    for (const u of [`${API}/targets`, `${API}/pre-migration`, `${API}/offsite`]) {
      const res = await supertest(app).get(u).set('X-Api-Token', rawToken);
      assert.equal(res.status, 403, u);
    }
  });

  describe('transfers (fake WebDAV)', () => {
    const events = [];
    const listener = (e) => { if (e.type === 'backup') events.push(e.payload); };
    before(() => require('../src/services/eventBus').subscribe(listener));
    after(() => require('../src/services/eventBus').unsubscribe(listener));

    it('test → { ok, detail }', async () => {
      const res = await agentReq('post', `${API}/targets/${davId}/test`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true);
      assert.match(res.body.detail, /write \+ delete ok/);
    });

    it('run without any local backup creates one, uploads a decryptable .gcbk, records ok + SSE', async () => {
      const res = await agentReq('post', `${API}/targets/${davId}/run`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'ok');
      assert.match(res.body.file, /^gatecontrol-\d{8}-\d{6}\.gcbk$/);
      const up = dav.files.get(`/dav/gc/${res.body.file}`);
      assert.ok(up && up.subarray(0, 5).toString() === 'GCBK1');
      const { payload } = await require('../src/services/offsite/gcbk').decryptBackup(up, PASS);
      assert.equal(payload.backup.version, 4);
      assert.equal(payload.encryption_key, process.env.GC_ENCRYPTION_KEY, 'include_key');
      const t = (await getAgent().get(`${API}/targets`)).body.targets.find((x) => x.id === davId);
      assert.equal(t.last_status, 'ok');
      assert.equal(t.last_error, null);
      assert.ok(t.last_run_at);
      assert.deepEqual(events.filter((e) => e.target_id === davId).map((e) => e.status).slice(-2), ['running', 'ok']);
    });

    it('files lists only own archives; retention keeps `keep` and never deletes foreign files', async () => {
      dav.files.set('/dav/gc/gatecontrol-20200101-000000.gcbk', Buffer.from('old1'));
      dav.files.set('/dav/gc/gatecontrol-20200102-000000.gcbk', Buffer.from('old2'));
      dav.files.set('/dav/gc/my-notes.txt', Buffer.from('foreign'));
      dav.files.set('/dav/gc/gatecontrol-20200101-000000.gcbk.bak', Buffer.from('foreign'));
      let res = await getAgent().get(`${API}/targets/${davId}/files`);
      assert.equal(res.status, 200);
      assert.equal(res.body.files.length, 3);
      assert.ok(res.body.files.every((f) => /^gatecontrol-\d{8}-\d{6}\.gcbk$/.test(f.name)));
      assert.ok(res.body.files[0].name > res.body.files[1].name, 'newest first');

      // Upload after an automatic backup (keep = 2) → the two oldest own archives go.
      const autobackup = require('../src/services/autobackup');
      await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp in the file name
      const filename = autobackup.runBackup({ offsite: false });
      const r2 = await require('../src/services/offsite').uploadAfterBackup(path.join(autobackup.BACKUP_DIR, filename));
      assert.deepEqual(r2, { uploaded: 1, failed: 0, skipped: null });
      res = await getAgent().get(`${API}/targets/${davId}/files`);
      assert.equal(res.body.files.length, 2);
      assert.ok(!res.body.files.some((f) => f.name.startsWith('gatecontrol-2020')));
      assert.ok(dav.files.has('/dav/gc/my-notes.txt'), 'foreign file kept');
      assert.ok(dav.files.has('/dav/gc/gatecontrol-20200101-000000.gcbk.bak'), 'foreign look-alike kept');
    });

    it('runBackup() triggers the upload hook by itself', async () => {
      const before = dav.files.size;
      await new Promise((r) => setTimeout(r, 1100));
      require('../src/services/autobackup').runBackup();
      for (let i = 0; i < 50 && events.filter((e) => e.status === 'ok').length < 3; i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(events.filter((e) => e.target_id === davId && e.status === 'ok').length >= 3);
      assert.ok(dav.files.size >= before);
    });

    it('a failing upload → 502, last_status failed with a short error, SSE failed', async () => {
      dav.failPut = true;
      try {
        const res = await agentReq('post', `${API}/targets/${davId}/run`, {});
        assert.equal(res.status, 502);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.code, 'UPLOAD_FAILED');
        const t = (await getAgent().get(`${API}/targets`)).body.targets.find((x) => x.id === davId);
        assert.equal(t.last_status, 'failed');
        assert.match(t.last_error, /WebDAV PUT 507/);
        assert.ok(!t.last_error.includes('davpass'));
        assert.equal(events[events.length - 1].status, 'failed');
      } finally { dav.failPut = false; }
    });

    it('test with wrong credentials → 502 with detail', async () => {
      await agentReq('put', `${API}/targets/${davId}`, { config: { password: 'wrong' } });
      const res = await agentReq('post', `${API}/targets/${davId}/test`, {});
      assert.equal(res.status, 502);
      assert.equal(res.body.ok, false);
      assert.match(res.body.detail, /401/);
      // A remote 401 must never surface as OUR 401 (the UI would log out).
      const files = await getAgent().get(`${API}/targets/${davId}/files`);
      assert.equal(files.status, 502);
      assert.equal(files.body.code, 'TRANSPORT_FAILED');
      await agentReq('put', `${API}/targets/${davId}`, { config: { password: 'davpass' } });
    });

    it('no passphrase → run answers 409 PASSPHRASE_NOT_SET', async () => {
      const settings = require('../src/services/settings');
      const saved = settings.get('backup.offsite.passphrase_enc');
      db.prepare("DELETE FROM settings WHERE key = 'backup.offsite.passphrase_enc'").run();
      try {
        const res = await agentReq('post', `${API}/targets/${davId}/run`, {});
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'PASSPHRASE_NOT_SET');
      } finally { settings.set('backup.offsite.passphrase_enc', saved); }
    });
  });

  it('DELETE removes the target', async () => {
    const res = await agentReq('delete', `${API}/targets/${davId}`);
    assert.equal(res.status, 200);
    assert.equal((await agentReq('delete', `${API}/targets/${davId}`)).status, 404);
  });
});

describe('SSH key', () => {
  it('GET generates an ed25519 key once; rotate replaces it', async () => {
    const a = await getAgent().get(`${API}/ssh-key`);
    assert.equal(a.status, 200);
    assert.match(a.body.public_key, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} gatecontrol-backup$/);
    const b = await getAgent().get(`${API}/ssh-key`);
    assert.equal(b.body.public_key, a.body.public_key);
    const r = await agentReq('post', `${API}/ssh-key/rotate`, {});
    assert.notEqual(r.body.public_key, a.body.public_key);
    const priv = require('../src/services/settings').get('backup.offsite.ssh_private_enc');
    assert.ok(priv && !priv.includes('OPENSSH'), 'private key encrypted at rest');
  });

  it('private key is a valid unencrypted openssh-key-v1 blob matching the public key', () => {
    const { generate } = require('../src/services/offsite/sshKey');
    const k = generate('c');
    const b64 = k.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const blob = Buffer.from(b64, 'base64');
    assert.equal(blob.subarray(0, 15).toString('binary'), 'openssh-key-v1\0');
    const pubBlob = Buffer.from(k.publicKey.split(' ')[1], 'base64');
    assert.ok(blob.includes(pubBlob), 'public blob embedded');
    // seed → public key consistency via node:crypto
    const crypto = require('node:crypto');
    const privSection = blob.subarray(blob.indexOf(pubBlob) + pubBlob.length);
    const seedStart = privSection.indexOf(Buffer.concat([Buffer.from([0, 0, 0, 64])])) + 4;
    const seed = privSection.subarray(seedStart, seedStart + 32);
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const derivedPub = crypto.createPublicKey(crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
    assert.equal(Buffer.from(derivedPub, 'base64url').toString('hex'), pubBlob.subarray(pubBlob.length - 32).toString('hex'));
  });
});

describe('GET /targets/l4-candidates', () => {
  it('lists single-port TCP L4 routes, suggests the type, connect via the WG address', async () => {
    const ins = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode, external_enabled, enabled, description)
      VALUES (?, ?, ?, 'l4', ?, ?, ?, ?, 1, ?)`);
    ins.run('nas-ssh', '192.168.2.10', 22, 'tcp', '2222', 'none', 0, 'NAS SSH');
    ins.run('nas-smb', '192.168.2.10', 445, 'tcp', '4455', 'none', 0, 'NAS SMB');
    ins.run('range', '192.168.2.11', 22, 'tcp', '3000-3005', 'none', 0, 'range');
    ins.run('udp', '192.168.2.12', 22, 'udp', '5353', 'none', 0, 'udp');
    const res = await getAgent().get(`${API}/targets/l4-candidates`);
    assert.equal(res.status, 200);
    const byPort = Object.fromEntries(res.body.routes.map((r) => [r.listen_port, r]));
    assert.deepEqual(Object.keys(byPort).sort(), ['2222', '4455']);
    assert.equal(byPort[2222].suggested_type, 'sftp');
    assert.equal(byPort[4455].suggested_type, 'smb');
    assert.equal(byPort[2222].internal, true);
    assert.equal(byPort[2222].connect_host, require('../config/default').wireguard.gatewayIp);
    assert.equal(byPort[2222].connect_port, 2222);
    assert.equal(byPort[2222].label, 'NAS SSH');
  });
});

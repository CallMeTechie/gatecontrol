'use strict';

// Restore test (docs/feature-next-package.md §S2.1):
// POST /api/v1/settings/backup/targets/:id/verify fetches the newest archive
// from the target, decrypts it with the stored passphrase and validates it —
// without changing anything. Answer { ok, file, size, created_at, gc_version,
// include_key, counts, warnings }; errors NO_REMOTE_BACKUP, PASSPHRASE_NOT_SET,
// DECRYPT_FAILED, CORRUPT, TRANSPORT_FAILED. The result is stored in
// backup_targets.last_verify_* (migration v80) for the security check.
//
// Runs against a fake WebDAV server in-process (PROPFIND/MKCOL/PUT/GET/DELETE).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-verify-bk-'));
process.env.GC_BACKUP_DIR = backupDir;
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const PASS = 'restore test passphrase';
const API = '/api/v1/settings/backup';
const KDF = { N: 1024, r: 8, p: 1 }; // small on purpose — scrypt in a test
const NAME_OLD = 'gatecontrol-20260101-000000.gcbk';
const NAME_NEW = 'gatecontrol-20260102-030405.gcbk';

let server;
let davBase;
let dav;
let gcbk;
let backup;
let license;
let db;
let targetId;

function startDav() {
  const files = new Map();   // '/dav/gc/<name>' → Buffer
  const cols = new Set(['/', '/dav/', '/dav/gc/']);
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (dav.failGet && req.method === 'GET') { res.writeHead(500); res.end(); return; }
      if (req.method === 'PROPFIND') {
        if (!cols.has(p)) { res.writeHead(404); res.end(); return; }
        const items = [`<d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
        if (req.headers.depth === '1') {
          for (const [fp, b] of files) {
            if (fp.startsWith(p) && !fp.slice(p.length).includes('/')) {
              items.push(`<d:response><d:href>${encodeURI(fp)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${b.length}</d:getcontentlength></d:prop></d:propstat></d:response>`);
            }
          }
        }
        res.writeHead(207); res.end(`<d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`); return;
      }
      if (req.method === 'MKCOL') { cols.add(p); res.writeHead(201); res.end(); return; }
      if (req.method === 'PUT') { files.set(p, Buffer.concat(chunks)); res.writeHead(201); res.end(); return; }
      if (req.method === 'DELETE') { files.delete(p); res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        const b = files.get(p);
        if (!b) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(b); return;
      }
      res.writeHead(405); res.end();
    });
  });
  dav = { files, cols, failGet: false, put: (name, buf) => files.set('/dav/gc/' + name, buf) };
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { davBase = `http://127.0.0.1:${server.address().port}`; r(); }));
}

const req = (method, url, body) => {
  const r = getAgent()[method](url).set('X-CSRF-Token', getCsrf());
  return body === undefined ? r : r.send(body);
};
const verify = () => req('post', `${API}/targets/${targetId}/verify`, {});
const remoteNames = () => [...dav.files.keys()].sort();

/** A GCBK1 archive of the live test database. */
async function archive(opts = {}) {
  return gcbk.encryptBackup(opts.backup || backup.createBackup(), {
    passphrase: opts.passphrase || PASS,
    encryptionKey: opts.encryptionKey,
    gcVersion: opts.gcVersion === undefined ? require('../package.json').version : opts.gcVersion,
    kdf: KDF,
  });
}

before(async () => {
  await setup();
  await startDav();
  gcbk = require('../src/services/offsite/gcbk');
  backup = require('../src/services/backup');
  license = require('../src/services/license');
  db = require('../src/db/connection').getDb();
  const res = await req('post', `${API}/targets`, {
    name: 'Verify NAS', type: 'webdav', keep: 5, config: { url: `${davBase}/dav/gc/` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  targetId = res.body.target.id;
});
after(() => { server.close(); teardown(); fs.rmSync(backupDir, { recursive: true, force: true }); });

describe('POST /targets/:id/verify — error codes', () => {
  it('409 PASSPHRASE_NOT_SET while no passphrase is configured', async () => {
    const res = await verify();
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PASSPHRASE_NOT_SET');
    assert.equal(res.body.ok, false);
  });

  it('409 NO_REMOTE_BACKUP when the target holds no archive', async () => {
    await req('put', `${API}/offsite`, { passphrase: PASS });
    dav.put('some-other-file.txt', Buffer.from('not ours'));
    const res = await verify();
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NO_REMOTE_BACKUP');
  });

  it('400 CORRUPT for a file that only looks like an archive', async () => {
    dav.put(NAME_OLD, Buffer.from('GCBK1 but not really an archive at all'));
    const res = await verify();
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'CORRUPT');
  });

  it('400 DECRYPT_FAILED for an archive under another passphrase', async () => {
    dav.put(NAME_OLD, await archive({ passphrase: 'a completely different one' }));
    const res = await verify();
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'DECRYPT_FAILED');
  });

  it('502 TRANSPORT_FAILED when the target cannot be read', async () => {
    dav.put(NAME_OLD, await archive());
    dav.failGet = true;
    try {
      const res = await verify();
      assert.equal(res.status, 502);
      assert.equal(res.body.code, 'TRANSPORT_FAILED');
    } finally { dav.failGet = false; }
  });

  it('404 for an unknown target, 400 for a bogus id', async () => {
    assert.equal((await req('post', `${API}/targets/99999/verify`, {})).status, 404);
    assert.equal((await req('post', `${API}/targets/abc/verify`, {})).status, 400);
  });

  it('403 without the scheduled_backups licence', async () => {
    license._overrideForTest({ scheduled_backups: false });
    try {
      const res = await verify();
      assert.equal(res.status, 403);
    } finally { license._overrideForTest({ scheduled_backups: true }); }
  });
});

describe('POST /targets/:id/verify — success', () => {
  it('reads the NEWEST archive, reports content counts and changes nothing', async () => {
    dav.put(NAME_OLD, Buffer.from('older junk that must not be read'));
    const buf = await archive({ encryptionKey: process.env.GC_ENCRYPTION_KEY });
    dav.put(NAME_NEW, buf);
    const before = remoteNames();

    const res = await verify();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.file, NAME_NEW, 'newest by name');
    assert.equal(res.body.size, buf.length);
    assert.equal(res.body.include_key, true);
    assert.equal(res.body.gc_version, require('../package.json').version);
    assert.ok(Date.parse(res.body.created_at) > 0);
    const c = res.body.counts;
    assert.deepEqual(Object.keys(c).sort(), ['peers', 'routes', 'settings', 'users']);
    for (const k of Object.keys(c)) assert.equal(typeof c[k], 'number');
    assert.ok(c.users >= 1, 'the seeded admin is in the backup');
    assert.ok(Array.isArray(res.body.warnings));
    assert.ok(!res.body.warnings.includes('no_encryption_key'));
    assert.ok(!res.body.warnings.includes('version_differs'));

    assert.deepEqual(remoteNames(), before, 'no file added, renamed or deleted');
    assert.deepEqual(dav.files.get('/dav/gc/' + NAME_NEW), buf, 'the archive itself is untouched');
  });

  it('warns about a missing key and a different GateControl version', async () => {
    dav.put(NAME_NEW, await archive({ gcVersion: '0.0.1' })); // no encryptionKey
    const res = await verify();
    assert.equal(res.status, 200);
    assert.ok(res.body.warnings.includes('no_encryption_key'));
    assert.ok(res.body.warnings.includes('version_differs'));
    assert.equal(res.body.include_key, false);
  });

  it('CORRUPT when the archive decrypts but is not a usable backup', async () => {
    const bad = { version: 4, created_at: new Date().toISOString(), data: { peers: 'nope', routes: [], settings: [], webhooks: [] } };
    dav.put(NAME_NEW, await archive({ backup: bad }));
    const res = await verify();
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'CORRUPT');
  });
});

describe('the result is stored for the security check', () => {
  it('last_verify_at / last_verify_status land in the row and in GET /targets', async () => {
    dav.put(NAME_NEW, await archive({ encryptionKey: process.env.GC_ENCRYPTION_KEY }));
    await verify();
    const row = db.prepare('SELECT last_verify_at, last_verify_status, last_verify_detail FROM backup_targets WHERE id = ?').get(targetId);
    assert.ok(Date.parse(row.last_verify_at) > 0);
    assert.ok(['ok', 'warning'].includes(row.last_verify_status));
    assert.equal(JSON.parse(row.last_verify_detail).file, NAME_NEW);

    const list = await getAgent().get(`${API}/targets`);
    const t = list.body.targets.find((x) => x.id === targetId);
    assert.equal(t.last_verify_at, row.last_verify_at);
    assert.equal(t.last_verify_status, row.last_verify_status);
    assert.equal(t.last_verify.file, NAME_NEW);
    assert.ok(!JSON.stringify(list.body).includes(PASS), 'no secret in the answer');
  });

  it('a failed run is recorded as failed with the code', async () => {
    dav.put(NAME_NEW, Buffer.from('rubbish'));
    const res = await verify();
    assert.equal(res.status, 400);
    const row = db.prepare('SELECT last_verify_status, last_verify_detail FROM backup_targets WHERE id = ?').get(targetId);
    assert.equal(row.last_verify_status, 'failed');
    assert.equal(JSON.parse(row.last_verify_detail).code, 'CORRUPT');
  });

  it('staleVerifications: never tested and older than 30 days count, a fresh one does not', () => {
    const offsite = require('../src/services/offsite');
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    const rows = [
      { id: 1, name: 'never', last_verify_at: null, last_verify_status: null },
      { id: 2, name: 'old', last_verify_at: old, last_verify_status: 'ok' },
      { id: 3, name: 'fresh', last_verify_at: now, last_verify_status: 'ok' },
      { id: 4, name: 'warned', last_verify_at: now, last_verify_status: 'warning' },
      { id: 5, name: 'failed', last_verify_at: now, last_verify_status: 'failed' },
    ];
    assert.deepEqual(offsite.staleVerifications(rows).map((r) => r.name), ['never', 'old', 'failed']);
    assert.equal(offsite.VERIFY_STALE_MS, 30 * 24 * 3600 * 1000);
  });
});

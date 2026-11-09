'use strict';

// The off-site transports (services/offsite) against real servers — the
// same ones as tests/storage_targets_live.test.js, started by the CI job
// "storage targets (S3, WebDAV, SMB)" (.github/workflows/test.yml): S3
// (moto / MinIO), WebDAV (wsgidav / Nextcloud), SMB (Samba with smbclient,
// SMB3 encryption required). Each part runs only when its server is named
// in the environment (the GC_TEST_* variables listed there).
//
// A real archive (gcbk.writeBackupArchive of a backup file with
// incompressible plugin data) goes up from its FILE — S3 as a multipart
// upload (the part size lowered to S3's minimum of 5 MiB) and as one PUT —
// comes back into a file byte for byte (downloadTo) and still decrypts.

require('./helpers/test-env');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gcbk = require('../src/services/offsite/gcbk');

const env = process.env;
const RUN = crypto.randomBytes(3).toString('hex');
const LIVE = {
  s3: env.GC_TEST_S3_ENDPOINT ? {
    endpoint: env.GC_TEST_S3_ENDPOINT, region: 'us-east-1', bucket: env.GC_TEST_S3_BUCKET, prefix: `gc-offsite-${RUN}`,
    access_key_id: env.GC_TEST_S3_KEY, secret_access_key: env.GC_TEST_S3_SECRET, path_style: true,
  } : null,
  webdav: env.GC_TEST_WEBDAV_URL ? {
    url: `${env.GC_TEST_WEBDAV_URL.replace(/\/+$/, '')}/gc-offsite-${RUN}/`, username: env.GC_TEST_WEBDAV_USER, password: env.GC_TEST_WEBDAV_PASSWORD,
  } : null,
  smb: env.GC_TEST_SMB_HOST ? {
    host: env.GC_TEST_SMB_HOST, port: Number(env.GC_TEST_SMB_PORT || 445), share: env.GC_TEST_SMB_SHARE, path: `gc-offsite-${RUN}/sub`,
    username: env.GC_TEST_SMB_USER, password: env.GC_TEST_SMB_PASSWORD, encrypt: true,
  } : null,
};

const PASS = 'live test passphrase';
const KDF = { N: 1024, r: 8, p: 1 };
const S3_MIN_PART = 5 * 1024 * 1024;

let dir;
let archive; // { path, size, partSize, partHashes, sha }

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

before(async () => {
  if (!LIVE.s3 && !LIVE.webdav && !LIVE.smb) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-offsite-live-'));
  // a backup file with ~12 MB of incompressible plugin data → an archive of ~12 MB (three S3 parts)
  const json = path.join(dir, 'gatecontrol-20261109-030000.json');
  fs.writeFileSync(json, JSON.stringify({ version: 1, data: { settings: [], plugins: [{ id: 'blob', db: crypto.randomBytes(12 * 1024 * 1024).toString('base64') }] } }, null, 2));
  const file = path.join(dir, 'archive.gcbk');
  const r = await gcbk.writeBackupArchive(json, file, { passphrase: PASS, kdf: KDF, gcVersion: 'live', partSize: S3_MIN_PART });
  archive = { path: file, ...r, sha: sha(file) };
  assert.equal(archive.partHashes.length, 3);
});
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

/** downloadTo into a fresh file → it decrypts to the backup that went in. */
async function backAndDecrypt(t, cfg, name) {
  const back = path.join(dir, `back-${crypto.randomBytes(4).toString('hex')}`);
  const n = await t.downloadTo(cfg, name, back, undefined, { maxBytes: 64 * 1024 * 1024, size: archive.size });
  assert.equal(n, archive.size);
  assert.equal(sha(back), archive.sha, 'byte for byte');
  const plain = back + '.json';
  await gcbk.decryptBackupFileTo(back, PASS, plain);
  const payload = gcbk.checkPayload(JSON.parse(fs.readFileSync(plain, 'utf8')));
  assert.equal(payload.backup.data.plugins[0].id, 'blob');
  fs.rmSync(back);
  fs.rmSync(plain);
}

for (const kind of ['s3', 'webdav', 'smb']) {
  const cfg = LIVE[kind];
  describe(`live off-site ${kind}`, { skip: cfg ? false : `GC_TEST_${kind.toUpperCase()}_* not set` }, () => {
    const t = () => require(`../src/services/offsite/${kind}`);

    it('the write test passes', async () => {
      assert.match(await t().test(cfg), /write \+ delete ok/);
    });

    it('an archive goes up from its file, is listed with its size, comes back byte for byte and decrypts', { timeout: 300000 }, async () => {
      const name = 'gatecontrol-20261109-030000.gcbk';
      await t().upload(cfg, name, archive);
      const listed = (await t().list(cfg)).filter((f) => f.name === name);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].size, archive.size);
      assert.ok(fs.existsSync(archive.path), 'the archive file stays the caller\'s');
      await backAndDecrypt(t(), cfg, name);
      await t().remove(cfg, name);
      assert.equal((await t().list(cfg)).some((f) => f.name === name), false);
    });

    it('S3: multipart with the part hashes computed while writing, with hashes read from the file, and one PUT below the part size', { skip: kind !== 's3' ? 'S3 only' : false, timeout: 300000 }, async () => {
      const lim = t()._limits;
      const saved = lim.part;
      try {
        lim.part = S3_MIN_PART; // three parts, the last one short — with the writer's hashes
        await t().upload(cfg, 'gatecontrol-20261109-040000.gcbk', archive);
        await backAndDecrypt(t(), cfg, 'gatecontrol-20261109-040000.gcbk');
        lim.part = S3_MIN_PART + 1024 * 1024; // other parts than the writer hashed: each part hashed from the file
        await t().upload(cfg, 'gatecontrol-20261109-050000.gcbk', archive);
        await backAndDecrypt(t(), cfg, 'gatecontrol-20261109-050000.gcbk');
        lim.part = 64 * 1024 * 1024; // the archive fits into one PUT
        await t().upload(cfg, 'gatecontrol-20261109-060000.gcbk', { path: archive.path, size: archive.size });
        await backAndDecrypt(t(), cfg, 'gatecontrol-20261109-060000.gcbk');
      } finally { lim.part = saved; }
      for (const n of ['040000', '050000', '060000']) await t().remove(cfg, `gatecontrol-20261109-${n}.gcbk`);
    });
  });
}

'use strict';

// The storage target drivers against real servers (docs/storage-targets.md):
// S3 (moto / MinIO), WebDAV (wsgidav / Nextcloud), SMB (Samba). Each part
// runs only when its server is named in the environment — the CI job
// "storage-targets" (.github/workflows/test.yml) starts all three:
//
//   GC_TEST_S3_ENDPOINT, GC_TEST_S3_BUCKET, GC_TEST_S3_KEY, GC_TEST_S3_SECRET (GC_TEST_S3_NO_AUTH=1: keys not checked)
//   GC_TEST_WEBDAV_URL, GC_TEST_WEBDAV_USER, GC_TEST_WEBDAV_PASSWORD
//   GC_TEST_SMB_HOST, GC_TEST_SMB_PORT, GC_TEST_SMB_SHARE, GC_TEST_SMB_USER, GC_TEST_SMB_PASSWORD

require('./helpers/test-env');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const env = process.env;
const LIVE = {
  s3: env.GC_TEST_S3_ENDPOINT ? {
    config: { endpoint: env.GC_TEST_S3_ENDPOINT, region: 'us-east-1', bucket: env.GC_TEST_S3_BUCKET, prefix: 'gc-test', pathStyle: true, accessKeyId: env.GC_TEST_S3_KEY },
    secret: { secretAccessKey: env.GC_TEST_S3_SECRET }, wrong: { secretAccessKey: 'wrong-secret' },
  } : null,
  webdav: env.GC_TEST_WEBDAV_URL ? {
    config: { url: env.GC_TEST_WEBDAV_URL.replace(/\/?$/, '/gc-test'), username: env.GC_TEST_WEBDAV_USER },
    secret: { password: env.GC_TEST_WEBDAV_PASSWORD }, wrong: { password: 'wrong-password' },
  } : null,
  smb: env.GC_TEST_SMB_HOST ? {
    config: { via: { kind: 'host', host: env.GC_TEST_SMB_HOST, port: Number(env.GC_TEST_SMB_PORT || 445) }, share: env.GC_TEST_SMB_SHARE, folder: 'gc-test/sub', username: env.GC_TEST_SMB_USER },
    secret: { password: env.GC_TEST_SMB_PASSWORD }, wrong: { password: 'wrong-password' },
  } : null,
};

function targets() { return require('../src/services/storageTargets'); }
function source(buf) { return { length: buf.length, open: (s, e) => Readable.from([buf.subarray(s, e + 1)]) }; }
async function collect(stream) { const p = []; for await (const c of stream) p.push(c); return Buffer.concat(p); }

for (const kind of ['s3', 'webdav', 'smb']) {
  const L = LIVE[kind];
  describe(`live ${kind}`, { skip: L ? false : `GC_TEST_${kind.toUpperCase()}_* not set` }, () => {
    let d;
    before(async () => {
      d = await targets().driverOf({ kind, config: L.config, secret: L.secret });
      await d.prepare();
    });

    it('writes, reads whole and in ranges, renames and deletes — names with spaces, ";" and umlauts', async () => {
      const data = crypto.randomBytes(300 * 1024 + 7);
      const key = kind === 's3' ? 'ab/obj-1' : 'Fotos 2026/Strand; Tag 1/Bild ä.jpg';
      await d.put(key, source(data));
      const h = await d.head(key);
      assert.equal(h.size, data.length);
      assert.ok(h.mtime > 0);
      assert.ok((await collect(await d.get(key))).equals(data));
      assert.ok((await collect(await d.get(key, { start: 65536, end: 200000 }))).equals(data.subarray(65536, 200001)));
      assert.ok((await collect(await d.get(key, { start: data.length - 5, end: data.length - 1 }))).equals(data.subarray(data.length - 5)));
      let at = key;
      if (d.move) {
        at = 'Archiv/verschoben.bin';
        await d.move(key, at);
        assert.equal(await d.head(key), null);
        assert.equal((await d.head(at)).size, data.length);
      }
      assert.equal(await d.remove(at), true);
      assert.equal(await d.head(at), null);
      // S3 answers 204 for a missing key too: only SMB / WebDAV can tell
      if (kind !== 's3') assert.equal(await d.remove(at), false);
    });

    it('a missing object: head null, get not_found', async () => {
      assert.equal(await d.head('nope/missing'), null);
      await assert.rejects(async () => collect(await d.get('nope/missing')), (e) => e.code === 'not_found');
    });

    // moto does not check signatures (GC_TEST_S3_NO_AUTH=1); MinIO and the providers do
    it('a wrong password / key fails with auth', { skip: kind === 's3' && env.GC_TEST_S3_NO_AUTH === '1' ? 'the S3 test server does not check keys' : false }, async () => {
      const r = await targets().checkInput(kind, Object.assign({ label: 'falsch' }, L.config, L.config.via ? { host: L.config.via.host, port: L.config.via.port } : {}, L.wrong));
      assert.equal(r.ok, false);
      assert.equal(r.error, 'auth', JSON.stringify(r));
    });

    it('the full check passes', async () => {
      const r = await targets().checkInput(kind, Object.assign({ label: 'ok' }, L.config, L.config.via ? { host: L.config.via.host, port: L.config.via.port } : {}, L.secret));
      assert.equal(r.ok, true, JSON.stringify(r));
    });

    it('a large object (multipart for S3) arrives byte for byte', { timeout: 300000 }, async () => {
      const size = 70 * 1024 * 1024 + 123;
      const data = crypto.randomBytes(size);
      await d.put('big/one', source(data));
      assert.equal((await d.head('big/one')).size, size);
      const back = await collect(await d.get('big/one'));
      assert.equal(crypto.createHash('sha256').update(back).digest('hex'), crypto.createHash('sha256').update(data).digest('hex'));
      await d.remove('big/one');
    });
  });
}

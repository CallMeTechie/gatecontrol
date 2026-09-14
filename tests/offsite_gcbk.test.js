'use strict';

// GCBK1 archive format, re-keying, the decrypt CLI and the restore endpoints
// accepting .gcbk (docs/feature-release-b.md §7).

process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const gcbk = require('../src/services/offsite/gcbk');
const { rekeyBackup, encryptWith, decryptWith } = require('../src/services/offsite/rekey');

const FAST = { N: 1024, r: 8, p: 1 }; // tests only — production uses N=2^17
const PASS = 'correct horse battery staple';
const CLI = path.join(__dirname, '..', 'src', 'bin', 'offsite-decrypt.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gcbk-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('GCBK1 format', () => {
  const backup = { version: 4, created_at: '2026-09-14T00:00:00Z', data: { peers: [], routes: [], settings: [{ key: 'a', value: 'ä€😀' }], webhooks: [] } };

  it('round trip with the archived key; layout magic | len | header | ct | tag', async () => {
    const key = crypto.randomBytes(32).toString('hex');
    const buf = await gcbk.encryptBackup(backup, { passphrase: PASS, encryptionKey: key, gcVersion: '1.126.0', kdf: FAST });
    assert.equal(buf.subarray(0, 5).toString('ascii'), 'GCBK1');
    assert.ok(gcbk.isGcbk(buf));
    const { header } = gcbk.readHeader(buf);
    assert.equal(header.kdf, 'scrypt');
    assert.equal(header.cipher, 'aes-256-gcm');
    assert.equal(header.include_key, true);
    assert.equal(header.gc_version, '1.126.0');
    assert.ok(!buf.includes(Buffer.from(key)), 'key never in clear');
    assert.ok(!buf.includes(Buffer.from('ä€😀')), 'content encrypted');
    const { payload } = await gcbk.decryptBackup(buf, PASS);
    assert.deepEqual(payload.backup, backup);
    assert.equal(payload.encryption_key, key);
    assert.equal(payload.format, 'gatecontrol-offsite');
  });

  it('default KDF is scrypt N=2^17, r=8, p=1', () => {
    assert.deepEqual({ ...gcbk.DEFAULT_KDF }, { N: 131072, r: 8, p: 1 });
  });

  it('without include_key there is no key in the payload', async () => {
    const buf = await gcbk.encryptBackup(backup, { passphrase: PASS, kdf: FAST });
    const { header, payload } = await gcbk.decryptBackup(buf, PASS);
    assert.equal(header.include_key, false);
    assert.equal(payload.encryption_key, undefined);
  });

  it('wrong passphrase → DECRYPT_FAILED', async () => {
    const buf = await gcbk.encryptBackup(backup, { passphrase: PASS, kdf: FAST });
    await assert.rejects(gcbk.decryptBackup(buf, PASS + 'x'), { code: 'DECRYPT_FAILED' });
  });

  it('a flipped bit anywhere (header included, it is AAD) is detected', async () => {
    const buf = await gcbk.encryptBackup(backup, { passphrase: PASS, kdf: FAST });
    const hlen = buf.readUInt16BE(5);
    // header byte inside created_at (still valid JSON), body, tag
    const createdAt = buf.indexOf(Buffer.from('"created_at":"')) + 16;
    for (const pos of [createdAt, 7 + hlen + 3, buf.length - 1]) {
      const bad = Buffer.from(buf);
      bad[pos] ^= 0x01;
      await assert.rejects(gcbk.decryptBackup(bad, PASS), (e) => ['DECRYPT_FAILED', 'CORRUPT'].includes(e.code), `pos ${pos}`);
    }
  });

  it('hostile headers are refused before any KDF work', () => {
    const mk = (h) => {
      const hb = Buffer.from(JSON.stringify(h));
      const len = Buffer.alloc(2); len.writeUInt16BE(hb.length);
      return Buffer.concat([Buffer.from('GCBK1'), len, hb, Buffer.alloc(32)]);
    };
    const base = { kdf: 'scrypt', N: 1024, r: 8, p: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64'), cipher: 'aes-256-gcm' };
    for (const h of [{ ...base, N: 1 << 22 }, { ...base, N: 3000 }, { ...base, r: 64 }, { ...base, kdf: 'none' }, { ...base, iv: 'AA==' }]) {
      assert.throws(() => gcbk.readHeader(mk(h)), { code: 'UNSUPPORTED' });
    }
    assert.throws(() => gcbk.readHeader(Buffer.from('GCBK1')), { code: 'CORRUPT' });
    assert.throws(() => gcbk.readHeader(Buffer.from('{"json":1}')), { code: 'NOT_GCBK' });
  });

  it('passphrase shorter than 12 characters is refused', async () => {
    await assert.rejects(gcbk.encryptBackup(backup, { passphrase: 'short', kdf: FAST }), { code: 'PASSPHRASE_TOO_SHORT' });
  });

  it('payload is gzip-compressed JSON', async () => {
    const big = { ...backup, data: { ...backup.data, settings: Array.from({ length: 2000 }, (_, i) => ({ key: `k${i}`, value: 'same value' })) } };
    const buf = await gcbk.encryptBackup(big, { passphrase: PASS, kdf: FAST });
    assert.ok(buf.length < JSON.stringify(big).length / 5);
    assert.ok(zlib.gzipSync); // (sanity: builtin only)
  });
});

describe('rekeyBackup', () => {
  const k1 = crypto.randomBytes(32).toString('hex');
  const k2 = crypto.randomBytes(32).toString('hex');
  it('re-encrypts every ciphertext at any depth; leaves look-alikes and plain values alone', () => {
    const lookAlike = `${'a'.repeat(24)}:${'b'.repeat(32)}:cafe`;
    const src = {
      data: {
        settings: [{ key: 'smtp_password_encrypted', value: encryptWith(k1, 'smtp-secret') }, { key: 'plain', value: 'x' }],
        peers: [{ name: 'p', private_key_encrypted: encryptWith(k1, 'wg-private') }],
        rdp_routes: [{ nested: { deeper: [encryptWith(k1, 'rdp-pass')] } }],
        weird: lookAlike,
        n: 5,
      },
    };
    const { backup, converted } = rekeyBackup(src, k1, k2);
    assert.equal(converted, 3);
    assert.equal(decryptWith(k2, backup.data.settings[0].value), 'smtp-secret');
    assert.equal(decryptWith(k2, backup.data.peers[0].private_key_encrypted), 'wg-private');
    assert.equal(decryptWith(k2, backup.data.rdp_routes[0].nested.deeper[0]), 'rdp-pass');
    assert.equal(backup.data.weird, lookAlike);
    assert.equal(backup.data.settings[1].value, 'x');
    assert.equal(backup.data.n, 5);
    assert.throws(() => decryptWith(k1, backup.data.settings[0].value));
    assert.equal(decryptWith(k1, src.data.settings[0].value), 'smtp-secret', 'input not mutated');
  });
});

describe('src/bin/offsite-decrypt.js', () => {
  let file;
  const key = crypto.randomBytes(32).toString('hex');
  const backup = { version: 4, data: { peers: [], routes: [], settings: [], webhooks: [] } };
  before(async () => {
    file = path.join(tmp, 'gatecontrol-20260914-030000.gcbk');
    fs.writeFileSync(file, await gcbk.encryptBackup(backup, { passphrase: PASS, encryptionKey: key, kdf: FAST }));
  });
  const run = (args, env = {}, input) => spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH, ...env }, input, encoding: 'utf8', timeout: 30000,
  });

  it('decrypts to stdout with GC_OFFSITE_PASSPHRASE, notes the archived key on stderr only', () => {
    const r = run([file], { GC_OFFSITE_PASSPHRASE: PASS });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), backup);
    assert.match(r.stderr, /contains the GC_ENCRYPTION_KEY/);
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), 'key never printed');
  });

  it('--out / --key-out write 0600 files; passphrase from a file', () => {
    const pf = path.join(tmp, 'pass'); fs.writeFileSync(pf, PASS + '\n');
    const out = path.join(tmp, 'b.json'); const ko = path.join(tmp, 'key');
    const r = run([file, '-p', pf, '-o', out, '-k', ko]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), backup);
    assert.equal(fs.readFileSync(ko, 'utf8').trim(), key);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    assert.equal(fs.statSync(ko).mode & 0o777, 0o600);
  });

  it('passphrase from a pipe; wrong passphrase → exit 1', () => {
    assert.equal(run([file], {}, PASS + '\n').status, 0);
    const bad = run([file], {}, 'wrong passphrase!!\n');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /wrong passphrase or damaged file/);
  });

  it('--info shows the header without a passphrase; usage errors → exit 2', () => {
    const r = run([file, '--info']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).include_key, true);
    assert.equal(run([]).status, 2);
    assert.equal(run([file, '--bogus']).status, 2);
  });
});

describe('restore accepts .gcbk', () => {
  const helpers = require('./helpers/setup');
  let config;
  let csrfAfterRestore;
  before(async () => {
    await helpers.setup();
    config = require('../config/default');
  });
  after(() => helpers.teardown());

  async function archiveOfThisInstallation({ foreignKey } = {}) {
    const backupSvc = require('../src/services/backup');
    const settings = require('../src/services/settings');
    const { encrypt } = require('../src/utils/crypto');
    settings.set('smtp_password_encrypted', encrypt('smtp-secret-123'));
    let data = backupSvc.createBackup();
    let embedded = config.encryption.key;
    if (foreignKey) {
      // Simulate a backup from ANOTHER installation: its secrets are under foreignKey.
      data = rekeyBackup(data, config.encryption.key, foreignKey).backup;
      embedded = foreignKey;
    }
    return gcbk.encryptBackup(data, { passphrase: PASS, encryptionKey: embedded, kdf: FAST });
  }

  it('preview: passphrase from the form → summary + encrypted flag', async () => {
    const buf = await archiveOfThisInstallation();
    const res = await helpers.getAgent().post('/api/v1/settings/restore/preview')
      .set('X-CSRF-Token', helpers.getCsrf())
      .field('passphrase', PASS)
      .attach('backup', buf, 'gatecontrol-20260914-030000.gcbk');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.encrypted, true);
    assert.equal(res.body.include_key, true);
    assert.ok(res.body.summary);
  });

  it('wrong passphrase → 400 DECRYPT_FAILED; none configured and none given → 400 PASSPHRASE_REQUIRED', async () => {
    const buf = await archiveOfThisInstallation();
    let res = await helpers.getAgent().post('/api/v1/settings/restore/preview')
      .set('X-CSRF-Token', helpers.getCsrf()).field('passphrase', 'definitely wrong!!')
      .attach('backup', buf, 'x.gcbk');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'DECRYPT_FAILED');
    res = await helpers.getAgent().post('/api/v1/settings/restore/preview')
      .set('X-CSRF-Token', helpers.getCsrf()).attach('backup', buf, 'x.gcbk');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PASSPHRASE_REQUIRED');
  });

  it('restore of an archive from another installation re-keys the secrets', async () => {
    const foreign = crypto.randomBytes(32).toString('hex');
    const buf = await archiveOfThisInstallation({ foreignKey: foreign });
    const res = await helpers.getAgent().post('/api/v1/settings/restore')
      .set('X-CSRF-Token', helpers.getCsrf()).field('passphrase', PASS)
      .attach('backup', buf, 'x.gcbk');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    csrfAfterRestore = res.body.csrfToken; // restore rotates the CSRF token
    const { decrypt } = require('../src/utils/crypto');
    const v = require('../src/services/settings').get('smtp_password_encrypted');
    assert.equal(decrypt(v), 'smtp-secret-123', 'decryptable with THIS installation\'s key');
  });

  it('configured passphrase is used when the form has none (same installation)', async () => {
    const offsite = require('../src/services/offsite');
    offsite.updateOffsiteSettings({ passphrase: PASS });
    const buf = await archiveOfThisInstallation();
    const res = await helpers.getAgent().post('/api/v1/settings/restore/preview')
      .set('X-CSRF-Token', csrfAfterRestore).attach('backup', buf, 'x.gcbk');
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

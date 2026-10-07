'use strict';

// Plugin packages (docs/plugins.md): the .gcplugin container, signatures,
// plugin.json validation and the compatibility range — no server needed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { helloPackage, HELLO, trusted } = require('./helpers/plugins');
const pkg = require('../src/services/plugins/package');
const signature = require('../src/services/plugins/signature');
const manifest = require('../src/services/plugins/manifest');
const semver = require('../src/services/plugins/semver');
const { packDir } = require('../scripts/plugin-pack');
const { LIMITS } = require('../src/services/plugins/constants');

/** A raw container with arbitrary (also invalid) entries, gzipped. */
function rawPackage(entries, { trailing } = {}) {
  const parts = [pkg.MAGIC];
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const h = Buffer.alloc(2); h.writeUInt16BE(n.length);
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const s = Buffer.alloc(4); s.writeUInt32BE(d.length);
    parts.push(h, n, s, d);
  }
  parts.push(Buffer.alloc(2));
  if (trailing) parts.push(Buffer.from(trailing));
  return zlib.gzipSync(Buffer.concat(parts));
}

function code(fn) { try { fn(); } catch (e) { return e.code; } return 'no error'; }

describe('package container', () => {
  it('round-trips the example plugin', () => {
    const files = pkg.decode(helloPackage());
    assert.ok(files.has('plugin.json') && files.has('server/index.js') && files.has('migrations/001_init.sql') && files.has('signature'));
  });
  it('rejects path traversal, absolute paths, backslashes and hidden segments', () => {
    for (const bad of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'a\\b.js', '.hidden', 'a/./b', 'a//b', '']) {
      assert.equal(code(() => pkg.decode(rawPackage([['plugin.json', '{}'], [bad, 'x']]))), bad === '' ? 'corrupt' : 'bad_path', JSON.stringify(bad));
    }
  });
  it('rejects duplicates (also case-only), file/folder clashes and trailing data', () => {
    assert.equal(code(() => pkg.decode(rawPackage([['a.js', '1'], ['a.js', '2']]))), 'duplicate');
    assert.equal(code(() => pkg.decode(rawPackage([['A.js', '1'], ['a.js', '2']]))), 'duplicate');
    assert.equal(code(() => pkg.decode(rawPackage([['a', '1'], ['a/b.js', '2']]))), 'bad_path');
    assert.equal(code(() => pkg.decode(rawPackage([['a.js', '1']], { trailing: 'junk' }))), 'corrupt');
  });
  it('rejects non-packages and truncated data', () => {
    assert.equal(code(() => pkg.decode(Buffer.from('PK\x03\x04 this is a zip file, not ours'))), 'not_a_package');
    assert.equal(code(() => pkg.decode(zlib.gzipSync(Buffer.from('GCPLUGIN no magic here')))), 'not_a_package');
    const ok = helloPackage();
    assert.equal(code(() => pkg.decode(ok.subarray(0, ok.length - 30))), 'corrupt');
  });
  it('caps the upload size, the unpacked size (gzip bomb) and the file count', () => {
    assert.equal(code(() => pkg.decode(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(LIMITS.packageBytes)]))), 'too_large');
    const bomb = rawPackage([['big.bin', Buffer.alloc(LIMITS.unpackedBytes + 10)]]);
    assert.ok(bomb.length < LIMITS.packageBytes, 'compresses well');
    assert.equal(code(() => pkg.decode(bomb)), 'too_large');
    const many = Array.from({ length: LIMITS.fileCount + 1 }, (_, i) => [`f${i}.txt`, 'x']);
    assert.equal(code(() => pkg.decode(rawPackage(many))), 'too_many_files');
  });
  it('the packing tool refuses symbolic links', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-plugpack-'));
    try {
      fs.cpSync(HELLO, dir, { recursive: true });
      fs.symlinkSync('/etc/passwd', path.join(dir, 'server', 'passwd'));
      assert.throws(() => packDir(dir, { signingKey: '' }), /symbolic links are not allowed/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('signatures', () => {
  it('trusted key → trusted; any changed file → invalid', () => {
    const files = pkg.decode(helloPackage());
    assert.equal(signature.verify(files).status, 'trusted');
    const changed = new Map(files);
    changed.set('server/index.js', Buffer.from('module.exports = {}'));
    assert.equal(signature.verify(changed).status, 'invalid');
    const added = new Map(files);
    added.set('server/extra.js', Buffer.from('x'));
    assert.equal(signature.verify(added).status, 'invalid');
    const removed = new Map(files);
    removed.delete('CHANGELOG.md');
    assert.equal(signature.verify(removed).status, 'invalid');
  });
  it('unknown key → untrusted, no signature → none, garbage → invalid', () => {
    assert.equal(signature.verify(pkg.decode(helloPackage({ sign: 'stranger' }))).status, 'untrusted');
    assert.equal(signature.verify(pkg.decode(helloPackage({ sign: false }))).status, 'none');
    const files = pkg.decode(helloPackage({ sign: false }));
    files.set('signature', Buffer.from('{"v":1,"alg":"Ed25519","publicKey":"x","sig":"y"}'));
    assert.equal(signature.verify(files).status, 'invalid');
    files.set('signature', Buffer.from('not json'));
    assert.equal(signature.verify(files).status, 'invalid');
  });
  it('a swapped signature file (other key, same files) does not verify', () => {
    const a = pkg.decode(helloPackage({ sign: 'stranger' }));
    const b = pkg.decode(helloPackage({ overrides: { version: '1.0.1' } }));
    b.set('signature', a.get('signature'));
    assert.equal(signature.verify(b).status, 'invalid');
  });
  it('accepts a PEM key and a base64 seed; keys from GC_PLUGIN_PUBKEYS are trusted', () => {
    const pem = require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    assert.equal(signature.privateKeyFrom(pem).asymmetricKeyType, 'ed25519');
    assert.equal(signature.privateKeyFrom(trusted.privateSeed).asymmetricKeyType, 'ed25519');
    assert.ok(signature.trustedKeys().includes(trusted.publicKey));
    assert.throws(() => signature.privateKeyFrom('c2hvcnQ='), /32-byte seed/);
  });
});

describe('plugin.json', () => {
  const base = () => JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
  const files = new Set(['server/index.js']);
  it('the example manifest is valid and normalised', () => {
    const r = manifest.validate(base(), { files });
    assert.equal(r.ok, true, r.errors.join());
    const n = r.manifest.permissions.network;
    assert.deepEqual(n.internet, ['api.example.com:443', '*.cloud.example']);
    assert.deepEqual(n.homeTargets.map((t) => [t.id, t.proto]), [['gateway', { http: true, tcp: [], udp: [] }], ['device', { http: false, tcp: ['6444'], udp: ['6445'] }]]);
    assert.deepEqual(n.localDiscovery, { udp: ['6445', '20086'] });
  });
  it('rejects bad ids, versions, ranges, entries and permissions', () => {
    const cases = [
      [{ id: 'Bad_ID' }, 'id: invalid'], [{ id: '../x' }, 'id: invalid'], [{ version: '1.0' }, 'version: invalid'],
      [{ gatecontrol: 'not a range' }, 'gatecontrol: invalid'], [{ entry: '../server.js' }, 'entry: invalid'],
      [{ entry: 'server/missing.js' }, 'entry: missing'],
      [{ permissions: { portal: true, network: ['http://x'] } }, 'permissions.network.internet: invalid'],
      [{ permissions: { portal: true, lan: true } }, 'permissions.lan: replaced by permissions.network.homeTargets / localDiscovery'],
      [{ permissions: { portal: true, network: { homeTargets: [{ id: 'gw', label: 'x', protocols: ['ssh:22'] }] } } }, 'permissions.network.homeTargets: invalid protocol'],
      [{ permissions: { portal: true, network: { homeTargets: [{ id: 'gw', label: 'x', protocols: ['tcp:70000'] }] } } }, 'permissions.network.homeTargets: invalid protocol'],
      [{ permissions: { portal: true, network: { homeTargets: [{ id: 'Bad id', label: 'x', protocols: ['http'] }] } } }, 'permissions.network.homeTargets: invalid'],
      [{ permissions: { portal: true, network: { localDiscovery: { tcp: [1] } } } }, 'permissions.network.localDiscovery: invalid'],
      [{ license: { required: true, server: 'http://plain.example' } }, 'license.server: must be an https URL'],
      [{ ui: { portal: { label: 'x' } }, permissions: {} }, 'ui.portal: needs permissions.portal'],
      [{ ui: { pages: [{ id: 'frame', title: 'x' }] } }, 'ui.pages: duplicate'],
    ];
    for (const [patch, err] of cases) {
      const r = manifest.validate({ ...base(), ...patch }, { files });
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.ok(r.errors.includes(err), JSON.stringify(patch) + ' → ' + r.errors.join(', '));
    }
  });
});

describe('compatibility (semver)', () => {
  it('ranges', () => {
    assert.equal(semver.satisfies('1.146.0', '>=1.146.0'), true);
    assert.equal(semver.satisfies('1.145.9', '>=1.146'), false);
    assert.equal(semver.satisfies('1.150.2', '^1.146.0'), true);
    assert.equal(semver.satisfies('2.0.0', '^1.146.0'), false);
    assert.equal(semver.satisfies('1.146.5', '~1.146.0'), true);
    assert.equal(semver.satisfies('1.147.0', '~1.146.0'), false);
    assert.equal(semver.satisfies('1.140.0', '<1.146 || >=2'), true);
    assert.equal(semver.satisfies('1.146.0-rc.1', '>=1.146.0'), false);
    assert.equal(semver.validRange('>=1.146 garbage'), false);
    assert.equal(semver.compare('1.10.0', '1.9.9'), 1);
  });
});

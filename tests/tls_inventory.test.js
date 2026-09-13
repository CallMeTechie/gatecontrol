'use strict';
// Certificate inventory from Caddy's storage: <dataDir>/caddy/certificates/<ca>/<host>/<host>.crt
// (+ legacy <dataDir>/certificates). Issuer from the certificate, CA from the directory.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');

// Self-signed fixture: O=Fixture Authority, CN=nas.example.com, valid to 2126-08-20.
const PEM = `-----BEGIN CERTIFICATE-----
MIIB4DCCAYWgAwIBAgIUbsjOzcDuNepGU7YN0V0c3NaMG0UwCgYIKoZIzj0EAwIw
NjEaMBgGA1UECgwRRml4dHVyZSBBdXRob3JpdHkxGDAWBgNVBAMMD25hcy5leGFt
cGxlLmNvbTAgFw0yNjA5MTMxMjA5NTJaGA8yMTI2MDgyMDEyMDk1MlowNjEaMBgG
A1UECgwRRml4dHVyZSBBdXRob3JpdHkxGDAWBgNVBAMMD25hcy5leGFtcGxlLmNv
bTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABLxfp6RRWIJ5+d4eWeX16tmtX06M
EFK9rOMKov4EEQLtNPU5TxKNmr1E8gqROx4akV5uFu6lza4UyXhtFRS43KSjbzBt
MB0GA1UdDgQWBBQOmURw+P77k/d/wUC/wtJC1bZkZzAfBgNVHSMEGDAWgBQOmURw
+P77k/d/wUC/wtJC1bZkZzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCD25h
cy5leGFtcGxlLmNvbTAKBggqhkjOPQQDAgNJADBGAiEAqZ3YGpgu56krSqCu/tHH
FfcPsUIrlv101ygsMsztizwCIQCr3PHwFLHVylG5CpGNR/HdWZp61BijUl5Wo86n
pPBdsg==
-----END CERTIFICATE-----
`;
const NOT_AFTER = '2126-08-20T12:09:52.000Z';
const NOT_BEFORE = '2026-09-13T12:09:52.000Z';

let tlsGuard, dataDir;
function putCert(rel) {
  const dir = path.join(dataDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(dir);
  fs.writeFileSync(path.join(dir, name + '.crt'), PEM);
  fs.writeFileSync(path.join(dir, name + '.json'), '{}');
}

beforeEach(async () => {
  await setup();
  tlsGuard = require('../src/services/tlsGuard');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tls-inv-'));
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); teardown(); });

test('scanCertificates reads both storage layouts, derives issuer/CA, and inventory writes tls_status', () => {
  putCert('caddy/certificates/acme-v02.api.letsencrypt.org-directory/nas.example.com');
  putCert('caddy/certificates/local/wildcard_.home.lan');
  putCert('certificates/acme-v02.api.letsencrypt.org-directory/legacy.example.com');
  fs.mkdirSync(path.join(dataDir, 'caddy/certificates/local/broken'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'caddy/certificates/local/broken/broken.crt'), 'garbage');

  const certs = tlsGuard.scanCertificates(dataDir);
  assert.equal(certs.size, 3, 'unparsable certificates are skipped');
  const nas = certs.get('nas.example.com');
  assert.equal(nas.issuer, 'Fixture Authority');
  assert.equal(nas.ca, 'acme-v02.api.letsencrypt.org-directory');
  assert.equal(nas.not_after, NOT_AFTER);
  assert.equal(nas.not_before, NOT_BEFORE);
  assert.ok(certs.get('*.home.lan'), 'wildcard_ directory → *.name');
  assert.equal(certs.get('legacy.example.com').ca, 'acme-v02.api.letsencrypt.org-directory');

  const r = tlsGuard.inventory({ dataDir });
  assert.equal(r.hosts, 3);
  const row = tlsGuard.getRow('nas.example.com');
  assert.equal(row.state, 'issued');
  assert.equal(row.not_after, NOT_AFTER);
  assert.equal(row.issuer, 'Fixture Authority');
  assert.equal(tlsGuard.getRow('*.home.lan').state, 'internal', 'local CA → internal');

  const [st] = tlsGuard.statusFor(['nas.example.com']);
  assert.equal(st.state, 'none', 'no route for the name → kind none');
  assert.equal(st.not_after, NOT_AFTER);
  assert.ok(st.days_left > 30000);
  assert.equal(st.issuer, 'Fixture Authority');
});

test('inventory: an error newer than the certificate keeps the failed/paused state; an older pause is released', () => {
  putCert('caddy/certificates/acme-v02.api.letsencrypt.org-directory/nas.example.com');
  tlsGuard.writeRow('nas.example.com', { state: 'failed', attempts: 2, last_error: 'x', last_error_code: 'dns', last_attempt_at: new Date().toISOString() });
  tlsGuard.inventory({ dataDir });
  let row = tlsGuard.getRow('nas.example.com');
  assert.equal(row.state, 'failed'); assert.equal(row.attempts, 2);
  assert.equal(row.not_after, NOT_AFTER, 'certificate data is recorded anyway');

  tlsGuard.writeRow('nas.example.com', { state: 'paused', paused_reason: 'attempts', paused_at: '2026-01-01T00:00:00.000Z', last_attempt_at: '2026-01-01T00:00:00.000Z' });
  const r = tlsGuard.inventory({ dataDir });
  row = tlsGuard.getRow('nas.example.com');
  assert.equal(row.state, 'issued'); assert.equal(row.paused_reason, null); assert.equal(row.attempts, 0);
  assert.equal(r.released, 1);

  tlsGuard.writeRow('nas.example.com', { state: 'paused', paused_reason: 'preflight', paused_at: new Date().toISOString(), last_attempt_at: null, last_error_code: 'preflight:a_mismatch' });
  tlsGuard.inventory({ dataDir });
  assert.equal(tlsGuard.getRow('nas.example.com').state, 'paused', 'a preflight pause newer than the certificate stays');
});

test('inventoryHost scans a single host; missing storage is harmless', () => {
  assert.deepEqual(tlsGuard.inventory({ dataDir: path.join(dataDir, 'nope') }).hosts, 0);
  putCert('caddy/certificates/acme-v02.api.letsencrypt.org-directory/nas.example.com');
  assert.equal(tlsGuard.inventoryHost('other.example.com', { dataDir }), null);
  const e = tlsGuard.inventoryHost('NAS.example.com', { dataDir });
  assert.equal(e.host, 'nas.example.com');
  assert.equal(tlsGuard.getRow('nas.example.com').state, 'issued');
});

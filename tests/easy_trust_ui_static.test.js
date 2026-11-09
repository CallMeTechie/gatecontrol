'use strict';

// The pages for trusting a NAS without a PEM file and for SMB encryption
// (docs/storage-targets.md "Trusting a NAS", "SMB encryption"): the storage
// target dialog (plugins-page.js), the off-site target dialog (settings.njk,
// settings.js, ops-ui.js). Static wiring in the style of
// ops_ui_static.test.js, ops-ui.js's pure helpers, and the words: the main
// path is plain German and English — fingerprint, CA and PEM only under
// "Details" / "Erweitert". The browser walk is tests/e2e/scenarios/13-storage.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const O = require('../public/js/ops-ui.js');

const PLUGINS_JS = read('public/js/plugins-page.js');
const SETTINGS_JS = read('public/js/settings.js');
const SETTINGS_TPL = read('templates/aurora/pages/settings.njk');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function section(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, 'section start ' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, 'section end ' + to);
  return src.slice(a, b);
}

// the words of the main path (no folding needed to read them)
const MAIN = ['trust_title', 'trust_text', 'trust_btn', 'trust_hint_direct', 'trust_hint_vpn', 'trust_changed_title', 'trust_changed_text', 'trust_changed_hint',
  'trust_new_btn', 'trust_remembered', 'trust_remembered_text', 'trust_done', 'trust_stored', 'trust_name', 'trust_name_fix', 'trust_name_vpn', 'f_encrypt',
  'f_encrypt_on', 'f_encrypt_off', 'f_encrypt_old', 'smb_encrypt_tip'];
const JARGON = /\b(PEM|CA|SHA-?256|TLS|SSL|X\.509|SAN|Hash|Root|Chain|Kette|cert\.pem|privkey|OpenSSL|SNI|SMB2|NT_STATUS)\b/;

describe('the words', () => {
  it('the texts the user asked for, exactly', () => {
    for (const p of ['plugins.stg.', 'offsite.']) {
      assert.equal(de[p + 'trust_text'], 'Die NAS weist sich mit einem eigenen Zertifikat aus. Das ist bei NAS-Geräten im Heimnetz üblich.');
      assert.equal(de[p + 'trust_btn'], 'Diesem Gerät vertrauen');
      assert.equal(de[p + 'trust_changed_text'], 'Das Zertifikat der NAS hat sich geändert (z. B. nach einer Erneuerung). Ist das in Ordnung?');
      assert.equal(de[p + 'trust_new_btn'], 'Neues Zertifikat vertrauen');
      assert.equal(de[p + 'trust_remembered'], 'Zertifikat der NAS gemerkt');
      assert.equal(de[p + 'f_encrypt'], 'Verbindung verschlüsseln (SMB3)');
    }
    assert.equal(de['plugins.stg.err_no_encryption'], 'Die Freigabe kann keine Verschlüsselung (SMB3). Bei Synology: Systemsteuerung › Dateidienste › SMB › Erweitert → SMB3-Verschlüsselung.');
    assert.ok(de['offsite.hint.smb_no_encryption'].startsWith(de['plugins.stg.err_no_encryption']));
    assert.equal(de['plugins.stg.err_tls_changed'], de['plugins.stg.trust_changed_text']);
  });
  it('de and en carry every new key, with the same placeholders; no jargon in the main path', () => {
    for (const p of ['plugins.stg.', 'offsite.']) {
      for (const k of MAIN) {
        const key = p + k;
        assert.ok(de[key] && en[key], key);
        const ph = (s) => (s.match(/\{\{?\w+\}?\}/g) || []).sort().join();
        assert.equal(ph(de[key]), ph(en[key]), key);
        assert.doesNotMatch(de[key], JARGON, 'de ' + key);
        assert.doesNotMatch(en[key], JARGON, 'en ' + key);
      }
    }
    for (const k of ['plugins.stg.err_tls', 'plugins.stg.err_tls_changed', 'plugins.stg.err_no_encryption', 'plugins.stg.hint_no_encryption', 'offsite.hint.cert_untrusted',
      'offsite.hint.cert_changed', 'offsite.hint.cert_name', 'offsite.hint.smb_no_encryption', 'offsite.trust_device_line', 'offsite.trust_expired']) {
      assert.ok(de[k] && en[k], k);
      assert.doesNotMatch(de[k], JARGON, 'de ' + k);
      assert.doesNotMatch(en[k], JARGON, 'en ' + k);
    }
    // the details may name the technical things — folded away
    assert.match(de['offsite.trust_fp'], /Fingerabdruck \(SHA-256\)/);
    assert.equal(de['plugins.stg.advanced'], 'Erweitert');
    assert.equal(de['offsite.details'], 'Details');
  });
  it('the old confirmation step with jargon is gone', () => {
    for (const k of ['plugins.stg.tls_trust', 'plugins.stg.tls_trust_title', 'plugins.stg.tls_trust_text', 'plugins.stg.tls_trust_ok', 'plugins.stg.tls_taken', 'offsite.f_ca_set']) {
      assert.equal(de[k], undefined, k);
      assert.equal(en[k], undefined, k);
    }
    assert.doesNotMatch(PLUGINS_JS, /pgx-stg-trust-ask/);
  });
});

describe('storage target dialog (plugins-page.js)', () => {
  const dlg = section(PLUGINS_JS, 'async function targetDialog(', '// Cloud-Konten (docs/cloud-accounts.md)');
  const list = section(PLUGINS_JS, 'function renderStorage()', 'function cacheCard(');
  it('the PEM field lives under "Erweitert"; a stored certificate is one plain line', () => {
    const f = section(dlg, 'function caField()', 'function encryptField()');
    assert.match(f, /el\('details', \{ class: 'pgx-stg-adv', id: 'pgx-stg-adv' \}, \[el\('summary', \{ text: t\('plugins\.stg\.advanced'\) \}\),\s*field\('tlsCa'/);
    assert.match(f, /t\('plugins\.stg\.trust_stored', \{ device: /);
  });
  it('the card: plain text, device and validity, "Details" folded, one button; the click stores the certificate shown', () => {
    const box = section(dlg, 'function tlsBox(x, stored)', 'const cancel = el(');
    assert.match(box, /state === 'untrusted' \|\| state === 'changed'/);
    assert.match(box, /t\(state === 'changed' \? 'plugins\.stg\.trust_new_btn' : 'plugins\.stg\.trust_btn'\)/);
    assert.match(box, /id: 'pgx-stg-trust'/);
    assert.match(box, /const details = certDetails\(c, x\)/);
    const det = section(dlg, 'function certDetails(c, x)', 'function rememberedBox(');
    assert.match(det, /el\('details', \{ class: 'pgx-stg-details'/);
    assert.match(det, /t\('plugins\.stg\.tls_fp'\), fpOf\(c\.fingerprint\)/);
    const now = section(dlg, 'async function trustNow(c, stored, b)', 'function tlsBox(');
    assert.match(now, /req\('POST', ST_API \+ '\/' \+ existing\.id \+ '\/trust', \{ fingerprint: c\.fingerprint \}\)/);
    assert.match(now, /inputs\.tlsCa\.value = String\(c\.pem \|\| ''\)\.trim\(\) \+ '\\n';\s*toast\(t\('plugins\.stg\.trust_taken'\)\);\s*checkBtn\.click\(\);/);
  });
  it('"Zertifikat der NAS gemerkt": the certificate remembered on first contact goes into the field', () => {
    const sc = section(dlg, 'function showCheck(c, stored)', 'function certDetails(');
    assert.match(sc, /if \(c\.trusted && c\.trusted\.cert && inputs\.tlsCa\) inputs\.tlsCa\.value = /);
    assert.match(sc, /result\.appendChild\(rememberedBox\(c\.trusted\.cert\)\)/);
    assert.match(sc, /c\.error === 'no_encryption'/);
  });
  it('SMB: the switch, on for new targets, a target from before keeps its value', () => {
    const f = section(dlg, 'function encryptField()', 'function secretInput(');
    assert.match(f, /const on = existing \? cfg\.encrypt === true : true;/);
    assert.match(f, /t\('plugins\.stg\.f_encrypt'\)/);
    assert.match(dlg, /form\.appendChild\(encryptField\(\)\);/);
  });
  it('the list: "Neues Zertifikat vertrauen" for tls_changed (asks with the details first), the SMB tip', () => {
    assert.match(list, /\/\^tls_changed\\b\/\.test/);
    assert.match(list, /action: 'trust', onClick: \(e\) => trustChanged\(tg, e\.currentTarget\)/);
    assert.match(list, /tg\.kind === 'smb' && tg\.config && tg\.config\.encrypt !== true/);
    const tc = section(PLUGINS_JS, 'async function trustChanged(tg, b)', 'function cacheCard(');
    assert.match(tc, /D\.confirm\(\{ title: t\('plugins\.stg\.trust_changed_title'\)/);
    assert.match(tc, /req\('POST', ST_API \+ '\/' \+ tg\.id \+ '\/trust', \{ fingerprint: c\.fingerprint \}\)/);
  });
  it('no innerHTML in the new code', () => {
    for (const s of [section(dlg, 'function caField()', 'function secretInput('), section(dlg, 'function certDetails(c, x)', 'const cancel = el('),
      section(PLUGINS_JS, 'async function trustChanged(tg, b)', 'function cacheCard(')]) assert.doesNotMatch(strip(s), /innerHTML|insertAdjacentHTML/);
  });
});

describe('off-site target dialog (settings.njk, settings.js)', () => {
  const ops = section(SETTINGS_JS, '// ── Backups ──', '// ── Lizenz ──');
  it('template: S3 has "Verbindung"; the PEM field is under "Erweitert" for WebDAV and S3; the SMB switch is checked by default', () => {
    assert.ok(SETTINGS_TPL.includes('<div class="st-fl st-span2" data-for="sftp smb webdav s3"><label class="st-fl-label" for="st-ot-via">'));
    assert.ok(SETTINGS_TPL.includes('id="st-ot-via-peer-row" data-for="sftp smb webdav s3"'));
    assert.ok(SETTINGS_TPL.includes('id="st-ot-via-port-row" data-for="webdav s3"'));
    assert.match(SETTINGS_TPL, /<div class="st-fl st-span2" data-for="webdav s3"><span class="st-hint" id="st-ot-ca-set" hidden><\/span><details class="st-adv" id="st-ot-adv"><summary>\{\{ t\('offsite\.advanced'\) \}\}<\/summary><label class="st-fl-label" for="st-ot-ca">/);
    assert.match(SETTINGS_TPL, /data-for="smb"><label class="st-check"><input type="checkbox" id="st-ot-encrypt" checked>/);
    for (const m of SETTINGS_TPL.matchAll(/t\('(offsite\.[a-z0-9_.]+)'\)/g)) assert.ok(de[m[1]] && en[m[1]], m[1]);
  });
  it('settings.js: the card in the result, the click stores exactly the certificate shown, then tests again', () => {
    const s = strip(ops);
    assert.match(s, /res\.tls && res\.tls\.cert \? trustCard\(tg, res\.tls\)/);
    assert.match(s, /res\.trusted \? rememberedCard\(res\.trusted\)/);
    assert.match(s, /post\(BK \+ '\/targets\/' \+ tg\.id \+ '\/trust', \{ fingerprint \}\)/);
    assert.match(s, /b\.addEventListener\('click', \(\) => trustTarget\(tg, c\.fingerprint\)\)/);
    assert.match(s, /tls: r\.tls \|\| null/);
    assert.match(s, /const httpish = \(type\) => type === 'webdav' \|\| type === 's3';/);
    assert.match(s, /encEl\.checked = c\.encrypt === true;/);
    assert.match(s, /encrypt: encEl\.checked,/);
    assert.match(s, /tg\.type === 'smb' && tg\.config && tg\.config\.encrypt !== true/);
    assert.doesNotMatch(section(ops, 'function trustCard(', 'async function testTarget('), /innerHTML/);
    for (const m of ops.matchAll(/t\('(offsite\.[a-z0-9_.]+)'/g)) assert.ok(de[m[1]] && en[m[1]], 'i18n ' + m[1]);
  });
});

describe('ops-ui.js: payload and hints', () => {
  it('S3 sends "Verbindung" and its own certificate; SMB its switch', () => {
    const s3 = O.targetPayload('s3', { name: 'MinIO', keep: '7', enabled: true, endpoint: 'https://minio.nas:9000', bucket: 'bk', region: '', access_key_id: 'AK',
      via: 'peer', via_peer: '4', via_port: '9000', tls_ca: ' PEM ' }, false);
    assert.deepEqual(s3.config.via, { kind: 'peer', peerId: 4, port: '9000' });
    assert.equal(s3.config.tls_ca, 'PEM');
    const route = O.targetPayload('s3', { name: 'x', via: 'route', via_route: '9' }, true);
    assert.deepEqual(route.config.via, { kind: 'route', routeId: 9 });
    assert.equal(O.targetPayload('smb', { name: 'x', via: 'host', encrypt: false }, true).config.encrypt, false);
    assert.equal(O.targetPayload('smb', { name: 'x', via: 'host', encrypt: true }, false).config.encrypt, true);
    assert.equal('encrypt' in O.targetPayload('smb', { name: 'x', via: 'host' }, true).config, false, 'not sent when the form has no switch');
  });
  it('a text for every certificate and encryption hint; the new error codes', () => {
    for (const h of ['cert_untrusted', 'cert_changed', 'cert_name', 'cert_expired', 'cert_not_yet_valid', 'cert_decrypts', 'smb_no_encryption']) {
      assert.ok(O.hintText(h), h);
      assert.ok(de[O.HINT_KEYS[h][0]] && en[O.HINT_KEYS[h][0]], h);
    }
    for (const c of ['CERT_MISMATCH', 'NOT_TRUSTABLE']) assert.ok(de[O.ERROR_KEYS[c][0]], c);
    assert.equal(O.errorText({ code: 'INVALID_CONFIG', field: 'encrypt' }), 'Please check the field “Encrypt connection”.');
  });
});

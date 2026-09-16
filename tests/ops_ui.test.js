'use strict';

// Behaviour of the pure helpers in public/js/ops-ui.js (release B §6, §7,
// §13b): passphrase hint, fingerprint rule (same as routesValidation), the
// maintenance-window rule (same as autoUpdate.isInWindow), API code → UI text
// mapping, target payloads (secrets only when typed) and the "Was ist neu"
// token rendering (text/code/strong only — nothing parsed as HTML).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../public/js/ops-ui.js');
const { setup, teardown } = require('./helpers/setup');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

// Server modules need the test environment (config, DB) — loaded after setup().
let autoUpdate;
let normalizeBackendFingerprint;
before(async () => {
  await setup();
  autoUpdate = require('../src/services/autoUpdate');
  ({ normalizeBackendFingerprint } = require('../src/services/routesValidation'));
});
after(teardown);

// Minimal DOM stand-in: enough for el()/tokenNodes()/whatsNewNodes().
function fakeDoc() {
  const mk = (tag) => ({
    tagName: tag.toUpperCase(), children: [], attrs: {}, dataset: {}, className: '', _text: '',
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
  });
  return { createElement: mk, createTextNode: (v) => ({ nodeType: 3, textContent: String(v), tagName: '#text' }) };
}

describe('ops-ui: passphrase strength', () => {
  it('short below 12 characters with the missing count, then weak/ok/strong', () => {
    assert.deepEqual(O.passphraseStrength(''), { level: 'empty', missing: 12, score: 0 });
    assert.equal(O.passphraseStrength('kurz').level, 'short');
    assert.equal(O.passphraseStrength('kurz').missing, 8);
    assert.equal(O.passphraseStrength('aaaaaaaaaaaaaaaa').level, 'weak', 'repeated characters');
    assert.equal(O.passphraseStrength('abcdefghijkl').level, 'weak');
    assert.equal(O.passphraseStrength('abcdefghijklmn').level, 'ok');
    assert.equal(O.passphraseStrength('Abcdefgh-12').level, 'short', '11 chars');
    assert.equal(O.passphraseStrength('Abcdefgh-123').level, 'ok');
    assert.equal(O.passphraseStrength('Korrekt Pferd Batterie Heftklammer').level, 'strong');
    assert.equal(O.MIN_PASSPHRASE, 12, 'same minimum as gcbk.MIN_PASSPHRASE');
    assert.equal(require('../src/services/offsite/gcbk').MIN_PASSPHRASE, O.MIN_PASSPHRASE);
  });
});

describe('ops-ui: gateway fingerprint', () => {
  const HEX = 'ab'.repeat(32);
  it('accepts what the server accepts and yields the same value', () => {
    for (const v of [HEX, HEX.toUpperCase(), HEX.match(/../g).join(':'), 'SHA256=' + HEX, 'sha-256: ' + HEX.toUpperCase().match(/../g).join(':'), '  ' + HEX + '  ']) {
      assert.equal(O.normalizeFingerprint(v), HEX, v);
      assert.equal(normalizeBackendFingerprint(v), HEX, 'server: ' + v);
    }
  });
  it('rejects what the server rejects; empty clears', () => {
    for (const v of ['AB:CD:12', HEX + 'a', 'zz'.repeat(32), 'md5:' + HEX]) {
      assert.equal(O.normalizeFingerprint(v), null, v);
      assert.throws(() => normalizeBackendFingerprint(v), (e) => e.code === 'BACKEND_TLS_FINGERPRINT_INVALID', 'server: ' + v);
    }
    assert.equal(O.normalizeFingerprint(''), '');
    assert.equal(O.normalizeFingerprint(null), '');
  });
  it('formats with colons in upper case', () => {
    assert.equal(O.formatFingerprint(HEX), HEX.toUpperCase().match(/../g).join(':'));
    assert.equal(O.formatFingerprint('xyz'), 'xyz');
  });
});

describe('ops-ui: maintenance window', () => {
  const at = (iso) => new Date(iso);
  it('inWindow mirrors autoUpdate.isInWindow (incl. over midnight, other zones)', () => {
    const windows = [
      { start: '03:00', end: '05:00', tz: 'Europe/Berlin' },
      { start: '23:00', end: '02:00', tz: 'Europe/Berlin' },
      { start: '22:30', end: '06:15', tz: 'America/New_York' },
      { start: '00:00', end: '00:30', tz: 'UTC' },
    ];
    const times = ['2026-01-10T01:30:00Z', '2026-01-10T02:00:00Z', '2026-01-10T03:59:00Z', '2026-07-10T22:10:00Z',
      '2026-07-10T23:00:00Z', '2026-07-11T00:59:00Z', '2026-07-11T02:30:00Z', '2026-07-11T10:14:00Z', '2026-07-11T00:00:00Z'];
    for (const w of windows) for (const t of times) assert.equal(O.inWindow(w, at(t)), autoUpdate.isInWindow(w, at(t)), JSON.stringify(w) + ' @ ' + t);
  });
  it('start == end is a problem only when enabled; over midnight detected', () => {
    assert.equal(O.windowProblem({ enabled: true, start: '04:00', end: '04:00' }), 'same');
    assert.equal(O.windowProblem({ enabled: false, start: '04:00', end: '04:00' }), null);
    assert.equal(O.windowProblem({ enabled: true, start: '4:00', end: '05:00' }), 'format');
    assert.equal(O.overMidnight('23:00', '02:00'), true);
    assert.equal(O.overMidnight('03:00', '05:00'), false);
  });
  it('time zone list contains UTC, the kept value and is sorted; fallback without Intl', () => {
    const list = O.timeZones(Intl, 'Europe/Berlin');
    assert.ok(list.includes('UTC') && list.includes('Europe/Berlin'));
    assert.deepEqual(list, list.slice().sort());
    const fb = O.timeZones(null, 'Asia/Kolkata');
    assert.ok(fb.includes('Asia/Kolkata') && fb.includes('Europe/Berlin'));
    for (const z of list.slice(0, 40)) assert.equal(autoUpdate.validateWindow({ tz: z }), null, z);
  });
});

describe('ops-ui: API code → UI text', () => {
  it('every mapped key exists in de and en', () => {
    const keys = new Set(Object.values(O.ERROR_KEYS).map((e) => e[0]).concat(Object.values(O.FIELD_KEYS).map((e) => e[0]), ['offsite.err.generic']));
    for (const k of keys) { assert.ok(de[k], 'de ' + k); assert.ok(en[k], 'en ' + k); }
  });
  it('covers the codes of the off-site, restore and auto-update APIs', () => {
    for (const c of ['PASSPHRASE_TOO_SHORT', 'PASSPHRASE_NOT_SET', 'NO_LOCAL_BACKUP', 'UPLOAD_FAILED', 'TRANSPORT_FAILED', 'INVALID_CONFIG',
      'INVALID_NAME', 'INVALID_KEEP', 'INVALID_TYPE', 'TYPE_IMMUTABLE', 'TOO_MANY_TARGETS', 'NOT_FOUND', 'CONFIG_UNREADABLE',
      'SESSION_REQUIRED', 'ADMIN_REQUIRED', 'PASSPHRASE_REQUIRED', 'DECRYPT_FAILED', 'CORRUPT', 'UNSUPPORTED', 'INVALID_WINDOW']) {
      assert.ok(O.ERROR_KEYS[c], c);
    }
  });
  it('licence 403 {feature}, INVALID_CONFIG with the field label, fallback for unknown codes', () => {
    assert.equal(O.errorCode({ ok: false, feature: 'scheduled_backups' }), 'LICENSE');
    assert.equal(O.errorCode({ data: { code: 'NO_LOCAL_BACKUP' } }), 'NO_LOCAL_BACKUP', 'thrown api error body');
    // The field comes as a code (`field`), never out of the English message.
    assert.equal(O.errorText({ code: 'INVALID_CONFIG', field: 'bucket', error: 'bucket: invalid bucket name' }), 'Please check the field “Bucket”.');
    assert.equal(O.configField({ field: 'access_key_id', error: 'access_key_id: required' }), 'access_key_id');
    assert.equal(O.configField({ data: { field: 'host', error: 'host: required' } }), 'host', 'thrown api error body');
    assert.equal(O.configField({ field: 'nonsense' }), null);
    assert.equal(O.configField({ error: 'bucket: invalid bucket name' }), null, 'the English text is not parsed');
    assert.equal(O.errorText({ code: 'INVALID_CONFIG', error: 'bucket: x' }), 'Please check the field “—”.');
    assert.equal(O.errorText({ code: 'WHATEVER' }, ['x.y', 'Fallback']), 'Fallback');
    assert.equal(O.errorText({ code: 'WHATEVER' }), 'That did not work.');
  });
  it('shows the remote detail only for transport/upload errors', () => {
    assert.equal(O.errorDetail({ code: 'TRANSPORT_FAILED', detail: 'WebDAV PROPFIND 401' }), 'WebDAV PROPFIND 401');
    assert.equal(O.errorDetail({ code: 'UPLOAD_FAILED', error: 'SFTP: connection refused' }), 'SFTP: connection refused');
    assert.equal(O.errorDetail({ code: 'INVALID_NAME', error: 'name: 1-64 characters' }), '');
  });
});

describe('ops-ui: targets', () => {
  it('payload: secrets only when typed, clear_password only without a new one, no type on edit', () => {
    const v = { name: ' NAS ', keep: '7', enabled: true, url: 'https://dav.example/x/', username: 'alice', password: '' };
    assert.deepEqual(O.targetPayload('webdav', v, true), { name: 'NAS', keep: 7, enabled: true, config: { url: 'https://dav.example/x/', username: 'alice' } });
    assert.equal(O.targetPayload('webdav', { ...v, password: 'pw' }, false).config.password, 'pw');
    assert.equal(O.targetPayload('webdav', { ...v, password: 'pw' }, false).type, 'webdav');
    assert.equal(O.targetPayload('smb', { ...v, share: 'b', host: 'nas', clear_password: true }, true).config.clear_password, true);
    const s3 = O.targetPayload('s3', { name: 'S3', keep: '', bucket: 'bk', access_key_id: 'AK', secret_access_key: '', path_style: true }, true);
    assert.equal('secret_access_key' in s3.config, false);
    assert.equal(s3.config.region, 'us-east-1');
    assert.equal(s3.keep, undefined);
    const sftp = O.targetPayload('sftp', { name: 'x', host: '10.8.0.1', port: '2222', username: 'backup', path: 'gc' }, false);
    assert.deepEqual(sftp.config, { host: '10.8.0.1', port: '2222', path: 'gc', username: 'backup' });
  });
  it('payloads pass the server-side normaliser', () => {
    const offsite = require('../src/services/offsite');
    const body = O.targetPayload('sftp', { name: 'x', host: '10.8.0.1', port: '2222', username: 'backup', path: 'gc' }, false);
    assert.equal(offsite.normalizeConfig('sftp', body.config).port, 2222);
    const dav = O.targetPayload('webdav', { name: 'x', url: 'https://dav.example/x/', username: 'a', password: 'p' }, false);
    assert.equal(offsite.normalizeConfig('webdav', dav.config).password, 'p');
  });
  it('summary and status chip', () => {
    assert.equal(O.targetSummary({ type: 'sftp', config: { host: 'nas', port: 22, username: 'b', path: '/backup' } }), 'b@nas · /backup');
    assert.equal(O.targetSummary({ type: 'smb', config: { host: 'nas', port: 4455, share: 'bk', path: 'gc' } }), 'nas:4455 · /bk/gc');
    assert.equal(O.targetSummary({ type: 's3', config: { bucket: 'b', prefix: 'p', region: 'eu-central-1', endpoint: '' } }), 'b/p · AWS (eu-central-1)');
    assert.equal(O.targetSummary({ type: 'webdav', config: { url: 'https://cloud.example/remote.php/dav/files/a/gc/' } }), 'cloud.example/remote.php/dav/files/a/gc/');
    assert.equal(O.targetStatus({ last_status: 'ok' }).cls, 'tag-green');
    assert.equal(O.targetStatus({ last_status: 'failed' }).cls, 'tag-red');
    assert.equal(O.targetStatus({}).key, 'offsite.never_run');
    assert.equal(O.targetStatus({ last_status: 'ok' }, true).key, 'offsite.status_running');
  });
  it('L4 candidates: suggested type first, internal before public', () => {
    const list = [
      { route_id: 1, listen_port: 900, internal: false, enabled: true, suggested_type: 'sftp' },
      { route_id: 2, listen_port: 800, internal: true, enabled: true, suggested_type: 'smb' },
      { route_id: 3, listen_port: 700, internal: true, enabled: true, suggested_type: 'sftp' },
      { route_id: 4, listen_port: 600, internal: true, enabled: false, suggested_type: null },
    ];
    assert.deepEqual(O.sortCandidates(list, 'sftp').map((c) => c.route_id), [3, 1, 4, 2]);
    assert.deepEqual(O.sortCandidates(list, 'smb').map((c) => c.route_id), [2, 4, 3, 1]);
  });
});

describe('ops-ui: "Was ist neu" rendering', () => {
  it('tokens become text / <code> / <strong>; markup inside values stays text', () => {
    const doc = fakeDoc();
    const nodes = O.tokenNodes(doc, [{ t: 'text', v: 'Neu: ' }, { t: 'code', v: '<b>x</b>' }, { t: 'strong', v: 'wichtig' }, { t: 'html', v: '<img src=x>' }]);
    assert.deepEqual(nodes.map((n) => n.tagName), ['#text', 'CODE', 'STRONG', '#text']);
    assert.equal(nodes[1].textContent, '<b>x</b>');
    assert.equal(nodes[3].textContent, '<img src=x>');
  });
  it('sections → version head, group titles, one <li> per item', () => {
    const doc = fakeDoc();
    const secs = O.whatsNewNodes(doc, [{ version: '1.126.0', date: '2026-09-14', groups: [
      { title: 'Features', items: [[{ t: 'text', v: 'A' }], [{ t: 'code', v: 'B' }]] },
      { title: 'Fixes', items: [[{ t: 'text', v: 'C' }]] },
    ] }], 'de');
    assert.equal(secs.length, 1);
    const s = secs[0];
    assert.equal(s.attrs['data-version'], '1.126.0');
    const lists = s.children.filter((c) => c.className === 'op-wn-group').map((g) => g.children.find((c) => c.tagName === 'UL'));
    assert.deepEqual(lists.map((ul) => ul.children.length), [2, 1]);
    assert.match(s.textContent, /v1\.126\.0/);
    assert.match(s.textContent, /Features.*A.*B.*Fixes.*C/);
  });
  it('the server changelog tokens only use text/code/strong', () => {
    const changelog = require('../src/services/changelog');
    const types = new Set();
    for (const s of changelog.getSections()) for (const g of s.groups) for (const it2 of g.items) for (const t of it2) types.add(t.t);
    for (const t of types) assert.ok(['text', 'code', 'strong'].includes(t), t);
  });
});

describe('ops-ui: formatting', () => {
  it('bytes, fmt placeholders', () => {
    assert.equal(O.fmtBytes(512), '512 B');
    assert.equal(O.fmtBytes(12 * 1024), '12 KB');
    assert.equal(O.fmtBytes(25.4 * 1024 * 1024), '25 MB');
    assert.equal(O.fmt('{n} von {n} · {x}', { n: 2, x: 'a' }), '2 von 2 · a');
    assert.equal(O.tr('nope.key', 'Hallo {v}', { v: 'Welt' }), 'Hallo Welt');
  });
});

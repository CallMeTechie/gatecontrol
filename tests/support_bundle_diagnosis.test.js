'use strict';

// Support bundles with the results of the apps' diagnosis assistant
// (docs/feature-client-diagnosis.md, docs/feature-support-bundle.md):
//   - optional top-level `description` (≤ 2000 chars, trimmed, line breaks
//     kept) and `diagnosis` ({ startedAt, finishedAt, summary, checks[] })
//   - cleaned on upload, invalid parts dropped — never a 400; bundles without
//     them work as before (schema stays 1)
//   - migration 99: support_bundles.description (preview) + diagnosis_summary
//     for the inbox row and the notification facts
//   - viewer helpers (support-inbox.js) and i18n

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const S = require('../public/js/support-inbox.js');

let app, db, tokens, svc, config;

function seedPeer(name) {
  return Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, '10.8.0.41/32', 1, 'regular')")
    .run(name, `PUB_${name}_${crypto.randomBytes(4).toString('hex')}=`).lastInsertRowid);
}
function tokenFor(peerId) {
  return tokens.create({ name: `sbd-${crypto.randomBytes(4).toString('hex')}`, scopes: ['client'], peerId }, '127.0.0.1').rawToken;
}
function bundle(extra = {}) {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    client: { product: 'android', version: '1.18.0', platform: 'android', os: 'Android 15' },
    tunnel: { connected: true },
    ...extra,
  };
}
function upload(peerId, body, json = false) {
  const r = supertest(app).post(`/api/v1/client/support-bundle?peerId=${peerId}`).set('X-API-Token', tokenFor(peerId));
  if (json) return r.set('Content-Type', 'application/json').send(body);
  return r.set('Content-Type', 'application/gzip').send(zlib.gzipSync(Buffer.from(JSON.stringify(body))));
}
async function stored(peerId, id) {
  const r = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}`).expect(200);
  return r.body;
}

const DIAG = () => ({
  startedAt: '2026-10-13T09:59:50.000Z',
  finishedAt: '2026-10-13T10:00:04.000Z',
  summary: 'fail',
  checks: [
    { id: 'internet', status: 'ok', title: 'Internet', detail: 'Erreichbar', value: '23 ms' },
    { id: 'server', status: 'ok', title: 'Server', detail: 'gate.example.com antwortet', value: 41 },
    { id: 'tunnel', status: 'ok', title: 'Tunnel', detail: 'verbunden' },
    { id: 'handshake', status: 'warn', title: 'Handshake', detail: 'vor 190 s', value: 190, hint: 'Länger als 3 Minuten — Verbindung prüfen.' },
    { id: 'dns', status: 'fail', title: 'DNS', detail: 'Der DNS-Server 8.8.8.8 liegt außerhalb des Tunnels.', hint: 'Privates DNS in Android ausschalten.' },
    { id: 'mtu', status: 'skipped', title: 'MTU', detail: 'Tunnel nicht verbunden' },
    { id: 'speed', status: 'ok', title: 'Geschwindigkeit', detail: '↓ 48.2 Mbit/s · ↑ 12.1 Mbit/s', value: true },
  ],
});

before(async () => {
  ({ app } = await setup());
  db = require('../src/db/connection').getDb();
  tokens = require('../src/services/tokens');
  svc = require('../src/services/supportBundles');
  config = require('../config/default');
});
after(() => teardown());
beforeEach(() => { config.supportBundles.perHour = 100; });

describe('migration 99', () => {
  it('adds support_bundles.description and diagnosis_summary', () => {
    const row = db.prepare('SELECT name FROM migration_history WHERE version = 99').get();
    assert.equal(row && row.name, 'support_bundles_diagnosis');
    const cols = db.prepare('PRAGMA table_info(support_bundles)').all().map((c) => c.name);
    for (const c of ['description', 'diagnosis_summary']) assert.ok(cols.includes(c), c);
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 99);
    assert.equal(m.detect(db), true);
  });
});

describe('upload with diagnosis and description', () => {
  it('stores both, the inbox row carries the preview and the summary', async () => {
    const peerId = seedPeer('sbd-full');
    const description = '  Seit dem Update geht im Büro-WLAN nichts mehr.\r\nZuhause klappt es.\n\n  ';
    const up = await upload(peerId, bundle({ description, diagnosis: DIAG() }));
    assert.equal(up.status, 201);
    const { data, bundle: meta } = await stored(peerId, up.body.bundle.id);
    assert.equal(data.description, 'Seit dem Update geht im Büro-WLAN nichts mehr.\nZuhause klappt es.');
    assert.equal(data.diagnosis.summary, 'fail');
    assert.equal(data.diagnosis.startedAt, '2026-10-13T09:59:50.000Z');
    assert.equal(data.diagnosis.finishedAt, '2026-10-13T10:00:04.000Z');
    assert.deepEqual(data.diagnosis.checks.map((c) => c.id), ['internet', 'server', 'tunnel', 'handshake', 'dns', 'mtu', 'speed']);
    assert.deepEqual(data.diagnosis.checks[3], DIAG().checks[3]);
    assert.equal(data.diagnosis.checks[1].value, 41);
    assert.equal(data.diagnosis.checks[6].value, true);
    assert.equal(meta.description, data.description);
    assert.equal(meta.diagnosis_summary, 'fail');

    const list = await getAgent().get(`/api/v1/support-bundles?peerId=${peerId}`).expect(200);
    assert.equal(list.body.bundles[0].description, data.description);
    assert.equal(list.body.bundles[0].diagnosis_summary, 'fail');
  });

  it('works as plain JSON too; the description is redacted like everything else', async () => {
    const peerId = seedPeer('sbd-json');
    const up = await upload(peerId, bundle({ description: 'mein token=gc_abcdef1234567890 geht nicht', diagnosis: { summary: 'ok', checks: [] } }), true);
    assert.equal(up.status, 201);
    const { data, bundle: meta } = await stored(peerId, up.body.bundle.id);
    assert.ok(!data.description.includes('gc_abcdef1234567890'));
    assert.match(data.description, /\[REDACTED\]/);
    assert.ok(!meta.description.includes('gc_abcdef1234567890'));
    assert.deepEqual(data.diagnosis, { summary: 'ok', checks: [] });
  });

  it('older apps without the keys keep working (no columns set, nothing added)', async () => {
    const peerId = seedPeer('sbd-old');
    const up = await upload(peerId, bundle());
    assert.equal(up.status, 201);
    const { data, bundle: meta } = await stored(peerId, up.body.bundle.id);
    assert.equal('description' in data, false);
    assert.equal('diagnosis' in data, false);
    assert.equal(meta.description, null);
    assert.equal(meta.diagnosis_summary, null);
  });

  it('cuts the description to 2000 characters and long check texts to their limits', async () => {
    const peerId = seedPeer('sbd-long');
    // Words, not one long run: 60+ base64-like characters in a row are
    // masked by the redaction (supportRedact).
    const words = (n) => 'Das WLAN bricht ab. '.repeat(Math.ceil(n / 20)).slice(0, n);
    const checks = [{ id: 'dns', status: 'warn', title: words(500), detail: words(2000), hint: words(2000), value: words(500) }];
    const up = await upload(peerId, bundle({ description: words(5000), diagnosis: { summary: 'warn', checks } }));
    assert.equal(up.status, 201);
    const { data, bundle: meta } = await stored(peerId, up.body.bundle.id);
    assert.ok(data.description.length <= 2000 && data.description.length >= 1990, String(data.description.length));
    assert.ok(meta.description.length <= 300 && meta.description.length >= 290);
    const c = data.diagnosis.checks[0];
    assert.ok(c.title.length <= 120 && c.title.length >= 115);
    assert.ok(c.detail.length <= 500 && c.detail.length >= 495);
    assert.ok(c.hint.length <= 500 && c.hint.length >= 495);
    assert.ok(c.value.length <= 120 && c.value.length >= 115);
  });
});

describe('invalid diagnosis / description: dropped, never a 400', () => {
  for (const [label, extra] of [
    ['diagnosis is a string', { diagnosis: 'all good' }],
    ['diagnosis is an array', { diagnosis: [{ id: 'dns', status: 'ok' }] }],
    ['diagnosis without valid checks or summary', { diagnosis: { summary: 'great', checks: [{ id: 'dns', status: 'green' }, { status: 'ok' }, 'x', null] } }],
    ['description is an object', { description: { text: 'hi' } }],
    ['description is only whitespace', { description: ' \n\t ' }],
    ['description is a number', { description: 42 }],
  ]) {
    it(label, async () => {
      const peerId = seedPeer('sbd-bad');
      const up = await upload(peerId, bundle(extra));
      assert.equal(up.status, 201, JSON.stringify(up.body));
      const { data, bundle: meta } = await stored(peerId, up.body.bundle.id);
      assert.equal('diagnosis' in data, false);
      assert.equal('description' in data, false);
      assert.equal(meta.diagnosis_summary, null);
      assert.equal(meta.description, null);
    });
  }

  it('keeps the valid checks, drops the rest, at most 30, derives a missing summary', () => {
    const checks = [
      { id: 'dns', status: 'warn', title: 'DNS' },
      { id: 'bad id!', status: 'ok' },
      { id: 'mtu', status: 'unknown' },
      { id: 'speed', status: 'ok', value: { nested: 1 } },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, status: 'ok' })),
    ];
    const d = svc.normalizeDiagnosis({ summary: 'nope', startedAt: 'yesterday-ish', checks });
    assert.equal(d.summary, 'warn');
    assert.equal(d.checks.length, svc.DIAG_MAX_CHECKS);
    assert.deepEqual(d.checks.slice(0, 2).map((c) => c.id), ['dns', 'speed']);
    assert.equal('value' in d.checks[1], false, 'objects are no values');
    assert.equal(d.checks[1].title, 'speed', 'title falls back to the id');
    assert.equal('startedAt' in d, false, 'unparseable time dropped');
    assert.equal(svc.normalizeDiagnosis({ checks: [{ id: 'x', status: 'fail' }, { id: 'y', status: 'warn' }] }).summary, 'fail');
    assert.equal(svc.normalizeDiagnosis({ checks: [{ id: 'x', status: 'skipped' }] }).summary, 'ok');
    assert.equal(svc.normalizeDiagnosis({ summary: 'ok' }).checks.length, 0);
    assert.equal(svc.normalizeDiagnosis(null), null);
  });

  it('control characters are removed; single-line fields become one line', () => {
    const d = svc.normalizeDiagnosis({ checks: [{ id: 'dns', status: 'ok', title: 'A\nB\u0000C', detail: 'one\r\ntwo\u0007' }] });
    assert.equal(d.checks[0].title, 'A B C');
    assert.equal(d.checks[0].detail, 'one\ntwo');
    assert.equal(svc.normalizeDescription('a\u0000b\r\nc\td'), 'ab\nc\td');
    assert.equal(svc.normalizeDescription(''), null);
  });

  it('still rejects what was rejected before (schema)', async () => {
    const peerId = seedPeer('sbd-schema');
    const up = await upload(peerId, { schema: 2, description: 'x', diagnosis: DIAG() });
    assert.equal(up.status, 400);
    assert.equal(up.body.error, 'unsupported_schema');
  });
});

describe('notification facts', () => {
  it('adds the diagnosis summary and "description attached" — never the text', async () => {
    const peerId = seedPeer('sbd-notify');
    const up = await upload(peerId, bundle({ description: 'Geheimer Problemtext', diagnosis: DIAG() }));
    assert.equal(up.status, 201);
    const n = db.prepare("SELECT * FROM notifications WHERE event_id = 'support_bundle' ORDER BY id DESC LIMIT 1").get();
    assert.ok(n);
    const text = require('../src/services/notify/text');
    const lang = text.serverLang();
    const facts = Object.fromEntries(JSON.parse(n.data).facts.map((f) => [f.label, f.value]));
    assert.equal(facts[text.t(lang, 'push.fact.diagnosis')], text.t(lang, 'push.fact.diagnosis_fail'));
    assert.equal(facts[text.t(lang, 'push.fact.description')], text.t(lang, 'push.fact.description_attached'));
    assert.ok(!n.data.includes('Geheimer Problemtext'));
    const act = db.prepare("SELECT details FROM activity_log WHERE event_type = 'support_bundle_uploaded' ORDER BY id DESC LIMIT 1").get();
    assert.ok(!String(act.details).includes('Geheimer Problemtext'));
  });

  it('without them the facts stay as before', async () => {
    const peerId = seedPeer('sbd-notify-old');
    await upload(peerId, bundle());
    const n = db.prepare("SELECT * FROM notifications WHERE event_id = 'support_bundle' ORDER BY id DESC LIMIT 1").get();
    const text = require('../src/services/notify/text');
    const lang = text.serverLang();
    const labels = JSON.parse(n.data).facts.map((f) => f.label);
    assert.ok(!labels.includes(text.t(lang, 'push.fact.diagnosis')));
    assert.ok(!labels.includes(text.t(lang, 'push.fact.description')));
  });
});

describe('viewer (support-inbox.js)', () => {
  it('normDiagnosis: counts, summary, defensive against old files', () => {
    const d = S.normDiagnosis(DIAG());
    assert.equal(d.summary, 'fail');
    assert.deepEqual(d.counts, { ok: 4, warn: 1, fail: 1, skipped: 1 });
    assert.equal(d.checks[4].hint, 'Privates DNS in Android ausschalten.');
    assert.equal(d.finishedAt, '2026-10-13T10:00:04.000Z');
    assert.equal(S.normDiagnosis({ checks: [{ id: 'a', status: 'warn' }, { id: 'b', status: 'meh' }, null] }).summary, 'warn');
    assert.equal(S.normDiagnosis({ checks: [] }), null);
    assert.equal(S.normDiagnosis('x'), null);
    assert.equal(S.normDiagnosis({ checks: [{ id: 'a', status: 'ok', value: { x: 1 } }] }).checks[0].value, null);
  });

  it('description helpers keep line breaks for the block and make one line for the row', () => {
    assert.equal(S.descriptionText(' a\r\nb \n'), 'a\nb');
    assert.equal(S.descriptionText(5), '');
    assert.equal(S.descriptionPreview('a\n\nb'), 'a b');
    const p = S.descriptionPreview('x'.repeat(200), 50);
    assert.equal(p.length, 50);
    assert.ok(p.endsWith('…'));
  });

  it('description and diagnosis are sections of their own, not "other data"', () => {
    assert.deepEqual(S.otherKeys({ schema: 1, description: 'x', diagnosis: {}, battery: {} }), ['battery']);
    const js = read('public/js/support-inbox.js');
    for (const id of ["id: 'description'", "id: 'diagnosis'", "'data-check'", "'data-status'", "'data-desc-for'", "class: 'sb-row-desc'"]) assert.ok(js.includes(id), id);
    assert.match(js, /el\('p', \{ class: 'sb-desc', text \}\)/, 'description via textContent');
    const css = read('public/css/app.css');
    const at = css.indexOf('\n * §11 Support bundles (sb-)');
    for (const sel of ['.sb-desc', '.sb-diag-row', '.sb-diag-chip.sb-diag-fail', '.sb-diag-skipped', '.sb-row-desc', '.sb-desc-row']) {
      assert.ok(css.indexOf(sel, at) > at, sel);
    }
    assert.match(css.slice(css.indexOf('.sb-desc{', at)), /^\.sb-desc\{[^}]*white-space:pre-wrap/);
  });

  it('every viewer key exists in DE and EN with the same placeholders', () => {
    const js = read('public/js/support-inbox.js');
    const keys = new Set(Array.from(js.matchAll(/'(support_bundles\.(?:sec_description|sec_diagnosis|diag_[a-z_]+?))'/g)).map((m) => m[1]));
    for (const st of ['ok', 'warn', 'fail', 'skipped']) keys.add(`support_bundles.diag_status_${st}`);
    for (const sm of ['ok', 'warn', 'fail']) { keys.add(`support_bundles.diag_summary_${sm}`); keys.add(`support_bundles.diag_short_${sm}`); }
    assert.ok(keys.size >= 15, [...keys].join());
    const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join();
    for (const k of keys) {
      if (k.endsWith('_')) continue;
      assert.ok(de[k] && en[k], k);
      assert.equal(ph(de[k]), ph(en[k]), k);
    }
    for (const k of ['push.fact.diagnosis', 'push.fact.diagnosis_ok', 'push.fact.diagnosis_warn', 'push.fact.diagnosis_fail', 'push.fact.description', 'push.fact.description_attached']) {
      assert.ok(de[k] && en[k], k);
    }
  });
});

'use strict';

// public/js/settings-ui.js — the pure helpers of the settings page: address
// resolution (sections, old tabs, ?tab=, element ids), search, save model,
// client-side checks, event matrix and small formatters.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../public/js/settings-ui.js');
const N = require('../src/services/notifications');

const TPL = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');

describe('sections and the address', () => {
  it('the 21 sections are the ones the template renders, in nav order', () => {
    const inTpl = [...TPL.matchAll(/<section class="st-section" data-section="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(inTpl, U.SECTIONS);
    assert.equal(U.SECTIONS.length, 21);
  });
  it('#<section> and ?tab=<section>', () => {
    assert.deepEqual(U.resolveLocation({ hash: '#daten' }), { section: 'daten', anchor: null });
    assert.deepEqual(U.resolveLocation({ hash: '', search: '?tab=lizenz' }), { section: 'lizenz', anchor: null });
  });
  it('every old tab name maps to its new section (hash and ?tab=)', () => {
    const expected = {
      general: 'uebersicht', security: 'anmeldung', backup: 'backup', email: 'email', monitoring: 'monitoring',
      advanced: 'updates', license: 'lizenz', 'split-tunnel': 'splittunnel', 'client-updates': 'clientupdates',
      'client-policy': 'richtlinien', pihole: 'pihole', portal: 'portal',
    };
    for (const [old, sec] of Object.entries(expected)) {
      assert.equal(U.resolveLocation({ hash: '#' + old }).section, sec, '#' + old);
      assert.equal(U.resolveLocation({ search: '?x=1&tab=' + old }).section, sec, '?tab=' + old);
    }
  });
  it('element ids: live ones keep the anchor, old ones map to their section', () => {
    const ofEl = (id) => (id === 'card-offsite' ? 'backup' : null);
    assert.deepEqual(U.resolveLocation({ hash: '#card-offsite' }, { sectionOfElement: ofEl }), { section: 'backup', anchor: 'card-offsite' });
    assert.deepEqual(U.resolveLocation({ hash: '#card-autoupdate' }), { section: 'updates', anchor: null });
    assert.deepEqual(U.resolveLocation({ hash: '#smtp-host' }), { section: 'email', anchor: null });
    // ?tab= never jumps to element ids
    assert.equal(U.resolveLocation({ search: '?tab=card-offsite' }, { sectionOfElement: ofEl }), null);
  });
  it('the hash wins over ?tab=; unknown, unlicensed or malformed → null', () => {
    assert.equal(U.resolveLocation({ hash: '#email', search: '?tab=general' }).section, 'email');
    assert.equal(U.resolveLocation({ hash: '#nope' }), null);
    assert.equal(U.resolveLocation({ hash: '#<img src=x>' }), null);
    assert.equal(U.resolveLocation({ hash: '#pihole' }, { known: U.SECTIONS.filter((s) => s !== 'pihole') }), null);
    assert.equal(U.resolveLocation({ hash: '#%E0%A4%A' }), null);
  });
});

describe('search', () => {
  it('case-, accent- and ß-insensitive; every word must match', () => {
    assert.equal(U.matches('Übersicht Dienste', 'ubersicht'), true);
    assert.equal(U.matches('Straße', 'strasse'), true);
    assert.equal(U.matches('SMTP Server Port', 'smtp port'), true);
    assert.equal(U.matches('SMTP Server', 'smtp lizenz'), false);
    assert.equal(U.matches('anything', '  '), true);
  });
});

describe('save model', () => {
  it('dirtyFields compares canonical values and ignores fields never loaded', () => {
    const base = { a: 30, b: true, c: 'x', d: ['1', '2'] };
    assert.deepEqual(U.dirtyFields(base, { a: '30', b: true, c: 'x', d: ['1', '2'], e: 'new' }), []);
    assert.deepEqual(U.dirtyFields(base, { a: '31', b: false, c: 'x', d: ['2', '1'] }), ['a', 'b', 'd']);
    assert.equal(U.valueKey(null), '');
    assert.equal(U.valueKey(undefined), '');
  });
  it('savePlan keeps only the groups with a dirty field, in order', () => {
    const g = [{ id: 1, fields: ['a', 'b'] }, { id: 2, fields: ['c'] }, { id: 3, fields: ['d'] }];
    assert.deepEqual(U.savePlan(g, ['d', 'a']).map((x) => x.id), [1, 3]);
    assert.deepEqual(U.savePlan(g, []), []);
  });
  it('pickDirty sends only the changed keys (optionally cast)', () => {
    const map = { retention_traffic_days: 'ret-traffic', retention_activity_days: 'ret-activity' };
    assert.deepEqual(U.pickDirty(map, { 'ret-traffic': '45', 'ret-activity': '90' }, ['ret-traffic'], Number), { retention_traffic_days: 45 });
  });
  it('client-side checks', () => {
    assert.equal(U.checkNumber('30', 1, 365), null);
    assert.deepEqual(U.checkNumber('999', 1, 365), { min: 1, max: 365 });
    assert.deepEqual(U.checkNumber('1.5', 1, 365), { min: 1, max: 365 });
    assert.deepEqual(U.checkNumber('', 1, 365), { min: 1, max: 365 });
    assert.equal(U.semverOk(''), true);
    assert.equal(U.semverOk('v1.2.3'), true);
    assert.equal(U.semverOk('1.2'), false);
    assert.equal(U.cidrOk('192.168.0.0/16'), true);
    assert.equal(U.cidrOk('300.1.1.1/8'), false);
    assert.equal(U.cidrOk('10.0.0.0/33'), false);
    assert.equal(U.recipientsOk(''), true);
    assert.equal(U.recipientsOk('a@example.com, b@example.org'), true);
    assert.equal(U.recipientsOk('a@example.com, nope'), false);
  });
});

describe('event matrix + webhook dialog (server catalogue)', () => {
  const cat = N.CATALOGUE;
  it('rows ticked by a type list; "*" ticks every row', () => {
    assert.deepEqual(U.eventRows(cat, 'gateway_down,resource_alert').sort(), ['gateway_state', 'resources']);
    assert.equal(U.eventRows(cat, '*').length, N.EVENTS.length);
    assert.deepEqual(U.eventRows(cat, ''), []);
  });
  it('typesOfRows gives every type of the rows — the same as the server', () => {
    const ids = ['login_failed', 'update', 'resources'];
    assert.deepEqual(U.typesOfRows(cat, ids).sort(), N.typesFromEvents(ids).sort());
    // and every type it produces passes the server allow-list
    const all = U.typesOfRows(cat, N.EVENTS.map((e) => e.id));
    assert.doesNotThrow(() => N.parseWebhookEvents(all));
  });
  it('hooksForRow counts the enabled hooks that receive the row', () => {
    const row = U.allRows(cat).find((r) => r.id === 'resources');
    const hooks = [{ enabled: 1, events: '*' }, { enabled: 1, events: 'resource_recovered' }, { enabled: 0, events: '*' }, { enabled: 1, events: 'login_failed' }];
    assert.equal(U.hooksForRow(row, hooks), 2);
  });
  it('webhookSummary: all, or the groups touched', () => {
    assert.deepEqual(U.webhookSummary(cat, '*'), { all: true, groups: [], rows: 0 });
    const s = U.webhookSummary(cat, 'login_failed,resource_alert');
    assert.equal(s.all, false);
    assert.equal(s.rows, 2);
    assert.deepEqual(s.groups, ['security', 'system']);
  });
});

describe('formatters', () => {
  it('portalHost', () => {
    assert.equal(U.portalHost('example.com', 'home', 'gc.internal'), 'home.example.com');
    assert.equal(U.portalHost('example.com', '', 'gc.internal'), 'example.com');
    assert.equal(U.portalHost('', 'home', 'gc.internal'), 'gc.internal');
  });
  it('nextBackupAt: last run + interval, never in the past; off → null', () => {
    const last = '2026-10-01T00:00:00Z';
    const t0 = Date.parse(last);
    assert.equal(U.nextBackupAt(last, 'daily', false, t0), null);
    assert.equal(U.nextBackupAt(last, 'daily', true, t0 + 3600e3), t0 + 24 * 3600e3);
    assert.equal(U.nextBackupAt(last, '6h', true, t0 + 13 * 3600e3), t0 + 18 * 3600e3);
    assert.equal(U.nextBackupAt(null, 'weekly', true, 0), 7 * 24 * 3600e3);
  });
  it('maintenance window: segments over midnight and minutes until it opens', () => {
    assert.deepEqual(U.windowSegments('02:00', '04:00'), [{ left: 8.33, width: 8.33 }]);
    assert.equal(U.windowSegments('23:00', '01:00').length, 2);
    assert.deepEqual(U.windowSegments('02:00', '02:00'), []);
    assert.equal(U.minutesToWindow('02:00', '04:00', 60), 60);
    assert.equal(U.minutesToWindow('02:00', '04:00', 150), 0);
    assert.equal(U.minutesToWindow('23:00', '01:00', 30), 0);
    assert.equal(U.minutesToWindow('23:00', '01:00', 120), 1260);
    assert.equal(U.minutesOf('25:00'), null);
  });
  it('fmt fills {x} and {{x}}', () => {
    assert.equal(U.fmt('{a} and {{b}}', { a: 1, b: 'two' }), '1 and two');
  });
});

describe('browser scripts parse', () => {
  it('settings.js and settings-ui.js are valid scripts', () => {
    const vm = require('node:vm');
    for (const f of ['settings.js', 'settings-ui.js', 'command-palette.js', 'ops-ui.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
      assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
    }
  });
});

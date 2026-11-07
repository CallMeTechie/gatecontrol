'use strict';

// Funk: sticks set by hand (services/homeRadio.js stickPlan/setStick, the gateway's
// docs/radio.md "Sticks von Hand festlegen"): the choice "Automatisch (Standard) /
// Zigbee / Thread / nicht verwenden" per stick, keyed by its stable id (by-id name or
// USB socket, never the ttyACM number), in the config pull as features.radio.sticks
// only when set (the hash of others stays), unlocked by the capability
// radio-stick-assign; hints (missing, second, radio_off, fit, no_adapter, firmware,
// port) — never bans. Real sticks are not here: the gateway is a stub.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, old, gateways, hr;

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);

const SER = { zbt: '9e2a' + 'dbd75b8beb11', dongleE: '2024' + '0123' };
const ID = {
  zbt: `usb-Nabu_Casa_Home_Assistant_Connect_ZBT-1_${SER.zbt}-if00-port0`,
  dongleE: `usb-ITEAD_SONOFF_Zigbee_3.0_USB_Dongle_Plus_V2_${SER.dongleE}-if00`,
  nrf: 'port:1-1.6:1.0',
  gone: 'usb-dresden_elektronik_ingenieurtechnik_GmbH_ConBee_II_DE' + '2123456-if00',
};
const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print', 'radio', 'radio-stacks', 'radio-stick-assign'];

function radioTel(extra = {}) {
  return {
    enabled: true,
    stack: 'zigbee2mqtt',
    sticks: [
      { id: ID.dongleE, idKind: 'serial', kind: 'multi', model: 'Sonoff ZBDongle-E', bus: 'usb', tty: 'ttyACM1', deconz: false, z2m: 'ember', thread: true, use: 'zigbee2mqtt', choice: 'auto', note: null },
      { id: ID.zbt, idKind: 'serial', kind: 'multi', model: 'Home Assistant Connect ZBT-1', bus: 'usb', tty: 'ttyUSB0', deconz: false, z2m: 'ember', thread: true, use: 'thread', choice: 'auto', note: null },
      { id: ID.nrf, idKind: 'port', kind: 'thread', model: 'nRF52840 (OpenThread)', bus: 'usb', tty: 'ttyACM2', deconz: false, z2m: null, thread: true, use: null, choice: 'auto', note: null },
      { kind: 'bluetooth', model: null, bus: 'builtin', tty: 'hci0', deconz: false, z2m: null, thread: false, use: null },
    ],
    missing: [],
    zigbee: { stack: 'zigbee2mqtt', mode: 'off', want: false, service: 'managed', state: 'off', recent: [], error: null },
    zigbee2mqtt: { want: true, service: 'managed', state: 'running', broker: 'ok', model: 'Sonoff ZBDongle-E', device: 'ttyACM1', adapter: 'ember', devices: 3, recent: [], error: null },
    ble: { enabled: false, state: 'off' },
    thread: { sticks: 3, models: [], otbr: true, want: true, service: 'managed', state: 'running', role: 'leader', network: null, error: null },
    ...extra,
  };
}
function setTel(g, { caps = CAPS, version = '1.34.0', radio = radioTel() } = {}) {
  const t = { gateway_version: version, capabilities: caps, hardware: { model: 'Raspberry Pi 4 Model B', mem_total: 4 * 1024 ** 3 }, features: radio ? { radio } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), Date.now(), g.peer.id);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async () => null; // the tab falls back to the telemetry
  gw = await gateways.createGateway({ name: 'Pi Funk' });
  old = await gateways.createGateway({ name: 'Pi 1.33.1' });
  db = require('../src/db/connection').getDb();
  hr = require('../src/services/homeRadio');
  setTel(gw);
  setTel(old, { caps: CAPS.filter((c) => c !== 'radio-stick-assign'), version: '1.33.1', radio: radioTel({ sticks: radioTel().sticks.map(({ id, idKind, choice, note, ...s }) => s) }) });
});

after(() => teardown());

describe('sticks set by hand: telemetry and settings', () => {
  it('telemetry: id, idKind, choice and note per stick are checked; missing sticks; new states', () => {
    const t = hr.telemetryRadio({ features: { radio: radioTel({
      sticks: [...radioTel().sticks, { id: '../etc', idKind: 'tty', kind: 'zigbee', model: 'X', bus: 'usb', choice: 'all', note: 'ban', use: 'zha' }],
      missing: [{ id: ID.gone, use: 'zigbee' }, { id: 'a b', use: 'thread' }, { id: ID.zbt, use: 'none' }],
      zigbee2mqtt: { ...radioTel().zigbee2mqtt, state: 'stick_missing' },
      thread: { ...radioTel().thread, state: 'stick_missing' },
    }) } });
    assert.deepEqual(t.sticks.map((s) => [s.id, s.idKind, s.choice, s.note]), [
      [ID.dongleE, 'serial', 'auto', null], [ID.zbt, 'serial', 'auto', null], [ID.nrf, 'port', 'auto', null], [null, null, null, null], [null, null, null, null]]);
    assert.deepEqual(t.missing, [{ id: ID.gone, use: 'zigbee' }]);
    assert.equal(t.zigbee2mqtt.state, 'stick_missing');
    assert.equal(t.thread.state, 'stick_missing');
  });

  it('settings: only valid choices, the first per id, "auto" is not kept; PUT /features validates radio.sticks', async () => {
    assert.deepEqual(hr.normalizeSticks([{ id: ID.zbt, use: 'thread', model: 'ZBT-1\u0007' }, { id: ID.zbt, use: 'zigbee' }, { id: ID.nrf, use: 'auto' }, { id: 'a/b', use: 'zigbee' }]),
      [{ id: ID.zbt, use: 'thread', model: 'ZBT-1' }]);
    for (const bad of [{ radio: { sticks: 'all' } }, { radio: { sticks: [{ id: ID.zbt, use: 'zha' }] } }, { radio: { sticks: [{ id: '; rm', use: 'zigbee' }] } },
      { radio: { sticks: Array.from({ length: 17 }, (_, i) => ({ id: 'port:1-' + i, use: 'none' })) } }]) {
      assert.equal((await admin('put', '/features').send(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    }
  });
});

describe('sticks set by hand: the choice, the config pull and the gateway capability', () => {
  it('an older gateway (no radio-stick-assign): 409 with the version for the hint; the tab says so', async () => {
    const r = await admin('put', '/radio/sticks', old).send({ id: ID.zbt, use: 'zigbee' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'gateway_unsupported');
    assert.match(r.body.error, /newer than 1\.33\.1/);
    const v = (await admin('get', '/radio', old).expect(200)).body.radio;
    assert.equal(v.assignSupported, false);
    assert.equal(v.lastWithoutAssign, '1.33.1');
    assert.ok(v.sticks.every((s) => s.id === null && s.choice === 'auto'), 'no stable ids from an older gateway');
  });

  it('choose Zigbee and Thread by hand → config pull with features.radio.sticks, hash changes; auto again → as before', async () => {
    const c0 = (await gwReq('get', '/config').expect(200)).body;
    assert.equal(c0.features.radio.sticks, undefined, 'nothing chosen → not in the config pull');
    const before = c0.config_hash;
    for (const bad of [{ id: ID.zbt, use: 'zha' }, { id: 'evil id', use: 'zigbee' }, {}]) {
      assert.equal((await admin('put', '/radio/sticks').send(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await admin('put', '/radio/sticks').send({ id: 'usb-Unknown_Stick_1234-if00', use: 'zigbee' })).status, 404, 'a stick the gateway never reported');
    let r = (await admin('put', '/radio/sticks').send({ id: ID.zbt, use: 'zigbee' }).expect(200)).body;
    assert.equal(r.sticks.find((s) => s.id === ID.zbt).choice, 'zigbee');
    await admin('put', '/radio/sticks').send({ id: ID.dongleE, use: 'thread' }).expect(200);
    const c1 = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c1.features.radio.sticks, [{ id: ID.zbt, use: 'zigbee' }, { id: ID.dongleE, use: 'thread' }]);
    assert.notEqual(c1.config_hash, before);
    assert.equal(c1.config_hash, gateways.computeConfigHash(gw.peer.id));
    // stored with the model for the list while the stick is unplugged
    assert.deepEqual(require('../src/services/gatewayFeatures').get(gw.peer.id).radio.sticks.map((e) => e.model), ['Home Assistant Connect ZBT-1', 'Sonoff ZBDongle-E']);
    // a changed choice keeps its place
    await admin('put', '/radio/sticks').send({ id: ID.zbt, use: 'none' }).expect(200);
    assert.deepEqual((await gwReq('get', '/config').expect(200)).body.features.radio.sticks, [{ id: ID.zbt, use: 'none' }, { id: ID.dongleE, use: 'thread' }]);
    const act = db.prepare("SELECT details FROM activity_log WHERE event_type = 'gateway_features_changed' ORDER BY id DESC LIMIT 1").get();
    assert.match(act.details, /"changed":\["radio"\]/);
    // back to automatic
    await admin('put', '/radio/sticks').send({ id: ID.zbt, use: 'auto' }).expect(200);
    r = (await admin('put', '/radio/sticks').send({ id: ID.dongleE, use: 'auto' }).expect(200)).body;
    assert.ok(r.sticks.every((s) => s.choice === 'auto'));
    const c2 = (await gwReq('get', '/config').expect(200)).body;
    assert.equal(c2.features.radio.sticks, undefined);
    assert.equal(c2.config_hash, before, 'all automatic again → the hash of before');
  });

  it('GET /radio: the rows with the choice, what they serve and the hints; an unplugged stick stays listed', async () => {
    await admin('put', '/features').send({ radio: { stack: 'zigbee2mqtt', thread: true } }).expect(200);
    await admin('put', '/radio/sticks').send({ id: ID.nrf, use: 'zigbee' }).expect(200);
    await admin('put', '/radio/sticks').send({ id: ID.zbt, use: 'zigbee' }).expect(200);
    await admin('put', '/radio/sticks').send({ id: ID.dongleE, use: 'thread' }).expect(200);
    // what the gateway reports back after the next pull
    setTel(gw, { radio: radioTel({
      sticks: [
        { ...radioTel().sticks[0], use: 'thread', choice: 'thread' },
        { ...radioTel().sticks[1], use: null, choice: 'zigbee', note: 'second' },
        { ...radioTel().sticks[2], use: null, choice: 'zigbee', note: 'no_adapter' },
      ],
      zigbee2mqtt: { ...radioTel().zigbee2mqtt, state: 'unsupported', model: null, device: null },
    }) });
    let v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.equal(v.assignSupported, true);
    const row = (id) => v.sticks.find((s) => s.id === id);
    assert.deepEqual([row(ID.dongleE).choice, row(ID.dongleE).use, row(ID.dongleE).hints], ['thread', 'thread', ['firmware']]);
    assert.deepEqual(row(ID.zbt).hints, ['second', 'firmware']);
    assert.deepEqual(row(ID.nrf).hints, ['no_adapter', 'port']);
    assert.equal(v.sticks.length, 3, 'Bluetooth is not a radio stick');
    // the ZBT-1 is unplugged: listed with "missing"
    setTel(gw, { radio: radioTel({ sticks: [radioTel().sticks[0], radioTel().sticks[2]], missing: [{ id: ID.zbt, use: 'zigbee' }] }) });
    v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.deepEqual([row(ID.zbt).present, row(ID.zbt).model, row(ID.zbt).hints], [false, 'Home Assistant Connect ZBT-1', ['missing']]);
    // "Automatisch" for an unplugged stick forgets it
    await admin('put', '/radio/sticks').send({ id: ID.zbt, use: 'auto' }).expect(200);
    v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.equal(row(ID.zbt), undefined);
    for (const id of [ID.nrf, ID.dongleE]) await admin('put', '/radio/sticks').send({ id, use: 'auto' }).expect(200);
    await admin('put', '/features').send({ radio: { stack: 'deconz', thread: false } }).expect(200);
    setTel(gw);
  });
});

describe('sticks set by hand: stickPlan (hints, never bans)', () => {
  const tel = () => hr.telemetryRadio({ features: { radio: radioTel() } });
  const plan = (settings, t = tel()) => hr.stickPlan({ ...hr.normalizeSettings(null), ...settings }, t);

  it('deCONZ on a stick it does not speak → fit; Thread on a stick without RCP → fit; zigbee2mqtt without adapter → no_adapter', () => {
    const conbeeLess = plan({ stack: 'deconz', sticks: [{ id: ID.zbt, use: 'zigbee' }] });
    assert.deepEqual(conbeeLess.find((s) => s.id === ID.zbt).hints, ['fit', 'firmware']);
    const t = tel();
    t.sticks[0] = { ...t.sticks[0], kind: 'zigbee', thread: false };
    assert.deepEqual(plan({ thread: true, sticks: [{ id: ID.dongleE, use: 'thread' }] }, t).find((s) => s.id === ID.dongleE).hints, ['fit']);
    assert.deepEqual(plan({ stack: 'zigbee2mqtt', sticks: [{ id: ID.nrf, use: 'zigbee' }] }).find((s) => s.id === ID.nrf).hints, ['no_adapter', 'port']);
  });

  it('the radio is off → radio_off; two sticks for one radio → the first chosen keeps it, the other "second"; "nicht verwenden" has no hint', () => {
    assert.deepEqual(plan({ thread: false, sticks: [{ id: ID.nrf, use: 'thread' }] }).find((s) => s.id === ID.nrf).hints, ['radio_off', 'port']);
    const two = plan({ stack: 'zigbee2mqtt', sticks: [{ id: ID.zbt, use: 'zigbee' }, { id: ID.dongleE, use: 'zigbee' }] });
    assert.deepEqual(two.find((s) => s.id === ID.zbt).hints, ['firmware']);
    assert.deepEqual(two.find((s) => s.id === ID.dongleE).hints, ['second', 'firmware']);
    const none = plan({ sticks: [{ id: ID.zbt, use: 'none' }, { id: ID.gone, use: 'none', model: 'ConBee II' }] });
    assert.deepEqual(none.find((s) => s.id === ID.zbt).hints, []);
    assert.deepEqual(none.find((s) => s.id === ID.gone).hints, [], 'an unplugged stick set to "nicht verwenden" needs no hint');
    // the chosen one is unplugged: the next chosen that is plugged in has the radio
    const gone = plan({ stack: 'zigbee2mqtt', sticks: [{ id: ID.gone, use: 'zigbee', model: 'ConBee II' }, { id: ID.zbt, use: 'zigbee' }] });
    assert.deepEqual(gone.find((s) => s.id === ID.gone).hints, ['missing']);
    assert.deepEqual(gone.find((s) => s.id === ID.zbt).hints, ['firmware']);
  });

  it('the kit: hint keys per stack, tones of the new states', () => {
    const K = require('../public/js/gateway-radio-kit');
    assert.deepEqual(K.STICK_CHOICES, ['auto', 'zigbee', 'thread', 'none']);
    assert.deepEqual(K.stickHintKeys({ choice: 'zigbee', hints: ['fit', 'firmware', 'evil'] }, 'deconz'), ['gwr.stick.hint.fit_deconz', 'gwr.stick.hint.firmware']);
    assert.deepEqual(K.stickHintKeys({ choice: 'zigbee', hints: ['fit'] }, 'zigbee2mqtt'), ['gwr.stick.hint.fit_zigbee']);
    assert.deepEqual(K.stickHintKeys({ choice: 'thread', hints: ['fit', 'missing'] }, 'deconz'), ['gwr.stick.hint.fit_thread', 'gwr.stick.hint.missing']);
    assert.equal(K.zigbeeTone('stick_missing'), 'amber');
    assert.equal(K.threadTone('stick_missing'), 'amber');
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    for (const k of ['missing', 'second', 'radio_off', 'fit_deconz', 'fit_zigbee', 'fit_thread', 'no_adapter', 'firmware', 'port']) {
      assert.ok(de['gwr.stick.hint.' + k] && en['gwr.stick.hint.' + k], k);
    }
    for (const c of K.STICK_CHOICES) assert.ok(de['gwr.stick.choice.' + c] && en['gwr.stick.choice.' + c] && de['gwr.stick.done.' + c], c);
    assert.equal(de['gwr.stick.choice.auto'], 'Automatisch (Standard)');
    assert.match(de['gwr.stick.assign_old'], /\{\{version\}\}/);
  });
});

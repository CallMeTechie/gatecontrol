'use strict';

// Funk, server side (phase 3c, step 2 — services/homeRadio.js, the gateway's
// docs/radio.md): features.radio in the config pull and the card "Funktionen"
// (row in "Geräte im Heimnetz", "Gateway zu alt", memory), the telemetry of the
// gateway (checked), the Bluetooth report (checked, only its own rows), "Übernehmen",
// the tab "Funk" (live from the gateway, pairing, retry), the compose download with
// the deconz service, gc.radio in a real plugin process and the pure helpers of the tab.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { radioPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, gw2, gateways, plugins, hr;
const mgmt = [];
let statusAnswer = null;

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);

const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print'];
function radioTel(extra = {}) {
  return {
    enabled: true,
    sticks: [{ kind: 'zigbee', model: 'ConBee II', bus: 'usb', tty: 'ttyACM0', deconz: true }, { kind: 'multi', model: 'Home Assistant Connect ZBT-1', bus: 'usb', tty: 'ttyUSB0', deconz: false },
      { kind: 'bluetooth', model: null, bus: 'builtin', tty: 'hci0', deconz: false }, { kind: 'laser', model: 'x' }],
    zigbee: { mode: 'auto', want: true, service: 'managed', state: 'running', model: 'ConBee II', device: 'ttyACM0', firmware: '0x26780700', channel: 15, devices: 14,
      permitUntil: null, recent: [{ mac: '00:15:8d:00:0a:0b:0c:0d', type: 'sensor', name: 'OpenClose 9', model: 'lumi.sensor_magnet.aq2', manufacturer: 'LUMI', at: new Date().toISOString() }, { mac: 'evil' }], error: null },
    ble: { enabled: true, state: 'running', mode: 'legacy', adapter: { name: 'hci0', bus: 'builtin', model: null }, sensors: 3, lastAt: new Date().toISOString(), error: null },
    thread: { sticks: 1, models: ['Home Assistant Connect ZBT-1'], otbr: false },
    ...extra,
  };
}
function setTel(g, { caps = CAPS.concat('radio'), version = '1.25.0', radio = radioTel(), platform = null } = {}) {
  const t = { gateway_version: version, capabilities: caps, hardware: { model: 'Raspberry Pi 4 Model B Rev 1.4', mem_total: 4 * 1024 ** 3, ...(platform ? { platform } : {}) }, features: radio ? { radio } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), Date.now(), g.peer.id);
}
const sensor = (mac, extra = {}) => ({ mac, format: 'pvvx', encrypted: false, name: null, values: { temperature: 8.9, humidity: 64, battery: 82, voltage: 2.95 }, rssi: -71,
  firstSeen: new Date(Date.now() - 120000).toISOString(), seenAt: new Date().toISOString(), ...extra });

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async (peerId, p, body) => {
    mgmt.push({ peerId, path: p, body });
    if (p === '/api/radio/status') return statusAnswer;
    return { status: 202, body: { accepted: true } };
  };
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  gw2 = await gateways.createGateway({ name: 'DS918 Gateway' });
  db = require('../src/db/connection').getDb();
  hr = require('../src/services/homeRadio');
  plugins = require('../src/services/plugins');
  setTel(gw);
  setTel(gw2, { caps: CAPS, version: '1.24.0', radio: null });
});

after(async () => { await plugins.stop(); teardown(); });

describe('features.radio and the row "Funk"', () => {
  it('default automatic Zigbee, Bluetooth off → config pull; switches validated; part of the config hash', async () => {
    let c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.radio, { zigbee: null, ble: false });
    for (const bad of [{ radio: { zigbee: 'yes' } }, { radio: { ble: null } }, { radio: { channel: 11 } }, { radio: [] }]) {
      assert.equal((await admin('put', '/features').send(bad)).status, 400, JSON.stringify(bad));
    }
    const before = gateways.computeConfigHash(gw.peer.id);
    const v = (await admin('put', '/features').send({ radio: { zigbee: true, ble: true } }).expect(200)).body.gateway;
    assert.deepEqual(v.features.radio, { zigbee: true, ble: true, stack: 'deconz', thread: false, sticks: [] });
    c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.radio, { zigbee: true, ble: true });
    assert.notEqual(c.config_hash, before);
    assert.equal(c.config_hash, gateways.computeConfigHash(gw.peer.id));
    await admin('put', '/features').send({ radio: { zigbee: null } }).expect(200);
    assert.deepEqual((await gwReq('get', '/config').expect(200)).body.features.radio, { zigbee: null, ble: true });
  });

  it('overview: sticks (checked), state, memory (deCONZ + Bluetooth), the group "Geräte im Heimnetz"', async () => {
    const v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.support.radio, true);
    assert.equal(v.radio.supported, true);
    assert.equal(v.radio.enabled, true);
    assert.deepEqual(v.radio.sticks.map((s) => s.kind), ['zigbee', 'multi', 'bluetooth'], 'unknown kinds dropped');
    assert.deepEqual(v.radio.state, { zigbee: 'running', service: 'managed', devices: 14, model: 'ConBee II', ble: 'running', bleSensors: 3, thread: 1 });
    assert.equal(v.radio.compose, null);
    assert.deepEqual(v.memory.parts.filter((p) => ['deconz', 'ble'].includes(p.key)), [{ key: 'deconz', mb: 90 }, { key: 'ble', mb: 5 }]);
    const kit = require('../public/js/gateway-pool-kit');
    assert.equal(kit.groupOf('radio'), 'devices');
    assert.equal(kit.groupOf('zigbee'), 'devices', 'the old row moved too');
    assert.deepEqual(kit.featureStates(v).find((x) => x.key === 'radio'), { key: 'radio', on: true });
    assert.equal(kit.featureStates(v).find((x) => x.key === 'zigbee'), undefined);
    assert.equal(kit.memoryOf(v, 'radio'), 95);
    assert.equal(kit.tabOff(v, 'radio'), false);
    assert.equal(kit.tabOff({ ...v, radio: { ...v.radio, enabled: false } }, 'radio'), true);
  });

  it('an older gateway: support false, "Gateway zu alt – ab 1.25.0"; pairing refused', async () => {
    const v = (await admin('get', '/features', gw2).expect(200)).body.gateway;
    assert.equal(v.support.radio, false);
    assert.equal(v.support.minGatewayRadio, '1.25.0');
    assert.equal(v.radio.supported, false);
    assert.equal(v.radio.minGateway, '1.25.0');
    const r = await admin('post', '/radio/zigbee/pair', gw2).send({});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'gateway_unsupported');
  });

  it('compose hint: Synology with a stick but no deconz service → "compose"; the Pi image starts it itself', () => {
    const t = hr.telemetryRadio({ features: { radio: radioTel({ zigbee: { ...radioTel().zigbee, state: 'service_missing', service: 'missing' } }) } });
    assert.equal(hr.composeHint(t, 'synology'), 'compose');
    assert.equal(hr.composeHint(t, 'rpi'), 'image');
    assert.equal(hr.composeHint({ ...t, zigbee: { ...t.zigbee, service: 'absent' } }, 'rpi'), null);
    assert.equal(hr.composeHint(hr.telemetryRadio({ features: { radio: radioTel() } }), 'synology'), null);
    assert.equal(hr.composeHint(null, 'linux'), null);
  });
});

describe('telemetry of the gateway is input', () => {
  it('strings cut, states from the list, recent devices with a valid MAC only', () => {
    const t = hr.telemetryRadio({ features: { radio: radioTel({ zigbee: { state: 'pwned', service: 'x', device: '../x', firmware: 'zz', channel: 99, devices: -1, recent: [{ mac: '00:15:8d:00:0a:0b:0c:0d', name: 'a'.repeat(200) }] } }) } });
    assert.equal(t.zigbee.state, 'off');
    assert.equal(t.zigbee.service, 'missing');
    assert.equal(t.zigbee.device, null);
    assert.equal(t.zigbee.firmware, null);
    assert.equal(t.zigbee.channel, null);
    assert.equal(t.zigbee.devices, null);
    assert.equal(t.zigbee.recent[0].name.length, 48);
    assert.equal(hr.telemetryRadio({}), null);
  });
});

describe('Bluetooth sensors', () => {
  it('report: checked (format, MAC, value ranges), stored per gateway; bad body → 400', async () => {
    await gwReq('post', '/radio/ble').send({ sensors: 'x' }).expect(400);
    const r = await gwReq('post', '/radio/ble').send({ scannedAt: new Date().toISOString(), adapter: { name: 'hci0', bus: 'builtin' }, sensors: [
      sensor('A4:C1:38:11:22:33'),
      sensor('7C:C6:B6:00:11:22', { format: 'bthome', name: 'SBHT-003C', values: { battery: 100, humidity: 71, temperature: 14.2, evil: 'x', pressure: 99999 } }),
      sensor('A4:C1:38:99:88:77', { format: 'mibeacon', encrypted: true, values: {} }),
      sensor('not-a-mac'),
      sensor('00:11:22:33:44:55', { format: 'ibeacon' }),
    ] }).expect(200);
    assert.equal(r.body.sensors, 3);
    const rows = hr.sensorsOf(gw.peer.id);
    assert.equal(rows.length, 3);
    const shelly = rows.find((x) => x.mac === '7C:C6:B6:00:11:22');
    assert.deepEqual(shelly.values, { temperature: 14.2, humidity: 71, battery: 100 });
    assert.equal(shelly.model, 'Shelly BLU H&T');
    assert.equal(rows.find((x) => x.mac === 'A4:C1:38:11:22:33').model, 'Xiaomi LYWSD03MMC');
    assert.equal(hr.sensorsOf(gw2.peer.id).length, 0);
  });

  it('"Übernehmen" with a name; rename; give back; unknown → 404; invalid → 400', async () => {
    let r = await admin('put', '/radio/sensors/a4:c1:38:11:22:33').send({ accepted: true, name: '  Gartenhaus  ' }).expect(200);
    assert.equal(r.body.sensor.accepted, true);
    assert.equal(r.body.sensor.name, 'Gartenhaus');
    r = await admin('put', '/radio/sensors/7C:C6:B6:00:11:22').send({ accepted: true, name: 'Keller' }).expect(200);
    await admin('put', '/radio/sensors/7C:C6:B6:00:11:22').send({ name: 'Keller ' }).expect(200);
    assert.equal((await admin('put', '/radio/sensors/00:00:00:00:00:01').send({ accepted: true })).status, 404);
    assert.equal((await admin('put', '/radio/sensors/xyz').send({ accepted: true })).status, 400);
    assert.equal((await admin('put', '/radio/sensors/A4:C1:38:11:22:33').send({ accepted: 'yes' })).status, 400);
    assert.equal((await admin('put', '/radio/sensors/A4:C1:38:11:22:33', gw2).send({ accepted: true })).status, 404, 'only its own rows');
    const ov = (await admin('get', '/features').expect(200)).body.gateway.radio;
    assert.deepEqual(ov.sensors, { accepted: 2, fresh: 1 });
  });

  it('a new report keeps the name and the decision', async () => {
    await gwReq('post', '/radio/ble').send({ sensors: [sensor('A4:C1:38:11:22:33', { values: { temperature: 9.4, humidity: 66, battery: 81 } })] }).expect(200);
    const s = hr.sensorsOf(gw.peer.id).find((x) => x.mac === 'A4:C1:38:11:22:33');
    assert.equal(s.accepted, true);
    assert.equal(s.name, 'Gartenhaus');
    assert.equal(s.values.temperature, 9.4);
  });

  it('housekeeping: not taken over and not heard for a day → gone; taken over stays', () => {
    db.prepare('UPDATE gateway_ble_sensors SET seen_at = ? WHERE peer_id = ?').run(Date.now() - 2 * 86400e3, gw.peer.id);
    assert.equal(hr.housekeeping(), 1);
    assert.deepEqual(hr.sensorsOf(gw.peer.id).map((x) => x.mac).sort(), ['7C:C6:B6:00:11:22', 'A4:C1:38:11:22:33']);
    assert.equal(hr.sensorsOf(gw.peer.id)[0].online, false);
    db.prepare('UPDATE gateway_ble_sensors SET seen_at = ? WHERE peer_id = ?').run(Date.now(), gw.peer.id);
  });
});

describe('tab "Funk"', () => {
  it('GET /radio: live state from the gateway when it answers, else the telemetry; sensors; Smart Home', async () => {
    statusAnswer = { status: 200, body: { radio: radioTel({ zigbee: { ...radioTel().zigbee, devices: 15 } }) } };
    let v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.equal(v.live, true);
    assert.equal(v.radio.zigbee.devices, 15);
    assert.equal(v.supported, true);
    assert.deepEqual(v.settings, { zigbee: null, ble: true, stack: 'deconz', thread: false, sticks: [] });
    assert.equal(v.sensors.length, 2);
    assert.ok(v.smarthome && v.smarthome.installed === false);
    assert.ok(mgmt.some((m) => m.path === '/api/radio/status'));
    statusAnswer = null;
    v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.equal(v.live, false);
    assert.equal(v.radio.zigbee.devices, 14);
  });

  it('pairing and retry go to the gateway; its answers become codes', async () => {
    mgmt.length = 0;
    assert.equal((await admin('post', '/radio/zigbee/pair').send({ seconds: 5 })).status, 400);
    await admin('post', '/radio/zigbee/pair').send({}).expect(200);
    assert.deepEqual(mgmt.find((m) => m.path === '/api/radio/zigbee/pair').body, { seconds: 180 });
    await admin('post', '/radio/zigbee/retry').send({}).expect(200);
    const keep = gateways.mgmtCall;
    gateways.mgmtCall = async () => ({ status: 409, body: { error: 'key_needed' } });
    let r = await admin('post', '/radio/zigbee/pair').send({});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'key_needed');
    gateways.mgmtCall = async () => null;
    r = await admin('post', '/radio/zigbee/pair').send({});
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'gateway_unreachable');
    gateways.mgmtCall = keep;
  });

  it('compose download: with a deCONZ stick the deconz service comes along (no profile), without it not', async () => {
    const kit = require('../public/js/gateway-kit');
    let text = (await admin('post', '/compose').send({ platform: 'synology' }).expect(200)).text;
    assert.equal(text, kit.buildCompose({ platform: 'synology', network: 'host', zigbee: true }));
    assert.match(text, /\n {2}deconz:\n/);
    assert.doesNotMatch(text, /profiles:/);
    text = (await admin('post', '/compose').send({ platform: 'synology', zigbee: false }).expect(200)).text;
    assert.doesNotMatch(text, /\n {2}deconz:\n/);
    text = (await admin('post', '/compose', gw2).send({ platform: 'linux' }).expect(200)).text;
    assert.doesNotMatch(text, /\n {2}deconz:\n/, 'no stick reported');
  });
});

describe('gc.radio in a plugin process', () => {
  it('only taken-over sensors of gateways with Bluetooth on', async () => {
    const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(radioPackage());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.plugin.permissions.radio, true, 'shown in the install dialog');
    await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    const call = async (p) => (await agent.post('/api/v1/plugins/radio-demo/api' + p).set('X-CSRF-Token', csrf).send({}).expect(200)).body;
    let has = null;
    for (let i = 0; i < 50 && !has; i++) { try { has = await call('/has'); } catch { await new Promise((res) => setTimeout(res, 100)); } }
    assert.equal(has.radio, true);
    let s = await call('/sensors');
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.deepEqual(s.result.map((x) => [x.id, x.name, x.gateway, x.model]), [
      ['ble:a4c138112233', 'Gartenhaus', 'Pi Keller', 'Xiaomi LYWSD03MMC'],
      ['ble:7cc6b6001122', 'Keller', 'Pi Keller', 'Shelly BLU H&T'],
    ]);
    assert.equal(s.result[0].battery, 81);
    await admin('put', '/features').send({ radio: { ble: false } }).expect(200);
    s = await call('/sensors');
    assert.deepEqual(s.result, [], 'Bluetooth off on the gateway → none');
    await admin('put', '/features').send({ radio: { ble: true } }).expect(200);
  });
});

describe('gateway-radio-kit (the tab\'s pure rules)', () => {
  const K = require('../public/js/gateway-radio-kit');
  it('values, tags, countdown, badge, deep link', () => {
    assert.deepEqual(K.valueParts({ humidity: 71, temperature: 14.2, window: true, junk: 1 }).map((p) => p.key), ['temperature', 'humidity', 'window']);
    assert.deepEqual(K.sensorTags({ humidity: 71, battery: 82 }).map((x) => x.key), ['gwr.ble.humid_high', 'gwr.ble.battery']);
    assert.deepEqual(K.sensorTags({ battery: 9 }).map((x) => x.key), ['gwr.ble.battery_low']);
    assert.equal(K.secondsLeft(new Date(1000 + 90_000).toISOString(), 1000), 90);
    assert.equal(K.secondsLeft(null), 0);
    assert.deepEqual(K.zigbeeText({ state: 'running', devices: 14 }), { key: 'gwr.zb.running_n', params: { n: 14 } });
    assert.equal(K.zigbeeTone('key_needed'), 'amber');
    assert.deepEqual(K.badge({ radio: { enabled: true, ble: true, state: { zigbee: 'running', devices: 3, ble: 'running' }, sensors: { accepted: 2, fresh: 0 } } }), { tone: 'grey', key: 'gwr.tabs.count', params: { n: 5 } });
    assert.equal(K.badge({ radio: { enabled: true, ble: true, state: { zigbee: 'error' }, sensors: {} } }).key, 'gwr.tabs.problem');
    assert.equal(K.badge({ radio: { enabled: true, ble: true, state: { zigbee: 'off' }, sensors: { fresh: 2 } } }).params.n, 2);
    assert.equal(K.badge({ radio: { enabled: false } }), null);
    assert.equal(K.smarthomeLink('zigbee', '00:15:8D:00:0A:0B:0C:0D'), '/plugins/gatecontrol-smarthome?focus=zigbee%3A00%3A15%3A8d%3A00%3A0a%3A0b%3A0c%3A0d');
    assert.equal(K.smarthomeLink('ble', 'x'), null);
  });
  it('the tab is in the bar between "Zwischenspeicher" and "Edge-Plugins"', () => {
    const E = require('../public/js/gateway-edge-kit');
    assert.equal(E.TABS.indexOf('radio'), E.TABS.indexOf('cache') + 1);
    assert.deepEqual(E.parseHash('#gw/7/radio'), { id: '7', tab: 'radio' });
  });
});

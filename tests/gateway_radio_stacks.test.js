'use strict';

// Funk, follow-ups (services/homeRadio.js, the gateway's docs/radio.md): zigbee2mqtt
// as the second Zigbee stack (switch, config pull, telemetry, device report as a
// complete list, gc.radio.zigbee / gc.radio.command in a real plugin process,
// "Entfernen"), the Thread border router (telemetry without the network key, form,
// join, dataset on request), keys of encrypted Bluetooth sensors (stored
// encrypted, only the stand in the config pull, the keys only through
// /radio/ble/keys, never in a view or the activity log), compose with the new
// services, memory, and the older gateway without them.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { radioPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, gw, old, gateways, plugins, hr;
const mgmt = [];
let answer = () => ({ status: 202, body: { accepted: true } });

const gwReq = (method, p, g = gw) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + g.apiToken);
const admin = (method, p, g = gw) => agent[method]('/api/v1/gateways/' + g.peer.id + p).set('X-CSRF-Token', csrf);

const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print', 'radio', 'radio-stacks'];
// what a gateway with the capability radio-stacks reports: stack, the zigbee2mqtt part, the border router
function radioTel(extra = {}) {
  return {
    enabled: true,
    stack: 'zigbee2mqtt',
    sticks: [
      { kind: 'multi', model: 'Sonoff ZBDongle-E', bus: 'usb', tty: 'ttyACM1', deconz: false, z2m: 'ember', thread: true, use: 'zigbee2mqtt' },
      { kind: 'multi', model: 'Home Assistant Connect ZBT-1', bus: 'usb', tty: 'ttyUSB0', deconz: false, z2m: 'ember', thread: true, use: 'thread' },
      { kind: 'zigbee', model: 'X', bus: 'usb', tty: 'ttyUSB1', deconz: false, z2m: 'evil', thread: 'yes', use: 'zha' },
    ],
    zigbee: { stack: 'zigbee2mqtt', mode: 'off', want: false, service: 'managed', state: 'off', recent: [], error: null },
    zigbee2mqtt: { want: true, service: 'managed', state: 'running', broker: 'ok', model: 'Sonoff ZBDongle-E', device: 'ttyACM1', adapter: 'ember', version: '2.14.2',
      firmware: '7.4.4.0', channel: 15, devices: 3, permitUntil: null, recent: [{ mac: '00:17:88:01:00:aa:bb:cc', type: 'device', name: 'Hue', model: '9290012573A', manufacturer: 'Philips', at: new Date().toISOString() }], error: null },
    ble: { enabled: true, state: 'running', mode: 'legacy', adapter: { name: 'hci0', bus: 'builtin', model: null }, sensors: 1, keys: 1, lastAt: new Date().toISOString(), error: null },
    thread: { sticks: 2, models: ['Sonoff ZBDongle-E', 'Home Assistant Connect ZBT-1'], otbr: true, want: true, service: 'managed', state: 'running', role: 'leader',
      model: 'Home Assistant Connect ZBT-1', device: 'ttyUSB0', infra: 'eth0', network: { name: 'GateControl', channel: 25, panId: 4660, extPanId: 'dead00beef00cafe', networkKey: '00112233445566778899aabbccddeeff' },
      routers: 1, forwarding: false, error: null },
    ...extra,
  };
}
function setTel(g, { caps = CAPS, version = '1.32.0', radio = radioTel(), mem = 4 * 1024 ** 3 } = {}) {
  const t = { gateway_version: version, capabilities: caps, hardware: { model: 'Raspberry Pi 3 Model B Plus Rev 1.3', mem_total: mem }, features: radio ? { radio } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = 1, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), Date.now(), g.peer.id);
}

const DEVICES = [
  { ieee: '00:17:88:01:0b:2c:3d:4e', name: 'Wohnzimmer/Decke', model: '9290012573A', vendor: 'Philips', kind: 'light', caps: { bri: true, ct: true, color: 'xy', evil: true },
    values: { on: true, bri: 50, ct: 370, linkquality: 120, junk: 'x' }, type: 'router', power: 'Mains (single phase)', supported: true, interview: 'done', available: true, seenAt: new Date().toISOString() },
  { ieee: '00:0d:6f:ff:fe:1a:2b:3c', name: 'Steckdose Kaffee', model: 'E1603', vendor: 'IKEA', kind: 'plug', caps: {}, values: { on: false }, type: 'router', supported: true, interview: 'done', seenAt: new Date().toISOString() },
  { ieee: '00:15:8d:00:01:a2:b3:c4', name: 'Bad Klima', model: 'WSDCGQ11LM', vendor: 'Aqara', kind: 'sensor', caps: { battery: true }, values: { temperature: 21.37, humidity: 55.1, battery: 100 },
    type: 'end_device', power: 'Battery', supported: true, interview: 'done', seenAt: new Date().toISOString() },
  { ieee: 'a4:c1:38:aa:bb:cc:dd:ee', name: '0xa4c138aabbccddee', kind: 'other', supported: false, interview: 'running' },
  { ieee: 'not-an-ieee', kind: 'light' },
];

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  gateways.mgmtCall = async (peerId, p, body) => { mgmt.push({ peerId, path: p, body }); return answer(p, body); };
  gw = await gateways.createGateway({ name: 'Pi Keller' });
  old = await gateways.createGateway({ name: 'Pi alt' });
  db = require('../src/db/connection').getDb();
  hr = require('../src/services/homeRadio');
  plugins = require('../src/services/plugins');
  setTel(gw);
  // 1.31.0: radio, but not radio-stacks (no zigbee2mqtt, no border router, no keys)
  setTel(old, { caps: CAPS.filter((c) => c !== 'radio-stacks'), version: '1.31.0', radio: { enabled: true, sticks: [], zigbee: { state: 'off', recent: [] }, ble: { state: 'off' }, thread: { sticks: 0, models: [], otbr: false } } });
});

after(async () => { await plugins.stop(); teardown(); });

describe('zigbee2mqtt and Thread: switches, config pull, telemetry', () => {
  it('stack and thread only in the config pull when set (the hash of others stays); validated', async () => {
    let c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.radio, { zigbee: null, ble: false });
    for (const bad of [{ radio: { stack: 'zha' } }, { radio: { stack: null } }, { radio: { thread: 'yes' } }]) {
      assert.equal((await admin('put', '/features').send(bad)).status, 400, JSON.stringify(bad));
    }
    const v = (await admin('put', '/features').send({ radio: { stack: 'zigbee2mqtt', thread: true, ble: true } }).expect(200)).body.gateway;
    assert.deepEqual(v.features.radio, { zigbee: null, ble: true, stack: 'zigbee2mqtt', thread: true, sticks: [] });
    c = (await gwReq('get', '/config').expect(200)).body;
    assert.deepEqual(c.features.radio, { zigbee: null, ble: true, stack: 'zigbee2mqtt', thread: true });
    assert.equal(c.config_hash, gateways.computeConfigHash(gw.peer.id));
  });

  it('telemetry: sticks with adapter and use (checked), zigbee2mqtt, border router without the network key', () => {
    const t = hr.telemetryRadio({ features: { radio: radioTel() } });
    assert.equal(t.stack, 'zigbee2mqtt');
    assert.deepEqual(t.sticks.map((s) => [s.model, s.z2m, s.thread, s.use]), [['Sonoff ZBDongle-E', 'ember', true, 'zigbee2mqtt'], ['Home Assistant Connect ZBT-1', 'ember', true, 'thread'], ['X', null, false, null]]);
    assert.deepEqual({ state: t.zigbee2mqtt.state, broker: t.zigbee2mqtt.broker, devices: t.zigbee2mqtt.devices, version: t.zigbee2mqtt.version }, { state: 'running', broker: 'ok', devices: 3, version: '2.14.2' });
    assert.equal(t.zigbee2mqtt.recent[0].mac, '00:17:88:01:00:aa:bb:cc');
    assert.equal(t.thread.supported, true);
    assert.deepEqual(t.thread.network, { name: 'GateControl', channel: 25, panId: 4660, extPanId: 'dead00beef00cafe' });
    assert.doesNotMatch(JSON.stringify(t), /00112233445566778899/, 'never the network key');
    assert.equal(t.thread.forwarding, false);
    assert.equal(t.ble.keys, 1);
    // an older gateway: Thread only detected
    const o = hr.telemetryRadio({ features: { radio: { thread: { sticks: 1, models: ['ZBT-1'], otbr: false } } } });
    assert.equal(o.thread.supported, false);
    assert.equal(o.zigbee2mqtt, null);
  });

  it('overview: state from zigbee2mqtt, memory with zigbee2mqtt and the border router, compose hint for a missing service', async () => {
    const v = (await admin('get', '/features').expect(200)).body.gateway;
    assert.equal(v.radio.stack, 'zigbee2mqtt');
    assert.equal(v.radio.stacksSupported, true);
    assert.deepEqual({ z: v.radio.state.zigbee, d: v.radio.state.devices, th: v.radio.state.threadState }, { z: 'running', d: 3, th: 'running' });
    assert.deepEqual(v.memory.parts.filter((p) => ['zigbee2mqtt', 'otbr', 'deconz'].includes(p.key)), [{ key: 'zigbee2mqtt', mb: 120 }, { key: 'otbr', mb: 60 }]);
    const miss = hr.telemetryRadio({ features: { radio: radioTel({ zigbee2mqtt: { ...radioTel().zigbee2mqtt, state: 'service_missing', service: 'missing' } }) } });
    assert.equal(hr.composeHint(miss, 'synology'), 'compose');
    const mqttOff = hr.telemetryRadio({ features: { radio: radioTel({ zigbee2mqtt: { ...radioTel().zigbee2mqtt, state: 'mqtt_off', service: 'missing' } }) } });
    assert.equal(hr.composeHint(mqttOff, 'synology'), null, 'MQTT off is not a compose question');
    const thMiss = hr.telemetryRadio({ features: { radio: radioTel({ thread: { ...radioTel().thread, state: 'service_missing', service: 'absent' } }) } });
    assert.equal(hr.composeHint(thMiss, 'rpi'), null, 'the Pi image starts it itself');
    assert.equal(hr.composeHint(thMiss, 'linux'), 'compose');
  });

  it('compose download: zigbee2mqtt and otbr come along when chosen (no deconz with zigbee2mqtt)', async () => {
    const kit = require('../public/js/gateway-kit');
    const text = (await admin('post', '/compose').send({ platform: 'linux' }).expect(200)).text;
    assert.equal(text, kit.buildCompose({ platform: 'linux', network: 'host', zigbee: false, zigbee2mqtt: true, thread: true }));
    assert.match(text, /\n {2}zigbee2mqtt:\n/);
    assert.match(text, /\n {2}otbr:\n/);
    assert.doesNotMatch(text, /\n {2}deconz:\n/);
    assert.doesNotMatch(text, /profiles:/);
  });
});

describe('zigbee2mqtt devices', () => {
  it('report: checked, complete list (missing ones go), only its own rows; tab shows them', async () => {
    assert.equal((await gwReq('post', '/radio/zigbee').send({ stack: 'deconz', devices: [] })).status, 400);
    const r = (await gwReq('post', '/radio/zigbee').send({ stack: 'zigbee2mqtt', devices: DEVICES }).expect(200)).body;
    assert.equal(r.devices, 4);
    const list = hr.zigbeeDevicesOf(gw.peer.id);
    const bulb = list.find((d) => d.kind === 'light');
    assert.deepEqual(bulb.caps, { bri: true, ct: true, color: 'xy' }, 'unknown capabilities dropped');
    assert.deepEqual(bulb.values, { on: true, bri: 50, ct: 370, linkquality: 120 });
    await gwReq('post', '/radio/zigbee').send({ stack: 'zigbee2mqtt', devices: DEVICES.slice(0, 3) }).expect(200);
    assert.equal(hr.zigbeeDevicesOf(gw.peer.id).length, 3, 'removed from the network → gone');
    assert.equal(hr.zigbeeDevicesOf(old.peer.id).length, 0);
    answer = (p) => (p === '/api/radio/status' ? null : { status: 202, body: { accepted: true } });
    const v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.equal(v.zigbeeDevices.length, 3);
    assert.equal(v.stacksSupported, true);
    assert.deepEqual(v.edge, { edgeEnabled: false, mqttEnabled: false });
    assert.equal(v.gateway.memTotal, 4 * 1024 ** 3);
    answer = () => ({ status: 202, body: { accepted: true } });
  });

  it('live tab: the devices the gateway names now', async () => {
    answer = (p) => (p === '/api/radio/status' ? { status: 200, body: { radio: { ...radioTel(), zigbeeDevices: [DEVICES[1]], bleSensors: [] } } } : { status: 202, body: {} });
    const v = (await admin('get', '/radio').expect(200)).body.radio;
    assert.equal(v.live, true);
    assert.deepEqual(v.zigbeeDevices.map((d) => d.name), ['Steckdose Kaffee']);
    answer = () => ({ status: 202, body: { accepted: true } });
  });

  it('several channels, thermostats and firmware over the air: reported fields checked, handed to plugins, commands checked', async () => {
    const seen = new Date().toISOString();
    const more = [
      { ieee: 'a4:c1:38:00:00:11:22:33', name: 'Schalter Flur', model: 'TS0003', vendor: 'Tuya', kind: 'plug', type: 'router', seenAt: seen,
        caps: { channels: ['l1', 'l2', 'l3', 'l1', '../x', 7], ota: true, chProps: { l1: 'state_l1' } },
        values: { on: true, ch: { l1: true, l2: false, l3: 'yes', '__proto__x': true, 'bad name': true }, ota: { state: 'available', installed: '16777220', latest: '16777221', checked: '2026-11-11T10:00:00Z', junk: 1 } } },
      { ieee: '54:ef:44:10:00:aa:bb:cc', name: 'Heizung Bad', model: 'SRTS-A01', vendor: 'Aqara', kind: 'climate', type: 'end_device', power: 'Battery', seenAt: seen,
        caps: { setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['heat', 'off', 'party'], battery: true, ota: true },
        values: { temperature: 20.4, setpoint: 21.5, mode: 'heat', heating: true, valve: 37.4, battery: 64, ota: { state: 'updating', progress: 37.6, error: 'nonsense' } } },
      { ieee: '00:15:8d:00:09:09:09:09', name: 'Kaputt', kind: 'climate', type: 'end_device', seenAt: seen,
        caps: { setpoint: { min: 30, max: 5, step: 0 }, modes: 'heat', channels: ['l1'], ota: 'yes' },
        values: { setpoint: 500, mode: 'party', heating: 'yes', valve: 300, ch: [true], ota: { state: 'weird', progress: 12, installed: '<b>', checked: 'never' } } },
    ];
    await gwReq('post', '/radio/zigbee').send({ stack: 'zigbee2mqtt', devices: more }).expect(200);
    const by = Object.fromEntries(hr.pluginZigbee().devices.map((d) => [d.name, d]));
    assert.deepEqual(by['Schalter Flur'].caps, { ota: true, channels: ['l1', 'l2', 'l3'] }, 'clean channel names once, nothing unknown');
    assert.deepEqual(by['Schalter Flur'].values, { on: true, ch: { l1: true, l2: false }, ota: { state: 'available', installed: '16777220', latest: '16777221', checked: '2026-11-11T10:00:00.000Z' } });
    assert.equal(by['Heizung Bad'].kind, 'climate');
    assert.deepEqual(by['Heizung Bad'].caps, { battery: true, ota: true, setpoint: { min: 5, max: 30, step: 0.5 }, modes: ['off', 'heat'] });
    assert.deepEqual(by['Heizung Bad'].values, { temperature: 20.4, battery: 64, setpoint: 21.5, mode: 'heat', heating: true, valve: 37, ota: { state: 'updating', progress: 38 } });
    assert.deepEqual([by['Kaputt'].caps, by['Kaputt'].values], [{}, { ota: { state: 'idle' } }], 'what does not fit is dropped');
    // the tab "Funk" names the kind
    const en = require('../src/i18n/en.json');
    const de = require('../src/i18n/de.json');
    assert.ok(en['gwr.z2m.kind.climate'] && de['gwr.z2m.kind.climate']);

    // commands of a plugin: a channel, a thermostat, firmware
    assert.deepEqual(hr.cleanCommand({ on: true, channel: 'l2' }), { on: true, channel: 'l2' });
    assert.deepEqual(hr.cleanCommand({ setpoint: 21.5, mode: 'heat', junk: 1 }), { setpoint: 21.5, mode: 'heat' });
    assert.deepEqual(hr.cleanCommand({ ota: 'check' }), { ota: 'check' });
    for (const bad of [{ channel: 'l2' }, { on: true, channel: '../x' }, { on: true, channel: 7 }, { on: 'yes', channel: 'l1' }, { setpoint: 99 }, { setpoint: '21' }, { mode: 'party' },
      { ota: 'erase' }, { ota: true }, { ota: 'update', on: true }, { on: true, ota: 'check' }]) {
      assert.throws(() => hr.cleanCommand(bad), (e) => e.code === 'invalid', JSON.stringify(bad));
    }
    mgmt.length = 0;
    answer = () => ({ status: 202, body: { accepted: true } });
    assert.deepEqual(await hr.zigbeeCommand('z2m:a4c1380000112233', { on: false, channel: 'l3' }), { accepted: true });
    assert.deepEqual(mgmt.at(-1), { peerId: gw.peer.id, path: '/api/radio/zigbee/set', body: { ieee: 'a4:c1:38:00:00:11:22:33', set: { on: false, channel: 'l3' } } });
    await hr.zigbeeCommand('z2m:54ef441000aabbcc', { setpoint: 22 });
    assert.deepEqual(mgmt.at(-1).body, { ieee: '54:ef:44:10:00:aa:bb:cc', set: { setpoint: 22 } });
    await hr.zigbeeCommand('z2m:a4c1380000112233', { ota: 'update' });
    assert.deepEqual(mgmt.at(-1).body, { ieee: 'a4:c1:38:00:00:11:22:33', set: { ota: 'update' } });
    await assert.rejects(hr.zigbeeCommand('z2m:a4c1380000112233', { ota: 'update', bri: 5 }), (e) => e.code === 'invalid');
    assert.equal(mgmt.length, 3, 'a refused command never reaches the gateway');
    // back to the list the following tests expect
    await gwReq('post', '/radio/zigbee').send({ stack: 'zigbee2mqtt', devices: DEVICES.slice(0, 3) }).expect(200);
  });

  it('"Entfernen" goes to the gateway (checked address), audited', async () => {
    mgmt.length = 0;
    assert.equal((await admin('post', '/radio/zigbee/remove').send({ ieee: '../etc' })).status, 400);
    await admin('post', '/radio/zigbee/remove').send({ ieee: '00:0D:6F:FF:FE:1A:2B:3C' }).expect(200);
    assert.deepEqual(mgmt.at(-1), { peerId: gw.peer.id, path: '/api/radio/zigbee/remove', body: { ieee: '00:0d:6f:ff:fe:1a:2b:3c' } });
    answer = () => ({ status: 404, body: { error: 'not_found' } });
    assert.equal((await admin('post', '/radio/zigbee/remove').send({ ieee: '00:0d:6f:ff:fe:1a:2b:3c' })).status, 404);
    answer = () => ({ status: 202, body: { accepted: true } });
    const act = db.prepare("SELECT * FROM activity_log WHERE event_type = 'gateway_zigbee_device_removed'").all();
    assert.ok(act.length >= 1);
  });

  it('gc.radio.zigbee() and gc.radio.command() in a plugin process', async () => {
    const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(radioPackage());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
    const call = async (p, body = {}) => (await agent.post('/api/v1/plugins/radio-demo/api' + p).set('X-CSRF-Token', csrf).send(body).expect(200)).body;
    let has = null;
    for (let i = 0; i < 50 && !has; i++) { try { has = await call('/has'); } catch { await new Promise((res) => setTimeout(res, 100)); } }
    const z = await call('/zigbee');
    assert.equal(z.ok, true, JSON.stringify(z));
    assert.deepEqual(z.result.gateways.map((g) => g.name), ['Pi Keller']);
    assert.deepEqual(z.result.devices.map((d) => [d.id, d.kind, d.name]), [
      ['z2m:00158d0001a2b3c4', 'sensor', 'Bad Klima'], ['z2m:000d6ffffe1a2b3c', 'plug', 'Steckdose Kaffee'], ['z2m:001788010b2c3d4e', 'light', 'Wohnzimmer/Decke']]);
    assert.equal(z.result.devices[0].battery, 100);
    mgmt.length = 0;
    const ok = await call('/command', { id: 'z2m:001788010b2c3d4e', set: { on: true, bri: 40, junk: 1 } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(mgmt.at(-1).body, { ieee: '00:17:88:01:0b:2c:3d:4e', set: { on: true, bri: 40 } });
    assert.equal((await call('/command', { id: 'z2m:001788010b2c3d4e', set: { bri: 900 } })).code, 'ERR_INVALID');
    assert.equal((await call('/command', { id: 'z2m:ffffffffffffffff', set: { on: true } })).code, 'ERR_NOT_FOUND');
    answer = () => ({ status: 409, body: { error: 'not_running' } });
    assert.equal((await call('/command', { id: 'z2m:001788010b2c3d4e', set: { on: false } })).code, 'ERR_RADIO_NOT_RUNNING');
    answer = () => ({ status: 202, body: { accepted: true } });
    // back to deCONZ: the plugin no longer gets these devices
    await admin('put', '/features').send({ radio: { stack: 'deconz' } }).expect(200);
    assert.deepEqual((await call('/zigbee')).result, { gateways: [], devices: [] });
    assert.equal((await call('/command', { id: 'z2m:001788010b2c3d4e', set: { on: true } })).code, 'ERR_NOT_FOUND');
    await admin('put', '/features').send({ radio: { stack: 'zigbee2mqtt' } }).expect(200);
  });
});

describe('Thread border router', () => {
  it('form (name checked), join (dataset checked, passed through, not stored), dataset on request (audited)', async () => {
    mgmt.length = 0;
    assert.equal((await admin('post', '/radio/thread/form').send({ name: 'x'.repeat(20) })).status, 400);
    await admin('post', '/radio/thread/form').send({ name: 'Haus' }).expect(200);
    assert.deepEqual(mgmt.at(-1).body, { name: 'Haus' });
    answer = () => ({ status: 409, body: { error: 'has_network' } });
    const r = await admin('post', '/radio/thread/form').send({});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'has_network');
    answer = () => ({ status: 202, body: { accepted: true } });
    assert.equal((await admin('post', '/radio/thread/join').send({ dataset: 'not hex' })).status, 400);
    const tlv = '0E080000000000010000000300000F35060004001FFFE0';
    await admin('post', '/radio/thread/join').send({ dataset: tlv }).expect(200);
    assert.deepEqual(mgmt.at(-1).body, { dataset: tlv.toLowerCase() });
    answer = (p) => (p === '/api/radio/thread/dataset' ? { status: 200, body: { dataset: '0e08000000000001000000030000193506' } } : { status: 202, body: {} });
    const d = (await admin('post', '/radio/thread/dataset').send({}).expect(200)).body;
    assert.equal(d.dataset, '0e08000000000001000000030000193506');
    answer = () => ({ status: 202, body: { accepted: true } });
    const logs = JSON.stringify(db.prepare("SELECT * FROM activity_log WHERE event_type LIKE 'gateway_thread_%'").all());
    assert.match(logs, /gateway_thread_dataset_shown/);
    assert.doesNotMatch(logs, /0e0800000000000100000003/, 'the dataset never goes into the activity log');
  });

  it('an older gateway (1.31.0, without radio-stacks): Thread refused with gateway_unsupported', async () => {
    const r = await admin('post', '/radio/thread/form', old).send({});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'gateway_unsupported');
    const v = (await admin('get', '/radio', old).expect(200)).body.radio;
    assert.equal(v.stacksSupported, false);
    assert.equal(v.lastWithoutStacks, '1.31.0');
  });
});

describe('keys of encrypted Bluetooth sensors', () => {
  const MAC = '54:48:E6:8F:80:A5';
  const BIND = '231d39c1d7cc1ab1aee224cd096db932';
  it('stored encrypted, the config pull names only the stand, the gateway gets them from /radio/ble/keys', async () => {
    await gwReq('post', '/radio/ble').send({ sensors: [{ mac: MAC, format: 'bthome', encrypted: true, keyState: 'no_key', values: {}, seenAt: new Date().toISOString(), firstSeen: new Date().toISOString() }] }).expect(200);
    let s = (await admin('get', '/radio').expect(200)).body.radio.sensors.find((x) => x.mac === MAC);
    assert.deepEqual({ hasKey: s.hasKey, keyState: s.keyState }, { hasKey: false, keyState: 'no_key' });
    assert.equal((await admin('put', '/radio/sensors/' + encodeURIComponent(MAC)).send({ key: 'abc' })).status, 400);
    assert.equal((await admin('put', '/radio/sensors/' + encodeURIComponent(MAC)).send({ key: 42 })).status, 400);
    s = (await admin('put', '/radio/sensors/' + encodeURIComponent(MAC)).send({ key: BIND.toUpperCase().match(/../g).join(':'), accepted: true }).expect(200)).body.sensor;
    assert.equal(s.hasKey, true);
    assert.doesNotMatch(JSON.stringify(s), new RegExp(BIND, 'i'), 'never back to the page');
    const row = db.prepare('SELECT key_enc FROM gateway_ble_sensors WHERE mac = ?').get(MAC);
    assert.ok(row.key_enc && !row.key_enc.includes(BIND), 'stored encrypted');
    const c = (await gwReq('get', '/config').expect(200)).body;
    assert.match(c.features.radio.bleKeys, /^[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(c), new RegExp(BIND, 'i'), 'never in the config pull');
    const k = await gwReq('get', '/radio/ble/keys').expect(200);
    assert.equal(k.headers['cache-control'], 'no-store');
    assert.deepEqual(k.body, { rev: c.features.radio.bleKeys, keys: { [MAC]: BIND } });
    assert.deepEqual((await gwReq('get', '/radio/ble/keys', old).expect(200)).body.keys, {}, 'only its own sensors');
    const v = (await admin('get', '/radio').expect(200)).body;
    assert.doesNotMatch(JSON.stringify(v), new RegExp(BIND, 'i'));
    const logs = JSON.stringify(db.prepare("SELECT * FROM activity_log WHERE event_type LIKE 'gateway_ble_sensor_key%'").all());
    assert.match(logs, /gateway_ble_sensor_key_set/);
    assert.doesNotMatch(logs, new RegExp(BIND, 'i'));
    // the report names the state of the key
    await gwReq('post', '/radio/ble').send({ sensors: [{ mac: MAC, format: 'bthome', encrypted: true, keyState: 'ok', values: { temperature: 25.06, humidity: 50.55 }, seenAt: new Date().toISOString() }] }).expect(200);
    s = (await admin('get', '/radio').expect(200)).body.radio.sensors.find((x) => x.mac === MAC);
    assert.deepEqual({ keyState: s.keyState, t: s.values.temperature }, { keyState: 'ok', t: 25.06 });
    // removed → no stand any more
    await admin('put', '/radio/sensors/' + encodeURIComponent(MAC)).send({ key: null }).expect(200);
    assert.equal((await gwReq('get', '/config').expect(200)).body.features.radio.bleKeys, undefined);
    assert.deepEqual((await gwReq('get', '/radio/ble/keys').expect(200)).body, { rev: null, keys: {} });
  });
});

describe('gateway-radio-kit: stack hints', () => {
  const K = require('../public/js/gateway-radio-kit');
  it('which stack fits a stick; one stick one radio; small Pi; firmware', () => {
    assert.equal(K.stackFor({ deconz: true, z2m: 'deconz' }), 'deconz');
    assert.equal(K.stackFor({ deconz: false, z2m: 'ember', thread: true }), 'zigbee2mqtt');
    assert.equal(K.stackFor({ deconz: false, z2m: null, thread: true, kind: 'thread' }), 'thread');
    assert.equal(K.stackFor({ kind: 'bluetooth' }), null);
    assert.deepEqual(K.stickHint({ deconz: false, z2m: 'ember', thread: true }, 'deconz').key, 'gwr.stick.hint.use_z2m');
    assert.equal(K.stickHint({ deconz: true, z2m: 'deconz' }, 'deconz'), null);
    assert.equal(K.smallBoard({ memTotal: 1024 ** 3, model: 'Raspberry Pi 3 Model B Plus' }), true);
    assert.equal(K.smallBoard({ memTotal: 512 * 1024 ** 2, model: 'Raspberry Pi Zero 2 W' }), true);
    assert.equal(K.smallBoard({ memTotal: 4 * 1024 ** 3, model: 'Raspberry Pi 4' }), false);
    assert.equal(K.threadTone('running'), 'green');
    assert.equal(K.threadTone('stick_busy'), 'amber');
    assert.equal(K.matterReady({ state: 'running', forwarding: true }), true);
    assert.equal(K.matterReady({ state: 'running', forwarding: false }), false);
    assert.equal(K.keyTone('wrong_key'), 'red');
    assert.equal(K.validKey('23:1D:39:C1:D7:CC:1A:B1:AE:E2:24:CD:09:6D:B9:32'), true);
    assert.equal(K.validKey('xyz'), false);
    assert.equal(K.smarthomeLink('zigbee', '00:17:88:01:0b:2c:3d:4e'), '/plugins/gatecontrol-smarthome?focus=zigbee%3A00%3A17%3A88%3A01%3A0b%3A2c%3A3d%3A4e');
  });
});

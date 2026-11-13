'use strict';

// "VPN-Namen im Heimnetz auflösen" (stage 3 of "Namen im VPN"): the zones of
// the device names reach the gateways in `features.internal_dns` of the config
// pull (part of the config hash, no new hash package needed), with the switch
// of each gateway; a change of the zones tells every gateway to pull.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const supertest = require('supertest');

const { setup, teardown, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-vpn-names-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('gateway: VPN names in the home network', () => {
  let app; let agent; let csrf; let db; let gw; let gw2; let gateways; let features; let vpnNames; let config; let dns;
  let pushed = [];
  let realRestart; let realNotify; let dnsWasEnabled;

  const gwReq = (method, p, token = gw.apiToken) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + token);
  const admin = (method, p, id = gw.peer.id) => agent[method]('/api/v1/gateways/' + id + p).set('X-CSRF-Token', csrf);
  const pull = async (token) => (await gwReq('get', '/config', token).expect(200)).body;

  before(async () => {
    ({ app, agent } = await setup());
    csrf = getCsrf();
    db = require('../src/db/connection').getDb();
    config = require('../config/default');
    dnsWasEnabled = config.dns.enabled;
    require('../src/services/license')._overrideForTest({ gateway_peers: 10, internal_dns: true, vpn_peers: -1, http_routes: -1, l4_routes: -1 });
    gateways = require('../src/services/gateways');
    features = require('../src/services/gatewayFeatures');
    vpnNames = require('../src/services/vpnNames');
    dns = require('../src/services/dns');
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    realRestart = dns.restartDnsmasq;
    dns.restartDnsmasq = () => {};
    // no real gateway behind the tunnel addresses: the pushes are counted here
    realNotify = gateways.notifyConfigChanged;
    gateways.notifyConfigChanged = async (id) => { pushed.push(id); };
    gw = await gateways.createGateway({ name: 'Pi Keller' });
    gw2 = await gateways.createGateway({ name: 'Pi Garage' });
  });

  after(() => {
    dns.restartDnsmasq = realRestart;
    gateways.notifyConfigChanged = realNotify;
    config.dns.enabled = dnsWasEnabled;
    teardown();
  });

  beforeEach(() => {
    config.dns.enabled = true;
    db.prepare('DELETE FROM domains').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%'").run();
    db.prepare('DELETE FROM gateway_features').run();
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'no-resolv\nlocal=/gc.internal/\n');
    pushed = [];
  });

  it('default: the zones are sent, the switch is off', async () => {
    assert.deepEqual(features.get(gw.peer.id).vpnNames, { enabled: false });
    const r = await pull();
    assert.deepEqual(r.features.internal_dns, {
      server: config.wireguard.gatewayIp, domains: [config.dns.domain], primary: config.dns.domain, resolve: false,
    });
    assert.equal(r.config_hash, gateways.computeConfigHash(gw.peer.id));
    await gwReq('get', '/config/check?hash=' + encodeURIComponent(r.config_hash)).expect(304);
  });

  it('the switch is per gateway and changes the hash of that gateway only', async () => {
    const h1 = gateways.computeConfigHash(gw.peer.id);
    const h2 = gateways.computeConfigHash(gw2.peer.id);
    const o = (await admin('put', '/features').send({ vpnNames: { enabled: true } }).expect(200)).body.gateway;
    assert.deepEqual(o.features.vpnNames, { enabled: true });
    assert.equal((await pull()).features.internal_dns.resolve, true);
    assert.equal((await pull(gw2.apiToken)).features.internal_dns.resolve, false);
    assert.notEqual(gateways.computeConfigHash(gw.peer.id), h1);
    assert.equal(gateways.computeConfigHash(gw2.peer.id), h2);
    assert.deepEqual(pushed, [gw.peer.id], 'only this gateway is told to pull');
    await gwReq('get', '/config/check?hash=' + encodeURIComponent(h1)).expect(200);
    // off again
    await admin('put', '/features').send({ vpnNames: { enabled: false } }).expect(200);
    assert.equal(gateways.computeConfigHash(gw.peer.id), h1);
  });

  it('only a real true or false; unknown fields are refused', async () => {
    for (const bad of [{ vpnNames: { enabled: 'yes' } }, { vpnNames: { enabled: 1 } }, { vpnNames: { resolve: true } }, { vpnNames: true }, { vpnNames: { server: '9.9.9.9' } }]) {
      const r = await admin('put', '/features').send(bad).expect(400);
      assert.equal(r.body.code, 'invalid', JSON.stringify(bad));
    }
    assert.deepEqual(features.get(gw.peer.id).vpnNames, { enabled: false });
    assert.deepEqual(features.normalize({ vpnNames: { enabled: 'true' } }).vpnNames, { enabled: false });
    assert.deepEqual(features.normalize({ vpnNames: 7 }).vpnNames, { enabled: false });
  });

  it('a change of the zone reaches every gateway: new hash, both told to pull', async () => {
    await admin('put', '/features').send({ vpnNames: { enabled: true } }).expect(200);
    const before1 = gateways.computeConfigHash(gw.peer.id);
    const before2 = gateways.computeConfigHash(gw2.peer.id);
    pushed = [];
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
    assert.deepEqual(pushed.slice().sort((a, b) => a - b), [gw.peer.id, gw2.peer.id].sort((a, b) => a - b));
    assert.deepEqual((await pull()).features.internal_dns, {
      server: config.wireguard.gatewayIp, domains: ['vpn.example.com', config.dns.domain], primary: 'vpn.example.com', resolve: true,
    });
    assert.deepEqual((await pull(gw2.apiToken)).features.internal_dns.domains, ['vpn.example.com', config.dns.domain]);
    assert.notEqual(gateways.computeConfigHash(gw.peer.id), before1);
    assert.notEqual(gateways.computeConfigHash(gw2.peer.id), before2);
    // back to the legacy zone alone
    pushed = [];
    assert.equal(vpnNames.save('', '').ok, true);
    assert.equal(pushed.length, 2);
    assert.deepEqual((await pull()).features.internal_dns.domains, [config.dns.domain]);
    assert.equal(gateways.computeConfigHash(gw.peer.id), before1);
  });

  it('a choice that is refused tells nobody', () => {
    assert.equal(vpnNames.save('not-entered.example', 'vpn').ok, false);
    assert.deepEqual(pushed, []);
  });

  it('name service off (GC_DNS_ENABLED=false): no zones, the overview says so', async () => {
    config.dns.enabled = false;
    assert.equal((await pull()).features.internal_dns, null);
    const o = (await admin('get', '/features').expect(200)).body.gateway;
    assert.deepEqual(o.vpnNames, { available: false, zones: [], primary: null });
    // a hint, never a ban: the switch can still be set
    await admin('put', '/features').send({ vpnNames: { enabled: true } }).expect(200);
    assert.equal((await pull()).features.internal_dns, null);
  });

  it('the overview: zones for the row, the gateway knows the function only by its capability', async () => {
    const o = (await admin('get', '/features').expect(200)).body.gateway;
    assert.deepEqual(o.vpnNames, { available: true, zones: [config.dns.domain], primary: config.dns.domain });
    assert.equal(o.support.vpnNames, false, 'a gateway that has not reported the capability');
    assert.equal(features.support({ gateway_version: '9.9.9' }).vpnNames, false, 'never by the version');
    assert.equal(features.support({ capabilities: ['dns'] }).vpnNames, false);
    assert.equal(features.support({ capabilities: ['dns', 'dns-vpn-names'] }).vpnNames, true);
  });

  it('the change is written to the activity log', async () => {
    await admin('put', '/features').send({ vpnNames: { enabled: true } }).expect(200);
    const row = db.prepare("SELECT details FROM activity_log WHERE event_type = 'gateway_features_changed' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(row.details).changed, ['vpnNames']);
  });

  it('needs an admin session and the CSRF token', async () => {
    await supertest(app).put('/api/v1/gateways/' + gw.peer.id + '/features').send({ vpnNames: { enabled: true } }).expect((r) => assert.ok([401, 403].includes(r.status)));
    await agent.put('/api/v1/gateways/' + gw.peer.id + '/features').send({ vpnNames: { enabled: true } }).expect(403);
    assert.deepEqual(features.get(gw.peer.id).vpnNames, { enabled: false });
  });
});

describe('gateway: VPN names in the home network — the row of the tab "Funktionen"', () => {
  const net = read('public/js/gateway-net.js');
  const de = JSON.parse(read('src/i18n/de.json'));
  const en = JSON.parse(read('src/i18n/en.json'));
  const KEYS = ['gwn.feat.vpnnames', 'gwn.feat.vpnnames_d', 'gwn.feat.vpnnames_on', 'gwn.feat.vpnnames_off', 'gwn.feat.vpnnames_example',
    'gwn.feat.vpnnames_nodns', 'gwn.feat.vpnnames_old', 'gwn.feat.vpnnames_unknown', 'gwn.feat.vpnnames_noservice'];

  it('every text of the row exists in German and English', () => {
    const used = [...new Set([...net.matchAll(/'(gwn\.feat\.vpnnames[a-z_]*)'/g)].map((m) => m[1]))].sort();
    assert.deepEqual(used, KEYS.slice().sort());
    for (const k of KEYS) {
      assert.equal(typeof de[k], 'string', 'de ' + k);
      assert.equal(typeof en[k], 'string', 'en ' + k);
      assert.notEqual(de[k], en[k], k);
    }
    assert.equal(de['gwn.feat.vpnnames'], 'VPN-Namen im Heimnetz auflösen');
    assert.equal(en['gwn.feat.vpnnames'], 'Resolve VPN names in the home network');
  });

  it('hints, never a ban: the switch is never created disabled', () => {
    const lines = net.split('\n');
    const start = lines.indexOf('  function vpnNamesRow(id, d) {');
    assert.notEqual(start, -1);
    const end = lines.indexOf('  }', start);
    const body = lines.slice(start, end + 1);
    const sw = body.filter((l) => l.includes('U.switchBtn('));
    assert.deepEqual(sw, ["    const sw = U.switchBtn(!!f.vpnNames.enabled, name, 'gwn-f-vpnnames',"]);
    // the call ends after the handler: no fifth argument (disabled)
    assert.equal(body[body.indexOf(sw[0]) + 1], "      () => toggle(sw, id, (on) => ({ vpnNames: { enabled: on } }), (on) => t(on ? 'gwn.feat.on_done' : 'gwn.feat.off_done', { name })));");
    for (const attr of ['data-vpnnames-noservice', 'data-vpnnames-old', 'data-vpnnames-nodns', 'data-vpnnames-zone']) {
      assert.equal(body.filter((l) => l.includes(`'${attr}'`)).length, 1, attr);
    }
    assert.equal(body.some((l) => l.includes('innerHTML')), false);
  });

  it('the row belongs to the group "System" and has its chapter in both handbooks', () => {
    const PK = require('../public/js/gateway-pool-kit');
    assert.equal(PK.groupOf('vpnnames'), 'system');
    const guide = require('../public/js/handbook');
    assert.deepEqual(guide.TOPICS['feat.vpnnames'], { de: '05-funktionen.md#vpn-namen-im-heimnetz', en: '05-features.md#vpn-names-in-the-home-network' });
    assert.equal(read('docs/handbuch/05-funktionen.md').split('\n').filter((l) => l === '## VPN-Namen im Heimnetz').length, 1);
    assert.equal(read('docs/guide/05-features.md').split('\n').filter((l) => l === '## VPN names in the home network').length, 1);
  });
});

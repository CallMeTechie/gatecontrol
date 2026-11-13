'use strict';

// "VPN-Namen im Heimnetz auflösen" (stage 3 of "Namen im VPN"): the zones of
// the device names reach the gateways in `features.internal_dns` of the config
// pull (part of the config hash, no new hash package needed), with the switch
// of their home network (one value for every gateway of it, kept with the DNS
// filter settings); a change of the zones tells every gateway to pull. What a
// gateway reports about the forwarding (telemetry dns.vpnNames) becomes a hint.

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
  let app; let agent; let csrf; let db; let gw; let gw2; let gw3; let gateways; let features; let vpnNames; let config; let dns;
  let pushed = [];
  let realRestart; let realNotify; let dnsWasEnabled;

  const gwReq = (method, p, token = gw.apiToken) => supertest(app)[method]('/api/v1/gateway' + p).set('Authorization', 'Bearer ' + token);
  const admin = (method, p, id = gw.peer.id) => agent[method]('/api/v1/gateways/' + id + p).set('X-CSRF-Token', csrf);
  const pull = async (token) => (await gwReq('get', '/config', token).expect(200)).body;
  const sorted = (a) => a.slice().sort((x, y) => x - y);
  // what the gateway sends (gateway src/dns/dns.js telemetry().vpnNames), with the capability
  const names = (over) => ({ zones: ['gc.internal'], primary: 'gc.internal', forward: true, routed: true, lastOkAt: null, lastError: null, failures: 0, down: false, ...over });
  const beat = (g, vpn, caps = ['dns', 'dns-vpn-names']) => gwReq('post', '/heartbeat', g.apiToken).send({
    http_proxy_healthy: true, tcp_listeners: [], wg_handshake_age_s: 5, uptime_s: 60, hostname: 'pi',
    telemetry: { gateway_version: '1.40.0', capabilities: caps, dns: vpn === undefined ? null : { state: 'running', vpnNames: vpn } },
  }).expect(200);
  const row = async (g = gw) => (await admin('get', '/features', g.peer.id).expect(200)).body.gateway.vpnNames;

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
    gw3 = await gateways.createGateway({ name: 'Pi Buero' });
    // "Pi Keller" and "Pi Garage" are one home network (a failover pool), "Pi Buero" is another
    const pool = require('../src/services/gatewayPool');
    const poolId = pool.createPool({ name: 'Zuhause', mode: 'failover', failback_cooldown_s: 0 });
    pool.addMember(poolId, gw.peer.id, 10);
    pool.addMember(poolId, gw2.peer.id, 20);
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
    db.prepare('DELETE FROM gateway_dns').run();
    db.prepare('UPDATE gateway_meta SET last_health = NULL, last_seen_at = NULL').run();
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'no-resolv\nlocal=/gc.internal/\n');
    pushed = [];
  });

  it('default: the zones are sent, the switch is off', async () => {
    assert.equal(require('../src/services/homeDns').get(gw.peer.id).vpnNames, false);
    const r = await pull();
    assert.deepEqual(r.features.internal_dns, {
      server: config.wireguard.gatewayIp, domains: [config.dns.domain], primary: config.dns.domain, resolve: false,
    });
    assert.equal(r.config_hash, gateways.computeConfigHash(gw.peer.id));
    await gwReq('get', '/config/check?hash=' + encodeURIComponent(r.config_hash)).expect(304);
  });

  it('one switch for the home network: switched on once, both gateways resolve — the other home network stays off', async () => {
    const h1 = gateways.computeConfigHash(gw.peer.id);
    const h2 = gateways.computeConfigHash(gw2.peer.id);
    const h3 = gateways.computeConfigHash(gw3.peer.id);
    const set = (await admin('put', '/dns').send({ vpnNames: true }).expect(200)).body.settings;
    assert.equal(set.vpnNames, true);
    assert.equal((await pull()).features.internal_dns.resolve, true);
    assert.equal((await pull(gw2.apiToken)).features.internal_dns.resolve, true, 'the failover gateway of the same home network');
    assert.equal((await pull(gw3.apiToken)).features.internal_dns.resolve, false, 'a gateway of another home network');
    assert.notEqual(gateways.computeConfigHash(gw.peer.id), h1);
    assert.notEqual(gateways.computeConfigHash(gw2.peer.id), h2);
    assert.equal(gateways.computeConfigHash(gw3.peer.id), h3);
    assert.deepEqual(sorted(pushed), sorted([gw.peer.id, gw2.peer.id]), 'every gateway of the home network is told to pull, nobody else');
    await gwReq('get', '/config/check?hash=' + encodeURIComponent(h1)).expect(200);
    assert.equal((await row()).enabled, true);
    assert.equal((await row(gw2)).enabled, true, 'the row of the other gateway shows the same switch');
    assert.equal((await row(gw3)).enabled, false);
    // off again — at the other gateway of the home network
    pushed = [];
    await admin('put', '/dns', gw2.peer.id).send({ vpnNames: false }).expect(200);
    assert.equal((await pull()).features.internal_dns.resolve, false);
    assert.equal(gateways.computeConfigHash(gw.peer.id), h1);
    assert.equal(gateways.computeConfigHash(gw2.peer.id), h2);
    assert.deepEqual(sorted(pushed), sorted([gw.peer.id, gw2.peer.id]));
  });

  it('a gateway without a pool is a home network of one', async () => {
    await admin('put', '/dns', gw3.peer.id).send({ vpnNames: true }).expect(200);
    assert.deepEqual(pushed, [gw3.peer.id]);
    assert.equal((await pull(gw3.apiToken)).features.internal_dns.resolve, true);
    assert.equal((await pull()).features.internal_dns.resolve, false);
    assert.equal((await pull(gw2.apiToken)).features.internal_dns.resolve, false);
    assert.deepEqual((await row(gw3)).gateways.map((x) => x.id), [gw3.peer.id]);
  });

  it('gateways that differ are aligned: the value changed last holds for the home network', async () => {
    const hd = require('../src/services/homeDns');
    await admin('put', '/dns').send({ vpnNames: true }).expect(200);
    db.prepare('DELETE FROM gateway_dns WHERE peer_id = ?').run(gw2.peer.id); // e.g. it joined the pool afterwards
    assert.equal((await pull(gw2.apiToken)).features.internal_dns.resolve, false);
    pushed = [];
    assert.equal(hd.reconcileHomes(), 1);
    assert.deepEqual(pushed, [gw2.peer.id]);
    assert.equal((await pull(gw2.apiToken)).features.internal_dns.resolve, true);
  });

  it('only a real true or false; the switch is no longer a setting of the single gateway', async () => {
    for (const bad of [{ vpnNames: 'yes' }, { vpnNames: 1 }, { vpnNames: { enabled: true } }, { vpnNames: null }]) {
      const r = await admin('put', '/dns').send(bad).expect(400);
      assert.equal(r.body.code, 'invalid', JSON.stringify(bad));
    }
    assert.equal(require('../src/services/homeDns').normalize({ vpnNames: 'true' }).vpnNames, false);
    assert.equal((await pull()).features.internal_dns.resolve, false);
    // PUT …/features knows no vpnNames: nothing to change
    await admin('put', '/features').send({ vpnNames: { enabled: true } }).expect(400);
    assert.equal('vpnNames' in features.get(gw.peer.id), false);
    assert.equal('vpnNames' in features.normalize({ vpnNames: { enabled: true } }), false);
    assert.equal((await pull()).features.internal_dns.resolve, false);
  });

  it('a change of the zone reaches every gateway: new hash, both told to pull', async () => {
    await admin('put', '/dns').send({ vpnNames: true }).expect(200);
    const before1 = gateways.computeConfigHash(gw.peer.id);
    const before2 = gateways.computeConfigHash(gw2.peer.id);
    pushed = [];
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
    assert.deepEqual(sorted(pushed), sorted([gw.peer.id, gw2.peer.id, gw3.peer.id]));
    assert.deepEqual((await pull()).features.internal_dns, {
      server: config.wireguard.gatewayIp, domains: ['vpn.example.com', config.dns.domain], primary: 'vpn.example.com', resolve: true,
    });
    assert.deepEqual((await pull(gw2.apiToken)).features.internal_dns.domains, ['vpn.example.com', config.dns.domain]);
    assert.notEqual(gateways.computeConfigHash(gw.peer.id), before1);
    assert.notEqual(gateways.computeConfigHash(gw2.peer.id), before2);
    // back to the legacy zone alone
    pushed = [];
    assert.equal(vpnNames.save('', '').ok, true);
    assert.equal(pushed.length, 3);
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
    assert.deepEqual(o.vpnNames, { available: false, enabled: false, zones: [], primary: null, gateways: [] });
    // a hint, never a ban: the switch can still be set
    await admin('put', '/dns').send({ vpnNames: true }).expect(200);
    assert.equal((await pull()).features.internal_dns, null);
  });

  it('the overview: zones for the row, the gateway knows the function only by its capability', async () => {
    const o = (await admin('get', '/features').expect(200)).body.gateway;
    assert.deepEqual(o.vpnNames, {
      available: true, enabled: false, zones: [config.dns.domain], primary: config.dns.domain,
      gateways: [
        { id: gw.peer.id, name: 'Pi Keller', self: true, supported: false, version: null, problem: null },
        { id: gw2.peer.id, name: 'Pi Garage', self: false, supported: false, version: null, problem: null },
      ],
    });
    assert.equal(o.support.vpnNames, false, 'a gateway that has not reported the capability');
    // seen from the other gateway of the home network: itself first
    assert.deepEqual((await row(gw2)).gateways.map((x) => [x.id, x.self]), [[gw2.peer.id, true], [gw.peer.id, false]]);
    assert.equal(features.support({ gateway_version: '9.9.9' }).vpnNames, false, 'never by the version');
    assert.equal(features.support({ capabilities: ['dns'] }).vpnNames, false);
    assert.equal(features.support({ capabilities: ['dns', 'dns-vpn-names'] }).vpnNames, true);
  });

  it('the change is written to the activity log, with the home network', async () => {
    await admin('put', '/dns').send({ vpnNames: true }).expect(200);
    const r = db.prepare("SELECT details FROM activity_log WHERE event_type = 'gateway_dns_changed' ORDER BY id DESC LIMIT 1").get();
    const d = JSON.parse(r.details);
    assert.deepEqual(d.changed, ['vpnNames']);
    assert.deepEqual(d.home_peer_ids, sorted([gw.peer.id, gw2.peer.id]));
  });

  it('needs an admin session and the CSRF token', async () => {
    await supertest(app).put('/api/v1/gateways/' + gw.peer.id + '/dns').send({ vpnNames: true }).expect((r) => assert.ok([401, 403].includes(r.status)));
    await agent.put('/api/v1/gateways/' + gw.peer.id + '/dns').send({ vpnNames: true }).expect(403);
    assert.equal((await pull()).features.internal_dns.resolve, false);
  });

  // ── what the gateway reports about the forwarding → the hint at the switch ──
  it('the report of the gateway: no hint while it forwards and the server answers', async () => {
    await admin('put', '/dns').send({ vpnNames: true }).expect(200);
    await beat(gw, names({ lastOkAt: Date.now() }));
    const v = await row();
    assert.deepEqual(v.gateways[0], { id: gw.peer.id, name: 'Pi Keller', self: true, supported: true, version: '1.40.0', problem: null });
  });

  it('the report of the gateway: the cases it tells apart', () => {
    const P = (over) => features.vpnNamesProblem({ dns: { vpnNames: names(over) } });
    assert.equal(P({}), null);
    // the address of the server is not behind the tunnel
    assert.deepEqual(P({ routed: false }), { kind: 'no_route' });
    assert.deepEqual(P({ routed: false, down: true, lastError: { at: 5, code: 'timeout' } }), { kind: 'no_route' }, 'the route comes first');
    // the gateway calls the way down (two failures in a row)
    assert.deepEqual(P({ down: true, failures: 2, lastError: { at: 5, code: 'timeout' } }), { kind: 'no_answer', reason: 'timeout', code: null });
    for (const code of ['udp', 'tcp', 'closed']) assert.deepEqual(P({ down: true, lastError: { at: 5, code } }), { kind: 'no_answer', reason: 'net', code: null });
    assert.deepEqual(P({ down: true, lastError: { at: 5, code: 'mismatch' } }), { kind: 'no_answer', reason: 'other', code: 'mismatch' });
    assert.deepEqual(P({ down: true }), { kind: 'no_answer', reason: null, code: null }, 'no reason named');
    // between two "down" windows: the last questions failed and nothing answered since
    assert.deepEqual(P({ failures: 4, lastOkAt: 100, lastError: { at: 200, code: 'timeout' } }), { kind: 'no_answer', reason: 'timeout', code: null });
    assert.deepEqual(P({ failures: 2, lastOkAt: null, lastError: { at: 200, code: 'timeout' } }), { kind: 'no_answer', reason: 'timeout', code: null });
    // a single lost question, or an answer after the last failure, is no fault
    assert.equal(P({ failures: 1, lastError: { at: 200, code: 'timeout' } }), null);
    assert.equal(P({ failures: 9, lastOkAt: 300, lastError: { at: 200, code: 'timeout' } }), null);
    // the gateway does not forward (yet), or has no zone to forward
    assert.equal(P({ forward: false, routed: false, down: true }), null);
    assert.equal(P({ zones: [], routed: false }), null);
    assert.equal(P({ zones: 'gc.internal', routed: false }), null);
  });

  it('the report of the gateway is input: checked, shortened, no control characters', () => {
    const P = (v) => features.vpnNamesProblem({ dns: { vpnNames: v } });
    for (const bad of [undefined, null, 7, 'x', [], [names({ routed: false })]]) assert.equal(P(bad), null, JSON.stringify(bad));
    for (const tel of [undefined, null, 7, {}, { dns: null }, { dns: [] }, { dns: 'x' }, { dns: {} }, { dns: { vpnNames: null } }]) assert.equal(features.vpnNamesProblem(tel), null);
    assert.equal(P(names({ routed: 'false' })), null, 'only a real false');
    assert.equal(P(names({ down: 'true' })), null, 'only a real true');
    assert.equal(P(names({ forward: 1, routed: false })), null);
    assert.equal(P(names({ failures: '5', lastError: { at: 200, code: 'timeout' } })), null);
    assert.equal(P(names({ failures: 5, lastError: { at: '200', code: 'timeout' } })), null);
    const long = P(names({ down: true, lastError: { at: 1, code: 'x'.repeat(500) } }));
    assert.equal(long.code, 'x'.repeat(60));
    assert.deepEqual(P(names({ down: true, lastError: { at: 1, code: ' a\u0000b\nc\u009b<b> ' } })), { kind: 'no_answer', reason: 'other', code: 'a b c <b>' });
    for (const code of [7, null, {}, ['timeout'], '', ' \n ']) assert.deepEqual(P(names({ down: true, lastError: { at: 1, code } })), { kind: 'no_answer', reason: null, code: null }, JSON.stringify(code));
    assert.deepEqual(P(names({ down: true, lastError: 'timeout' })), { kind: 'no_answer', reason: null, code: null });
  });

  it('the hint is shown per gateway of the home network — only switched on, reported and reachable', async () => {
    const down = names({ down: true, failures: 2, lastError: { at: Date.now(), code: 'timeout' } });
    await beat(gw, down);
    await beat(gw2, names({ routed: false }));
    assert.deepEqual((await row()).gateways.map((x) => x.problem), [null, null], 'switch off: no hint');
    await admin('put', '/dns').send({ vpnNames: true }).expect(200);
    assert.deepEqual((await row()).gateways.map((x) => [x.name, x.problem]), [
      ['Pi Keller', { kind: 'no_answer', reason: 'timeout', code: null }],
      ['Pi Garage', { kind: 'no_route' }],
    ]);
    // the DNS filter of the gateway is off: it reports nothing about the names
    await beat(gw, undefined);
    assert.equal((await row()).gateways[0].problem, null);
    // no report of the capability: the hint "kennt die Funktion noch nicht" stands instead
    await beat(gw, down, ['dns']);
    assert.deepEqual((await row()).gateways[0], { id: gw.peer.id, name: 'Pi Keller', self: true, supported: false, version: '1.40.0', problem: null });
    // offline (no heartbeat within the threshold): its last report says nothing about now
    await beat(gw, down);
    assert.notEqual((await row()).gateways[0].problem, null);
    db.prepare('UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = ?').run(Date.now() - 3600_000, gw.peer.id);
    const v = await row();
    assert.equal(v.gateways[0].problem, null);
    assert.deepEqual(v.gateways[1].problem, { kind: 'no_route' }, 'the other gateway is still reachable');
    // never heard of (no heartbeat at all)
    db.prepare('UPDATE gateway_meta SET last_health = NULL, last_seen_at = NULL WHERE peer_id = ?').run(gw2.peer.id);
    assert.deepEqual((await row()).gateways[1], { id: gw2.peer.id, name: 'Pi Garage', self: false, supported: false, version: null, problem: null });
  });
});

describe('gateway: VPN names in the home network — the row of the tab "Funktionen"', () => {
  const net = read('public/js/gateway-net.js');
  const de = JSON.parse(read('src/i18n/de.json'));
  const en = JSON.parse(read('src/i18n/en.json'));
  const KEYS = ['gwn.feat.vpnnames', 'gwn.feat.vpnnames_d', 'gwn.feat.vpnnames_on', 'gwn.feat.vpnnames_off', 'gwn.feat.vpnnames_example',
    'gwn.feat.vpnnames_nodns', 'gwn.feat.vpnnames_old', 'gwn.feat.vpnnames_unknown', 'gwn.feat.vpnnames_noservice',
    'gwn.feat.vpnnames_noanswer', 'gwn.feat.vpnnames_why_timeout', 'gwn.feat.vpnnames_why_net', 'gwn.feat.vpnnames_why_other', 'gwn.feat.vpnnames_noroute'];

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
    assert.equal(de['gwn.feat.vpnnames_noanswer'], 'Der Namensdienst des Servers antwortet diesem Gateway gerade nicht – VPN-Namen werden im Heimnetz nicht aufgelöst.');
    assert.equal(en['gwn.feat.vpnnames_noanswer'], 'The server’s name service is not answering this gateway right now – VPN names are not resolved in the home network.');
    for (const l of [de, en]) assert.equal(l['gwn.feat.vpnnames_why_other'].split('{{code}}').length, 2);
  });

  it('hints, never a ban: the switch is never created disabled, and it is the switch of the home network', () => {
    const lines = net.split('\n');
    const start = lines.indexOf('  function vpnNamesRow(id, d) {');
    assert.notEqual(start, -1);
    const end = lines.indexOf('  }', start);
    const body = lines.slice(start, end + 1);
    const sw = body.filter((l) => l.includes('U.switchBtn('));
    // three arguments and the handler: no fifth argument (disabled)
    assert.deepEqual(sw, ["    const sw = U.switchBtn(!!v.enabled, name, 'gwn-f-vpnnames', () => {"]);
    assert.equal(body.filter((l) => l === '    });').length, 1, 'the call ends after the handler');
    // stored with the DNS filter settings, which every gateway of the home network shares
    assert.equal(body.filter((l) => l.includes("U.api('PUT', url(id, '/dns'), { vpnNames: next })")).length, 1);
    assert.equal(body.some((l) => l.includes('putFeatures')), false);
    for (const attr of ['data-vpnnames-noservice', 'data-vpnnames-old', 'data-vpnnames-nodns', 'data-vpnnames-problem', 'data-vpnnames-zone']) {
      assert.equal(body.filter((l) => l.includes(`'${attr}'`)).length, 1, attr);
    }
    // the fault is a warning, shown only while the switch is on; what the gateway named goes in as text
    assert.equal(body.filter((l) => l.includes('else if (v.enabled) v.gateways.filter((x) => x.problem)')).length, 1);
    assert.equal(body.some((l) => l.includes('innerHTML')), false);
  });

  it('the row belongs to the group "Für das ganze Heimnetz" and has its chapter in both handbooks', () => {
    const PK = require('../public/js/gateway-pool-kit');
    assert.equal(PK.groupOf('vpnnames'), 'wide');
    const guide = require('../public/js/handbook');
    assert.deepEqual(guide.TOPICS['feat.vpnnames'], { de: '05-funktionen.md#vpn-namen-im-heimnetz', en: '05-features.md#vpn-names-in-the-home-network' });
    assert.equal(read('docs/handbuch/05-funktionen.md').split('\n').filter((l) => l === '## VPN-Namen im Heimnetz').length, 1);
    assert.equal(read('docs/guide/05-features.md').split('\n').filter((l) => l === '## VPN names in the home network').length, 1);
  });
});

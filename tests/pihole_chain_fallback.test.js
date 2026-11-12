'use strict';
// The managed DNS chain end to end inside the server: real conf file, real
// piholeDnsChain, real DNS probe against a local UDP resolver — only the
// dnsmasq restart itself is counted instead of executed.
const crypto = require('crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pihole-chain-'));
const confPath = path.join(confDir, 'dnsmasq.conf');
process.env.GC_DNSMASQ_CONF = confPath;
process.env.GC_DNSMASQ_UPSTREAMS = '1.1.1.1,8.8.8.8';
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const license = require('../src/services/license');

let restarts = 0;
const dns = require('../src/services/dns');
dns.restartDnsmasq = () => { restarts++; };
const pihole = require('../src/services/pihole');
const piholeConfig = require('../src/services/piholeConfig');
const { getDb } = require('../src/db/connection');

let agent, sock, port;

function listen(p) {
  const s = dgram.createSocket('udp4');
  s.on('message', (msg, rinfo) => {
    const hdr = Buffer.from(msg.subarray(0, 12));
    hdr[2] = 0x81; hdr[3] = 0x80;
    hdr.writeUInt16BE(1, 6); hdr.writeUInt16BE(0, 8); hdr.writeUInt16BE(0, 10);
    s.send(Buffer.concat([hdr, msg.subarray(12, 17), Buffer.from([0x00, 0, 2, 0, 1, 0, 0, 0, 60, 0, 3, 1, 0x61, 0])]), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => s.bind(p, '127.0.0.1', () => resolve(s)));
}
const close = (s) => new Promise((resolve) => s.close(resolve));
const servers = () => fs.readFileSync(confPath, 'utf8').match(/^server=.*/gm);
const ticks = async (n) => { for (let i = 0; i < n; i++) await pihole._dnsWatch.tick(); };

beforeEach(async () => {
  await setup(); agent = getAgent();
  license._overrideForTest({ pihole_integration: true });
  sock = await listen(0); port = sock.address().port;
  restarts = 0;
});
afterEach(async () => {
  piholeConfig.save({ enabled: false, instances: [] });
  await ticks(1); // back to 'off' for the next test (the module is shared)
  try { await close(sock); } catch { /* already closed */ }
  await teardown();
});

test('Pi-hole DNS goes away and comes back: fallback to the defaults, visible, and back again', async () => {
  // as entrypoint.sh leaves it after a container start: chain without managed block
  fs.writeFileSync(confPath, `bind-dynamic\nno-resolv\nadd-subnet=32,128\nserver=127.0.0.1#${port}\n`);
  piholeConfig.save({ enabled: true, manage_dns_chain: true, sync_interval_sec: 3600,
    instances: [{ id: 'p1', label: 'Pi-hole DS918+', url: 'http://127.0.0.1:1', dns_ip: '127.0.0.1', dns_port: port }] });

  pihole.applyDnsChain();
  await ticks(2);
  assert.equal(pihole.getStatus().dnsChain.state, 'pihole');
  assert.deepEqual(servers(), [`server=127.0.0.1#${port}`]);
  assert.equal(restarts, 0, 'boot with a healthy Pi-hole: no dnsmasq restart');

  // the gateway container is switched off
  await close(sock);
  await ticks(1);
  assert.deepEqual(servers(), [`server=127.0.0.1#${port}`], 'one failed probe is not an outage yet');
  await ticks(1);
  assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8']);
  assert.doesNotMatch(fs.readFileSync(confPath, 'utf8'), /add-subnet/);
  assert.equal(restarts, 1);

  const health = await agent.get('/api/v1/pihole/health');
  assert.equal(health.body.data.dnsChain.state, 'fallback');
  assert.ok(health.body.data.dnsChain.since > 0);
  assert.equal(health.body.data.dnsChain.targets[0].ok, false);
  const down = getDb().prepare("SELECT severity FROM activity_log WHERE event_type = 'pihole_dns_fallback'").all();
  assert.deepEqual(down.map(r => r.severity), ['warning']);

  // saving the settings while fallen back must not put the dead resolver back
  pihole.applyDnsChain();
  await ticks(1);
  assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8']);
  assert.equal(restarts, 1);

  // the gateway is back
  sock = await listen(port);
  await ticks(2);
  assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8'], 'not before it answered three rounds in a row');
  await ticks(1);
  assert.deepEqual(servers(), [`server=127.0.0.1#${port}`], 'default upstreams are gone again');
  assert.match(fs.readFileSync(confPath, 'utf8'), /^add-subnet=32,128$/m);
  assert.equal(restarts, 2);
  assert.equal(pihole.getStatus().dnsChain.state, 'pihole');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'pihole_dns_restored'").get().n, 1);
});

test('switching the chain on with a resolver that does not answer never makes it the only upstream', async () => {
  fs.writeFileSync(confPath, 'bind-dynamic\nno-resolv\nserver=1.1.1.1\nserver=8.8.8.8\n');
  await close(sock);
  piholeConfig.save({ enabled: true, manage_dns_chain: true,
    instances: [{ id: 'p1', url: 'http://127.0.0.1:1', dns_ip: '127.0.0.1', dns_port: port }] });
  pihole.applyDnsChain();
  await ticks(1);
  assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8']);
  assert.equal(restarts, 0);
  assert.equal(pihole.getStatus().dnsChain.state, 'fallback');
});

test('chain switched off: defaults restored even when entrypoint.sh baked the chain in', async () => {
  fs.writeFileSync(confPath, `bind-dynamic\nadd-subnet=32,128\nserver=127.0.0.1#${port}\n`);
  piholeConfig.save({ enabled: true, manage_dns_chain: false,
    instances: [{ id: 'p1', url: 'http://127.0.0.1:1', dns_ip: '127.0.0.1', dns_port: port }] });
  pihole.applyDnsChain();
  await ticks(1);
  assert.deepEqual(servers(), ['server=1.1.1.1', 'server=8.8.8.8']);
  assert.equal(pihole.getStatus().dnsChain.state, 'off');
});

test('settings: hint when every DNS address is the tunnel address of one gateway', async () => {
  getDb().prepare("INSERT INTO peers (name, public_key, peer_type, allowed_ips, enabled) VALUES ('DS918+', 'pk-gw', 'gateway', '10.8.0.2/32', 1)").run();
  getDb().prepare("INSERT INTO peers (name, public_key, peer_type, allowed_ips, enabled) VALUES ('Handy', 'pk-ph', 'regular', '10.8.0.7/32', 1)").run();
  const hint = async (cfg) => {
    piholeConfig.save(cfg);
    return (await agent.get('/api/v1/settings/pihole')).body.data.chain_single_gateway;
  };
  const gw = { id: 'p1', url: 'http://10.8.0.2:8081', dns_ip: '10.8.0.2', dns_port: 5335 };
  assert.deepEqual(await hint({ enabled: true, manage_dns_chain: true, instances: [gw] }), { name: 'DS918+', ip: '10.8.0.2' });
  assert.equal(await hint({ enabled: true, manage_dns_chain: true, instances: [gw, { id: 'p2', url: 'http://192.168.1.5', dns_ip: '192.168.1.5' }] }), null, 'second instance elsewhere');
  assert.equal(await hint({ enabled: true, manage_dns_chain: true, instances: [{ ...gw, dns_ip: '10.8.0.7' }] }), null, 'not a gateway');
  assert.equal(await hint({ enabled: true, manage_dns_chain: false, instances: [gw] }), null, 'chain not managed');
  assert.equal(await hint({ enabled: true, manage_dns_chain: true, instances: [] }), null);
});

test('pages: fallback banner, chain cell and gateway hint are in the markup; texts in DE and EN', async () => {
  const page = await agent.get('/pihole');
  assert.equal(page.status, 200);
  assert.match(page.text, /id="ph-chain-warn"[^>]*display:none/);
  assert.match(page.text, /id="ph-health-chain"/);
  const settings = await agent.get('/settings');
  assert.match(settings.text, /id="st-ph-gwhint"[^>]*hidden/);
  const de = require('../src/i18n/de.json'); const en = require('../src/i18n/en.json');
  for (const k of ['pihole.chain', 'pihole.chain_pihole', 'pihole.chain_fallback', 'pihole.chain_off', 'pihole.chain_since',
    'pihole.chain_fallback_warn', 'st.ph.single_gateway']) {
    assert.ok(de[k], 'de ' + k); assert.ok(en[k], 'en ' + k); assert.notEqual(de[k], en[k], k);
  }
  for (const k of ['pihole.chain_fallback', 'pihole.chain_fallback_warn', 'pihole.chain_off', 'pihole.chain_pihole', 'pihole.chain_since']) {
    assert.ok(page.text.includes(JSON.stringify(de[k]).slice(1, 20)) || page.text.includes(k), 'client text ' + k);
  }
});

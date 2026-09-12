'use strict';

// Pure helpers of the zones page (public/js/zones-view.js) against a fixture
// shaped like GET /api/v1/zones in docs/feature-domain-zones.md.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function entry(over) {
  return Object.assign({
    id: 0, domain: null, description: null, route_type: 'http', l4_protocol: null, l4_listen_port: null,
    l4_tls_mode: null, target_kind: 'gateway', peer_id: null, peer_ip: null, peer_name: null, peer_enabled: 1,
    target_peer_id: 79, target_peer_name: 'Home Gateway', target_peer_ip: '10.8.0.8/32', target_peer_enabled: 1,
    target_pool_id: null, target_lan_host: null, target_lan_port: null, target_port: null, target_ip: null,
    https_enabled: 1, backend_https: 0, external_enabled: 0, enabled: 1, monitoring_enabled: 0,
    monitoring_status: null, basic_auth_enabled: 0, route_auth_enabled: 0, bundle_id: null, baseUnverified: false,
    rdp_owned: false, rdp_route_id: null,
  }, over);
}

function zonesFixture() {
  const apex = {
    id: 1, domain_id: 1, subdomain: '@', fqdn: 'marcbackes.net', name: 'Homepage', description: 'Hauptdomain · Homepage',
    template: null, lan_host: '192.168.2.151', gateway_override: false, entry_count: 1, enabled_count: 1, health: 'ok',
    entries: [entry({ id: 101, domain: 'marcbackes.net', target_lan_host: '192.168.2.151', target_lan_port: 8092, target_port: 8092, external_enabled: 1, bundle_id: 1 })],
  };
  const claude = {
    id: 2, domain_id: 1, subdomain: 'claude', fqdn: 'claude.marcbackes.net', name: 'Claude Code', description: 'Claude Code',
    template: null, lan_host: '192.168.2.86', gateway_override: false, entry_count: 3, enabled_count: 3, health: 'ok',
    entries: [
      entry({ id: 102, domain: 'claude.marcbackes.net', target_lan_host: '192.168.2.86', target_lan_port: 80, target_port: 80, bundle_id: 2 }),
      entry({ id: 103, domain: 'claude.marcbackes.net', route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2028', l4_tls_mode: 'none', target_lan_host: '192.168.2.86', target_lan_port: 22, target_port: 22, https_enabled: 0, bundle_id: 2 }),
      // RDP-owned L4 route: read-only "Remote Desktop" entry.
      entry({ id: 110, domain: null, route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '3392', l4_tls_mode: 'none', target_lan_host: '192.168.2.86', target_lan_port: 3389, target_port: 3389, https_enabled: 0, rdp_owned: true, rdp_route_id: 7 }),
    ],
  };
  const drucker = {
    id: 3, domain_id: 1, subdomain: 'drucker', fqdn: 'drucker.marcbackes.net', name: 'Drucker', description: 'HP Officejet Pro 8720',
    template: 'printer', lan_host: '192.168.2.45', gateway_override: false, entry_count: 3, enabled_count: 3, health: 'degraded',
    entries: [
      entry({ id: 106, domain: 'drucker.marcbackes.net', route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '9100', l4_tls_mode: 'none', target_lan_host: '192.168.2.45', target_lan_port: 9100, target_port: 9100, https_enabled: 0, bundle_id: 3, monitoring_enabled: 1, monitoring_status: 'down' }),
      entry({ id: 104, domain: 'drucker.marcbackes.net', target_lan_host: '192.168.2.45', target_lan_port: 443, target_port: 443, backend_https: 1, bundle_id: 3 }),
      entry({ id: 105, domain: 'drucker.marcbackes.net', route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '631', l4_tls_mode: 'none', target_lan_host: '192.168.2.45', target_lan_port: 631, target_port: 631, https_enabled: 0, bundle_id: 3 }),
    ],
  };
  const mail1 = {
    id: 4, domain_id: 1, subdomain: 'mail1', fqdn: 'mail1.marcbackes.net', name: 'M365 MCP', description: 'M365 MCP',
    template: null, lan_host: '192.168.2.151', gateway_override: true, entry_count: 1, enabled_count: 0, health: 'disabled',
    entries: [entry({ id: 107, domain: 'mail1.marcbackes.net', target_peer_id: 84, target_peer_name: 'DS918 Gateway', target_lan_host: '192.168.2.151', target_lan_port: 3001, target_port: 3001, external_enabled: 1, enabled: 0, bundle_id: 4 })],
  };
  const nas = {
    id: 5, domain_id: 2, subdomain: 'nas', fqdn: 'nas.domaincaster.com', name: 'DS218+', description: 'DS218+',
    template: 'nas', lan_host: '192.168.2.228', gateway_override: false, entry_count: 2, enabled_count: 2, health: 'ok',
    entries: [
      entry({ id: 201, domain: 'nas.domaincaster.com', target_lan_host: '192.168.2.228', target_lan_port: 5001, target_port: 5001, backend_https: 1, external_enabled: 1, target_pool_id: 3, target_peer_id: null, target_peer_name: null }),
      entry({ id: 202, domain: 'nas.domaincaster.com', route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '4450', target_lan_host: '192.168.2.228', target_lan_port: 445, target_port: 445, https_enabled: 0, target_pool_id: 3, target_peer_id: null, target_peer_name: null }),
    ],
  };
  const unassigned = [{
    id: 9, domain_id: null, subdomain: null, fqdn: null, name: 'Game server', description: null,
    template: null, lan_host: null, gateway_override: false, entry_count: 1, enabled_count: 1, health: 'ok',
    entries: [entry({ id: 301, route_type: 'l4', l4_protocol: 'udp', l4_listen_port: '27015-27020', l4_tls_mode: 'none', target_kind: 'peer', peer_id: 12, peer_ip: '10.8.0.12/32', peer_name: 'Gaming PC', target_peer_id: null, target_peer_name: null, target_port: null, https_enabled: 0, external_enabled: 1 })],
  }];

  return {
    ok: true,
    zones: [
      {
        domain_id: 1, domain: 'marcbackes.net', verification: 'verified',
        gateway: { kind: 'gateway', peer_id: 79, pool_id: null, name: 'Home Gateway', ip: '10.8.0.8', online: true },
        default_external_enabled: false,
        counts: { hosts: 4, entries: 8, http: 4, l4: 4, disabled: 1 },
        health: 'degraded',
        // deliberately NOT in display order — sortHosts must fix it
        hosts: [mail1, drucker, apex, claude],
      },
      {
        domain_id: 2, domain: 'domaincaster.com', verification: 'pending',
        gateway: { kind: 'pool', peer_id: null, pool_id: 3, name: 'Zuhause', ip: null, online: null },
        default_external_enabled: true,
        counts: { hosts: 1, entries: 2, http: 1, l4: 1, disabled: 0 },
        health: 'ok',
        hosts: [nas],
      },
      {
        domain_id: 3, domain: 'jennybackes.de', verification: 'failed',
        gateway: { kind: null, peer_id: null, pool_id: null, name: null, ip: null, online: null },
        default_external_enabled: false,
        counts: { hosts: 0, entries: 0, http: 0, l4: 0, disabled: 0 },
        health: 'ok',
        hosts: [],
      },
    ],
    unassigned,
    gateways: [{ peer_id: 79, name: 'Home Gateway', ip: '10.8.0.8', online: true }, { peer_id: 84, name: 'DS918 Gateway', ip: '10.8.0.9', online: false }],
    pools: [{ id: 3, name: 'Zuhause' }],
  };
}


const V = require('../public/js/zones-view');

function allZones() { return V.pageZones(zonesFixture()); }
function hostIds(zones) { return zones.flatMap((z) => z.hosts.map((h) => h.id)); }
function byDomain(zones, d) { return zones.find((z) => z.domain === d); }

describe('zones-view: sortHosts', () => {
  it("puts '@' first, then alphabetical by subdomain", () => {
    const hosts = zonesFixture().zones[0].hosts;
    assert.deepEqual(V.sortHosts(hosts).map((h) => h.subdomain), ['@', 'claude', 'drucker', 'mail1']);
  });
  it('does not mutate the input and tolerates empty/undefined', () => {
    const hosts = zonesFixture().zones[0].hosts;
    const before = hosts.map((h) => h.id);
    V.sortHosts(hosts);
    assert.deepEqual(hosts.map((h) => h.id), before);
    assert.deepEqual(V.sortHosts(undefined), []);
  });
  it('sorts case-insensitively; hosts without subdomain by name', () => {
    const s = V.sortHosts([{ id: 1, subdomain: 'beta' }, { id: 2, subdomain: 'Alpha' }, { id: 3, subdomain: '@' }]);
    assert.deepEqual(s.map((h) => h.id), [3, 2, 1]);
    const u = V.sortHosts([{ id: 1, subdomain: null, name: 'zeta' }, { id: 2, subdomain: null, name: 'alpha' }]);
    assert.deepEqual(u.map((h) => h.id), [2, 1]);
  });
  it('labels the base domain as @', () => {
    const [apex] = V.sortHosts(zonesFixture().zones[0].hosts);
    assert.equal(V.hostLabel(apex), '@');
    assert.equal(V.isApex(apex), true);
    assert.equal(V.hostLabel(zonesFixture().unassigned[0]), 'Game server');
  });
});

describe('zones-view: entryChip', () => {
  it('HTTPS with gateway LAN port', () => {
    assert.deepEqual(V.entryChip(entry({ target_lan_port: 8092, target_port: 8092 })), { proto: 'HTTPS', out: '443', in: '8092' });
  });
  it('plain HTTP (https disabled) listens on 80', () => {
    assert.deepEqual(V.entryChip(entry({ https_enabled: 0, target_lan_port: 3000 })), { proto: 'HTTP', out: '80', in: '3000' });
  });
  it('backend HTTPS adds a note', () => {
    const c = V.entryChip(entry({ target_lan_port: 5001, backend_https: 1 }));
    assert.equal(c.proto, 'HTTPS');
    assert.equal(c.note, 'Backend HTTPS');
  });
  it('TCP listen → target', () => {
    const c = V.entryChip(entry({ route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2028', target_lan_port: 22, https_enabled: 0 }));
    assert.deepEqual(c, { proto: 'TCP', out: '2028', in: '22' });
  });
  it('UDP range on a peer target falls back to the listen range', () => {
    const c = V.entryChip(zonesFixture().unassigned[0].entries[0]);
    assert.deepEqual(c, { proto: 'UDP', out: '27015-27020', in: '27015-27020' });
  });
  it('peer-routed entries use target_port; TLS-SNI is noted', () => {
    const c = V.entryChip(entry({ route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough', target_kind: 'peer', peer_ip: '10.8.0.5/32', target_port: 443 }));
    assert.deepEqual(c, { proto: 'TCP', out: '8443', in: '443', note: 'TLS-SNI' });
  });
  it('port labels come from the target port', () => {
    assert.equal(V.entryPortLabel(entry({ route_type: 'l4', target_lan_port: 22 })), 'SSH');
    assert.equal(V.entryPortLabel(entry({ route_type: 'l4', target_lan_port: 9100 })), 'JetDirect');
    assert.equal(V.entryPortLabel(entry({ target_lan_port: 22 })), null);
  });
});

describe('zones-view: targets and status', () => {
  it('gateway hosts show lan_host, peer hosts the peer IP', () => {
    const z = allZones();
    const claude = byDomain(z, 'marcbackes.net').hosts.find((h) => h.subdomain === 'claude');
    assert.equal(V.hostTarget(claude), '192.168.2.86');
    assert.equal(V.hostSinglePort(claude), null);
    const apex = byDomain(z, 'marcbackes.net').hosts[0];
    assert.equal(V.hostSinglePort(apex), '8092');
    const game = z[z.length - 1].hosts[0];
    assert.equal(V.hostTarget(game), '10.8.0.12');
  });
  it('hostHealth prefers backend health, derives otherwise', () => {
    const drucker = zonesFixture().zones[0].hosts.find((h) => h.subdomain === 'drucker');
    assert.equal(V.hostHealth(drucker), 'degraded');
    const derived = Object.assign({}, drucker, { health: undefined });
    assert.equal(V.hostHealth(derived), 'degraded');
    assert.equal(V.hostHealth({ entries: [entry({ enabled: 0 })] }), 'disabled');
    assert.equal(V.hostHealth({ entries: [entry({ target_peer_enabled: 0 })] }), 'down');
  });
  it('access: external when any entry is external', () => {
    const hosts = zonesFixture().zones[0].hosts;
    assert.equal(V.hostAccess(hosts.find((h) => h.subdomain === '@')), 'external');
    assert.equal(V.hostAccess(hosts.find((h) => h.subdomain === 'claude')), 'internal');
  });
  it('hostEnabled uses enabled_count', () => {
    const hosts = zonesFixture().zones[0].hosts;
    assert.equal(V.hostEnabled(hosts.find((h) => h.subdomain === 'mail1')), false);
    assert.equal(V.hostEnabled(hosts.find((h) => h.subdomain === 'claude')), true);
  });
  it('sortEntries: http first, then listen port numerically', () => {
    const drucker = zonesFixture().zones[0].hosts.find((h) => h.subdomain === 'drucker');
    assert.deepEqual(V.sortEntries(drucker.entries).map((e) => e.id), [104, 105, 106]);
  });
});

describe('zones-view: gateway keys', () => {
  it('zone, entry and override host keys', () => {
    const d = zonesFixture();
    assert.equal(V.zoneGatewayKey(d.zones[0]), 'gateway:79');
    assert.equal(V.zoneGatewayKey(d.zones[1]), 'pool:3');
    assert.equal(V.zoneGatewayKey(d.zones[2]), null);
    const mail1 = d.zones[0].hosts.find((h) => h.subdomain === 'mail1');
    assert.equal(V.hostGatewayKey(mail1, d.zones[0]), 'gateway:84');
    assert.equal(V.hostGatewayKey(d.unassigned[0], V.buildUnassignedZone(d.unassigned)), 'peer:12');
  });
  it('parseGatewayKey builds the PUT /domains/:id/gateway body', () => {
    assert.deepEqual(V.parseGatewayKey('gateway:79'), { kind: 'gateway', peer_id: 79 });
    assert.deepEqual(V.parseGatewayKey('pool:3'), { kind: 'pool', pool_id: 3 });
    assert.deepEqual(V.parseGatewayKey('peer:12'), { kind: 'peer', peer_id: 12 });
    assert.equal(V.parseGatewayKey('bogus'), null);
  });
  it('gatewayChoices lists zone gateways, pools and override/peer targets once', () => {
    const keys = V.gatewayChoices(allZones()).map((c) => c.key).sort();
    assert.deepEqual(keys, ['gateway:79', 'gateway:84', 'peer:12', 'pool:3']);
  });
});

describe('zones-view: filterZones', () => {
  it('no filter → every zone (incl. empty ones and "Ohne Domain"), hosts intact', () => {
    const z = V.filterZones(allZones(), {});
    assert.equal(z.length, 4);
    assert.equal(z[3].unassigned, true);
    assert.equal(z[0].hosts.length, 4);
  });
  it('returns copies and never mutates the input', () => {
    const input = allZones();
    const out = V.filterZones(input, { q: 'claude' });
    assert.equal(input[0].hosts.length, 4);
    assert.notEqual(out[0], input[0]);
  });
  it('type http keeps hosts with an HTTP entry; zones without hits drop out', () => {
    const z = V.filterZones(allZones(), { type: 'http' });
    assert.deepEqual(hostIds(z), [1, 2, 3, 4, 5]);
    assert.ok(!z.some((x) => x.unassigned));
    assert.ok(!z.some((x) => x.domain === 'jennybackes.de'));
  });
  it('type l4 keeps hosts with a TCP/UDP entry', () => {
    assert.deepEqual(hostIds(V.filterZones(allZones(), { type: 'l4' })), [2, 3, 5, 9]);
  });
  it('access external / internal', () => {
    assert.deepEqual(hostIds(V.filterZones(allZones(), { access: 'external' })), [1, 4, 5, 9]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { access: 'internal' })), [2, 3, 5]);
  });
  it('state disabled / problem', () => {
    assert.deepEqual(hostIds(V.filterZones(allZones(), { state: 'disabled' })), [4]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { state: 'problem' })), [3]);
  });
  it('gatewayKey: zone gateway vs. override host', () => {
    assert.deepEqual(hostIds(V.filterZones(allZones(), { gatewayKey: 'gateway:79' })), [1, 2, 3]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { gatewayKey: 'gateway:84' })), [4]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { gatewayKey: 'pool:3' })), [5]);
  });
  it('search over fqdn, description, lan_host and ports (case-insensitive)', () => {
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: 'CLAUDE.marc' })), [2]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: 'officejet' })), [3]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: '192.168.2.228' })), [5]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: '2028' })), [2]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: '8092' })), [1]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: '27016' })), []);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: '27015' })), [9]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { q: 'domaincaster' })), [5]);
    assert.equal(hostIds(V.filterZones(allZones(), { q: '  ' })).length, 6);
  });
  it('criteria combine with AND', () => {
    assert.deepEqual(hostIds(V.filterZones(allZones(), { type: 'l4', access: 'external' })), [9]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { type: 'http', q: 'drucker' })), [3]);
    assert.deepEqual(hostIds(V.filterZones(allZones(), { type: 'http', state: 'disabled', gatewayKey: 'gateway:79' })), []);
  });
  it('isFilterActive', () => {
    assert.equal(V.isFilterActive({}), false);
    assert.equal(V.isFilterActive({ q: ' ' }), false);
    assert.equal(V.isFilterActive({ state: 'problem' }), true);
  });
});

describe('zones-view: summarize, counts, pseudo-zone', () => {
  it('summarize counts domains (not the pseudo-zone), hosts, L4 entries and disabled entries', () => {
    assert.deepEqual(V.summarize(allZones()), { domains: 3, hosts: 6, l4: 6, disabled: 1 });
    assert.deepEqual(V.summarize([]), { domains: 0, hosts: 0, l4: 0, disabled: 0 });
  });
  it('pageZones sorts hosts and appends "Ohne Domain" last only when needed', () => {
    const z = allZones();
    assert.deepEqual(z.map((x) => x.domain), ['marcbackes.net', 'domaincaster.com', 'jennybackes.de', null]);
    assert.equal(z[0].hosts[0].subdomain, '@');
    const none = V.pageZones(Object.assign(zonesFixture(), { unassigned: [] }));
    assert.equal(none.length, 3);
  });
  it('buildUnassignedZone aggregates counts and health', () => {
    const u = V.buildUnassignedZone(zonesFixture().unassigned);
    assert.equal(u.unassigned, true);
    assert.equal(u.domain_id, null);
    assert.deepEqual(u.counts, { hosts: 1, entries: 1, http: 0, l4: 1, disabled: 0 });
    assert.equal(u.health, 'ok');
    assert.equal(V.zoneKey(u), V.UNASSIGNED_KEY);
    assert.equal(V.zoneKey(allZones()[0]), 'z:1');
  });
  it('smbEntries finds port-445 L4 entries for the scan-to-folder picker', () => {
    const z = byDomain(allZones(), 'domaincaster.com');
    assert.deepEqual(V.smbEntries(z).map((s) => s.id), [202]);
    assert.deepEqual(V.smbEntries(byDomain(allZones(), 'marcbackes.net')), []);
  });
});

describe('zones-view: input helpers', () => {
  it('previewFqdn', () => {
    assert.equal(V.previewFqdn('', 'marcbackes.net'), 'marcbackes.net');
    assert.equal(V.previewFqdn('@', 'marcbackes.net'), 'marcbackes.net');
    assert.equal(V.previewFqdn('NAS', 'marcbackes.net'), 'nas.marcbackes.net');
  });
  it('validSubdomain', () => {
    for (const ok of ['', '@', 'nas', 'a.b', 'my-host', 'x1']) assert.equal(V.validSubdomain(ok), true, ok);
    for (const bad of ['-x', 'x-', 'a..b', 'a b', 'ä', 'a_b']) assert.equal(V.validSubdomain(bad), false, bad);
  });
  it('validIPv4 / validPort', () => {
    assert.equal(V.validIPv4('192.168.2.45'), true);
    assert.equal(V.validIPv4('192.168.2.256'), false);
    assert.equal(V.validPort('443'), true);
    assert.equal(V.validPort('0'), false);
    assert.equal(V.validPort('70000'), false);
    assert.equal(V.validPort('5000-5010'), false);
    assert.equal(V.validPort('5000-5010', true), true);
    assert.equal(V.validPort('5010-5000', true), false);
  });
});

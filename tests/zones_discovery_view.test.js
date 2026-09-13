'use strict';

// Pure helpers of the LAN-discovery picker in the domain dialog
// (public/js/zones-view.js, appended block; docs/feature-tls-guard.md,
// "LAN-Erkennung im Domain-Dialog").
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const V = require('../public/js/zones-view.js');

describe('zones-view: discovery – subdomain suggestion', () => {
  it('strips .local, lowercases and keeps [a-z0-9-]', () => {
    assert.equal(V.suggestSubdomain('Synology.local'), 'synology');
    assert.equal(V.suggestSubdomain('synology.local.'), 'synology');
    assert.equal(V.suggestSubdomain('HP Officejet Pro 8720'), 'hp-officejet-pro-8720');
    assert.equal(V.suggestSubdomain('DS918+'), 'ds918');
    assert.equal(V.suggestSubdomain('--weird__name--'), 'weird-name');
  });
  it('keeps only the first label of a qualified name', () => {
    assert.equal(V.suggestSubdomain('nas.fritz.box'), 'nas');
    assert.equal(V.suggestSubdomain('printer.home.arpa.'), 'printer');
  });
  it('returns "" when nothing usable is left', () => {
    assert.equal(V.suggestSubdomain(''), '');
    assert.equal(V.suggestSubdomain(null), '');
    assert.equal(V.suggestSubdomain('.local'), '');
    assert.equal(V.suggestSubdomain('***'), '');
  });
  it('caps the label at 63 characters', () => {
    const s = V.suggestSubdomain('a'.repeat(70) + '.local');
    assert.equal(s.length, 63);
    assert.ok(V.validSubdomain(s));
  });
});

describe('zones-view: discovery – port classification', () => {
  it('lists the contract HTTP ports', () => {
    assert.deepEqual(V.DISCOVERY_HTTP_PORTS, [80, 443, 8080, 8443, 8000, 8081, 3000, 5000, 8096, 32400, 9000, 8123, 631]);
  });
  it('HTTP ports → https entry, backend_https only for 443/8443', () => {
    assert.deepEqual(V.classifyDiscoveredPort(80), { type: 'http', target: 80, bhttps: false });
    assert.deepEqual(V.classifyDiscoveredPort(8123), { type: 'http', target: 8123, bhttps: false });
    assert.deepEqual(V.classifyDiscoveredPort(443), { type: 'http', target: 443, bhttps: true });
    assert.deepEqual(V.classifyDiscoveredPort('8443'), { type: 'http', target: 8443, bhttps: true });
  });
  it('other ports → tcp with the same listen port suggested', () => {
    assert.deepEqual(V.classifyDiscoveredPort(22), { type: 'tcp', target: 22, listen: 22 });
    assert.deepEqual(V.classifyDiscoveredPort(9100), { type: 'tcp', target: 9100, listen: 9100 });
  });
  it('rejects invalid ports', () => {
    for (const p of [0, 65536, -1, 'x', null, undefined, 1.5]) assert.equal(V.classifyDiscoveredPort(p), null, String(p));
  });
  it('entryDraftFromPort matches the new-host draft shape (strings)', () => {
    assert.deepEqual(V.entryDraftFromPort(443, true), { type: 'http', target: '443', listen: '', bhttps: true });
    assert.deepEqual(V.entryDraftFromPort(22, true), { type: 'tcp', target: '22', listen: '22', bhttps: false });
    assert.equal(V.entryDraftFromPort('nope', true), null);
  });
  it('entryDraftFromPort falls back to HTTPS when L4 is not allowed', () => {
    assert.deepEqual(V.entryDraftFromPort(22, false), { type: 'http', target: '22', listen: '', bhttps: false });
    assert.deepEqual(V.entryDraftFromPort(443, false), { type: 'http', target: '443', listen: '', bhttps: true });
  });
});

describe('zones-view: discovery – device lists', () => {
  const devices = [
    { ip: '192.168.2.45', hostname: 'HP8720.local', mac: 'aa', ports: [{ port: 9100, source: 'tcp' }, { port: 631, source: 'mdns' }, { port: 80, source: 'ssdp' }, { port: 80, source: 'tcp' }] },
    { ip: '192.168.2.5', hostname: 'nas.local', ports: [{ port: 5000 }, { port: 'bad' }] },
    { ip: '192.168.2.100', hostname: null, ports: [] },
    { ip: '', hostname: '' },
  ];
  it('devicePorts: unique, ascending, invalid dropped', () => {
    assert.deepEqual(V.devicePorts(devices[0]), [80, 631, 9100]);
    assert.deepEqual(V.devicePorts(devices[1]), [5000]);
    assert.deepEqual(V.devicePorts(devices[2]), []);
    assert.deepEqual(V.devicePorts(null), []);
    assert.deepEqual(V.devicePorts({ ports: [22, '443'] }), [22, 443]);
  });
  it('filterDiscovered: sorts by IP and drops empty rows', () => {
    assert.deepEqual(V.filterDiscovered(devices, '').map((d) => d.ip), ['192.168.2.5', '192.168.2.45', '192.168.2.100']);
  });
  it('filterDiscovered: case-insensitive substring over hostname and IP', () => {
    assert.deepEqual(V.filterDiscovered(devices, 'hp').map((d) => d.ip), ['192.168.2.45']);
    assert.deepEqual(V.filterDiscovered(devices, '2.10').map((d) => d.ip), ['192.168.2.100']);
    assert.deepEqual(V.filterDiscovered(devices, 'NAS').map((d) => d.ip), ['192.168.2.5']);
    assert.deepEqual(V.filterDiscovered(devices, 'zzz'), []);
    assert.deepEqual(V.filterDiscovered(null, 'x'), []);
  });
  it('discoveryAgeMinutes: whole minutes, null when unknown', () => {
    const now = 1_700_000_000_000;
    assert.equal(V.discoveryAgeMinutes(now - 20_000, now), 0);
    assert.equal(V.discoveryAgeMinutes(now - 3 * 60_000, now), 3);
    assert.equal(V.discoveryAgeMinutes(now + 60_000, now), 0);
    assert.equal(V.discoveryAgeMinutes(null, now), null);
    assert.equal(V.discoveryAgeMinutes(0, now), null);
  });
  it('discoveryStateOf: capability from telemetry, enabled from settings', () => {
    assert.deepEqual(V.discoveryStateOf({ health: { telemetry: { lan_discovery: true } }, discovery: { enabled: 1 } }), { capable: true, enabled: true });
    assert.deepEqual(V.discoveryStateOf({ health: { telemetry: { lan_discovery: true } }, discovery: { enabled: 0 } }), { capable: true, enabled: false });
    assert.deepEqual(V.discoveryStateOf({ health: { telemetry: {} }, discovery: { enabled: 1 } }), { capable: false, enabled: true });
    assert.deepEqual(V.discoveryStateOf({}), { capable: false, enabled: false });
    assert.deepEqual(V.discoveryStateOf(null), { capable: false, enabled: false });
  });
});

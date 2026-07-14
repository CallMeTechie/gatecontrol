'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const view = require('../public/js/routes-view.js');

const l4 = (over = {}) => ({
  route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2022',
  target_kind: 'gateway', target_lan_host: '192.168.2.228', target_lan_port: 22,
  target_ip: '127.0.0.1', target_port: 22,
  domain: null, description: null, external_enabled: 1, enabled: 1, ...over,
});
const http = (over = {}) => ({
  route_type: 'http', target_kind: 'gateway',
  target_lan_host: '192.168.2.228', target_lan_port: 5001,
  target_ip: '10.8.0.2', target_port: 5001,
  domain: 'nas.example.com', description: null, external_enabled: 0, enabled: 1, ...over,
});

test('l4Label maps well-known target ports, null otherwise', () => {
  assert.equal(view.l4Label(l4()), 'SSH');
  assert.equal(view.l4Label(l4({ target_lan_port: 3389 })), 'RDP');
  assert.equal(view.l4Label(l4({ target_lan_port: 631 })), 'IPP');
  assert.equal(view.l4Label(l4({ target_lan_port: 9100 })), 'RAW-Print');
  assert.equal(view.l4Label(l4({ target_lan_port: 6444 })), null);
  assert.equal(view.l4Label(http()), null); // nur L4
});

test('routeTitle cascade: domain > description > l4Label > proto:port', () => {
  assert.equal(view.routeTitle(http()), 'nas.example.com');
  assert.equal(view.routeTitle(l4({ domain: 'ssh.example.com' })), 'ssh.example.com');
  assert.equal(view.routeTitle(l4({ description: 'Claude Code' })), 'Claude Code');
  assert.equal(view.routeTitle(l4()), 'SSH');
  assert.equal(view.routeTitle(l4({ target_lan_port: 6444, l4_listen_port: '6444' })), 'TCP :6444');
  assert.equal(view.routeTitle(l4({ target_lan_port: 6444, l4_listen_port: '6444', l4_protocol: 'udp' })), 'UDP :6444');
});

test('routeSubtitle: mapping with/without host, description appended unless title', () => {
  assert.equal(view.routeSubtitle(http()), '→ 192.168.2.228:5001');
  assert.equal(view.routeSubtitle(http(), { omitHost: true }), '→ :5001');
  assert.equal(view.routeSubtitle(l4()), 'tcp/2022 → 192.168.2.228:22');
  assert.equal(view.routeSubtitle(l4(), { omitHost: true }), 'tcp/2022 → :22');
  // description erscheint als Suffix, wenn sie nicht schon der Titel ist
  assert.equal(view.routeSubtitle(http({ description: 'DS218+' })), '→ 192.168.2.228:5001 · DS218+');
  // description IST der Titel (kein Domain) → kein doppeltes Suffix
  assert.equal(view.routeSubtitle(l4({ description: 'Claude Code' })), 'tcp/2022 → 192.168.2.228:22');
});

test('routeSubtitle peer target uses peer_ip without CIDR suffix', () => {
  const r = http({ target_kind: 'peer', peer_ip: '10.8.0.7/32', target_port: 8080 });
  assert.equal(view.routeSubtitle(r), '→ 10.8.0.7:8080');
});

test('filterRoutes exposure criterion', () => {
  const routes = [l4({ external_enabled: 1 }), http({ external_enabled: 0 })];
  assert.equal(view.filterRoutes(routes, { exposure: 'external' }).length, 1);
  assert.equal(view.filterRoutes(routes, { exposure: 'internal' }).length, 1);
  assert.equal(view.filterRoutes(routes, {}).length, 2); // ohne exposure: unverändert
});

test('filterRoutes search matches listen port, target port and l4 label', () => {
  const routes = [l4()]; // listen 2022, target 22, label SSH
  assert.equal(view.filterRoutes(routes, { q: '2022' }).length, 1);
  assert.equal(view.filterRoutes(routes, { q: 'ssh' }).length, 1);
  assert.equal(view.filterRoutes(routes, { q: '9100' }).length, 0);
});

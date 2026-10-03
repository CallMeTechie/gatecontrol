'use strict';

// Pure helpers of the redesigned "Domains & Routen" page and its dialogs
// (public/js/zones-view.js, docs/feature-domain-zones.md): host-row lines,
// the status select, the inline entry edit of "Host bearbeiten" (incl. both
// port fields of gateway targets and type changes), the "Neuer Host" body,
// preview and checks, and the editor's connection flow.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/js/zones-view.js');

function entry(over) {
  return Object.assign({
    id: 1, domain: 'nas.example.com', route_type: 'http', l4_protocol: null, l4_listen_port: null, l4_tls_mode: null,
    target_kind: 'gateway', target_peer_id: 7, target_lan_host: '192.168.2.30', target_lan_port: 5001, target_port: 5001,
    https_enabled: 1, backend_https: 0, external_enabled: 1, enabled: 1, rdp_owned: false, hsts: { enabled: false },
    waf_enabled: 0, basic_auth_enabled: 0, route_auth_enabled: 0, description: null,
  }, over);
}
const tcp = (over) => entry(Object.assign({ id: 2, route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2222', l4_tls_mode: 'none', target_lan_port: 22, target_port: 22, https_enabled: 0 }, over));
const zone = { domain_id: 1, domain: 'example.com', verification: 'verified', default_external_enabled: true, gateway: { kind: 'gateway', name: 'home-gw', online: true } };
function host(entries, over) {
  return Object.assign({ id: 5, subdomain: 'nas', fqdn: 'nas.example.com', description: 'NAS', lan_host: '192.168.2.30', entries }, over);
}

describe('host rows', () => {
  it('entryLine: chip type, port outside → target in the LAN, notes', () => {
    const l = V.entryLine(entry({ backend_https: 1, waf_enabled: 1, waf_mode: 'block', hsts: { enabled: true } }));
    assert.equal(l.kind, 'http');
    assert.equal(l.type, 'HTTPS');
    assert.equal(l.from, '443');
    assert.equal(l.to, '192.168.2.30 : 5001');
    assert.deepEqual(l.notes.map((n) => n.id), ['backend_https', 'hsts', 'waf']);
    const t = V.entryLine(tcp({ description: 'SSH' }));
    assert.equal(t.type, 'TCP');
    assert.equal(t.from, ':2222');
    assert.equal(t.to, '192.168.2.30 : 22');
    assert.equal(V.entryLine(tcp({ l4_protocol: 'udp' })).type, 'UDP');
    assert.equal(V.entryLine(entry({ https_enabled: 0 })).type, 'HTTP');
    assert.ok(V.entryLine(tcp({ rdp_owned: true })).notes.some((n) => n.id === 'rdp'));
  });

  it('visibleEntries follows the entry-level filters', () => {
    const h = host([entry(), tcp(), tcp({ id: 3, enabled: 0 })]);
    assert.equal(V.visibleEntries(h, {}).length, 3);
    assert.deepEqual(V.visibleEntries(h, { type: 'l4' }).map((e) => e.id).sort(), [2, 3]);
    assert.deepEqual(V.visibleEntries(h, { type: 'http' }).map((e) => e.id), [1]);
    assert.deepEqual(V.visibleEntries(h, { state: 'disabled' }).map((e) => e.id), [3]);
  });

  it('status select ↔ hash dimensions (state / access)', () => {
    assert.equal(V.statusValue({ state: 'problem' }), 'problem');
    assert.equal(V.statusValue({ access: 'internal' }), 'internal');
    assert.equal(V.statusValue(null), '');
    assert.deepEqual(V.applyStatus({ q: 'x', state: 'problem', access: null }, 'external'), { q: 'x', state: null, access: 'external' });
    assert.deepEqual(V.applyStatus({ state: 'disabled', access: 'internal' }, ''), { state: null, access: null });
    const back = V.filtersFromHash('#' + V.filtersToHash(V.applyStatus({}, 'disabled')));
    assert.equal(V.statusValue(back), 'disabled');
  });
});

describe('"Host bearbeiten": inline entry edit', () => {
  it('entryDraft / draftChanges read the target port of gateway entries (target_lan_port)', () => {
    const e = entry({ target_lan_port: 5001, target_port: 5001 });
    const d = V.entryDraft(e);
    assert.deepEqual(d, { type: 'http', outer: '', port: '5001', name: '', enabled: true });
    assert.deepEqual(V.draftChanges(e, d), []);
    assert.deepEqual(V.draftChanges(e, Object.assign({}, d, { port: '5002' })), [{ field: 'port', from: '5001', to: '5002' }]);
  });

  it('entryPatch: a changed target port sends both port fields for gateway targets, one for peers', () => {
    const gw = entry();
    const r = V.entryPatch(gw, Object.assign(V.entryDraft(gw), { port: '5002' }), { fqdn: 'nas.example.com' });
    assert.deepEqual(r.patch, { target_port: '5002', target_lan_port: 5002 });
    const peer = entry({ target_kind: 'peer', target_lan_port: null, target_port: 8080 });
    assert.deepEqual(V.entryPatch(peer, Object.assign(V.entryDraft(peer), { port: '8081' }), {}).patch, { target_port: '8081' });
    assert.equal(V.entryPatch(gw, V.entryDraft(gw), {}).patch, null, 'no change → no PUT');
    assert.equal(V.entryPatch(gw, Object.assign(V.entryDraft(gw), { port: '70000' }), {}).error, 'port');
  });

  it('entryPatch: listen port and protocol of TCP/UDP entries', () => {
    const t = tcp();
    const listen = V.entryPatch(t, Object.assign(V.entryDraft(t), { outer: '2223' }), {});
    assert.deepEqual(listen.patch, { route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2223', l4_tls_mode: 'none', domain: '' });
    const udp = V.entryPatch(t, Object.assign(V.entryDraft(t), { type: 'udp' }), {});
    assert.equal(udp.patch.l4_protocol, 'udp');
    assert.equal(udp.patch.l4_tls_mode, 'none');
    assert.equal(udp.patch.target_lan_port, 22, 'type change re-sends the target port');
    assert.equal(V.entryPatch(t, Object.assign(V.entryDraft(t), { outer: 'abc' }), {}).error, 'outer');
    const sni = tcp({ l4_tls_mode: 'passthrough', domain: 'ssh.example.com' });
    assert.equal(V.entryPatch(sni, Object.assign(V.entryDraft(sni), { outer: '2224' }), {}).patch.domain, undefined, 'SNI entries keep their name');
  });

  it('entryPatch: type change to HTTPS needs the host name and a free HTTP slot', () => {
    const t = tcp();
    const d = Object.assign(V.entryDraft(t), { type: 'http' });
    assert.equal(V.entryPatch(t, d, { fqdn: 'nas.example.com', hasOtherHttp: true }).error, 'http_taken');
    assert.equal(V.entryPatch(t, d, { fqdn: '' }).error, 'no_domain');
    const ok = V.entryPatch(t, d, { fqdn: 'nas.example.com' }).patch;
    assert.equal(ok.route_type, 'http');
    assert.equal(ok.domain, 'nas.example.com');
    assert.equal(ok.https_enabled, true);
    const h = V.entryPatch(entry(), Object.assign(V.entryDraft(entry()), { type: 'tcp', outer: '8443' }), {}).patch;
    assert.deepEqual([h.route_type, h.l4_protocol, h.l4_listen_port, h.l4_tls_mode, h.domain], ['l4', 'tcp', '8443', 'none', '']);
  });

  it('entryPatch: name and on/off', () => {
    const e = entry();
    assert.deepEqual(V.entryPatch(e, Object.assign(V.entryDraft(e), { name: ' DSM ', enabled: false }), {}).patch, { label: 'DSM', enabled: false });
  });

  it('hostPatch: subdomain, description, LAN address with validation', () => {
    const h = host([entry()]);
    assert.equal(V.hostPatch(h, V.hostDraft(h), zone).patch, null);
    assert.deepEqual(V.hostPatch(h, { subdomain: 'NAS2', description: 'NAS', lan: '192.168.2.31' }, zone).patch, { subdomain: 'nas2', lan_host: '192.168.2.31' });
    assert.equal(V.hostPatch(h, { subdomain: 'bad_name!', description: 'NAS', lan: '192.168.2.30' }, zone).error, 'subdomain');
    assert.equal(V.hostPatch(h, { subdomain: 'nas', description: 'NAS', lan: ' ' }, zone).error, 'lan');
    assert.equal(V.hostPatch(h, { subdomain: '', description: 'NAS', lan: '192.168.2.30' }, zone).patch.subdomain, '@');
  });

  it('hostSavePlan: host PUT + one PUT per changed entry, dirty count, the new name for a type change', () => {
    const h = host([entry(), tcp(), tcp({ id: 9, rdp_owned: true })]);
    const drafts = { 1: V.entryDraft(h.entries[0]), 2: Object.assign(V.entryDraft(h.entries[1]), { port: '2200', outer: '2022' }) };
    const plan = V.hostSavePlan(h, zone, Object.assign(V.hostDraft(h), { description: 'Synology' }), drafts);
    assert.deepEqual(plan.host, { description: 'Synology' });
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0].id, 2);
    assert.deepEqual(plan.entries[0].patch, { target_port: '2200', target_lan_port: 2200, route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2022', l4_tls_mode: 'none', domain: '' });
    assert.equal(plan.count, 3);
    assert.equal(plan.error, null);
    // Renaming the host and turning the TCP entry into HTTPS while the HTTPS
    // entry becomes TCP: the slot is free after the save, the new name is used.
    const swap = { 1: Object.assign(V.entryDraft(h.entries[0]), { type: 'tcp', outer: '8443' }), 2: Object.assign(V.entryDraft(h.entries[1]), { type: 'http' }) };
    const p2 = V.hostSavePlan(h, zone, Object.assign(V.hostDraft(h), { subdomain: 'files' }), swap);
    assert.equal(p2.error, null);
    assert.equal(p2.entries.find((x) => x.id === 2).patch.domain, 'files.example.com');
    const both = { 2: Object.assign(V.entryDraft(h.entries[1]), { type: 'http' }) };
    assert.deepEqual(V.hostSavePlan(h, zone, V.hostDraft(h), both).error, { scope: 'entry', id: 2, code: 'http_taken' });
  });
});

describe('"Neuer Host"', () => {
  const draft = (over) => Object.assign({ sub: 'nas', desc: 'NAS', lan: '192.168.2.30', external: false, template: null,
    entries: [{ type: 'http', outer: '443', port: '5001', backend: true }, { type: 'tcp', outer: '2222', port: '22', backend: false }] }, over);

  it('newHostBody: one POST with an entries array and the access choice', () => {
    const r = V.newHostBody(draft({ template: 'nas' }), zone);
    assert.deepEqual(r.body, {
      subdomain: 'nas', description: 'NAS', lan_host: '192.168.2.30', external_enabled: false, template: 'nas',
      entries: [{ type: 'http', target_port: 5001, backend_https: true }, { type: 'tcp', target_port: 22, listen_port: 2222 }],
    });
    assert.equal(V.newHostBody(draft({ sub: '' }), zone).body.subdomain, '@');
    assert.equal(V.newHostBody(draft({ entries: [{ type: 'udp', outer: '5000-5010', port: '53' }] }), zone).body.entries[0].listen_port, '5000-5010');
  });

  it('newHostBody: validation codes with the row index', () => {
    assert.deepEqual(V.newHostBody(draft({ sub: 'a b' }), zone).error, { field: 'sub', code: 'subdomain' });
    assert.deepEqual(V.newHostBody(draft({ lan: '' }), zone).error, { field: 'lan', code: 'lan' });
    assert.equal(V.newHostBody(draft({ lan: '' }), Object.assign({}, zone, { gateway: { kind: 'peer', ip: '10.8.0.5' } })).error, undefined, 'peer zones need no LAN address');
    assert.deepEqual(V.newHostBody(draft({ entries: [] }), zone).error, { field: 'entries', code: 'entries' });
    assert.deepEqual(V.newHostBody(draft({ entries: [{ type: 'http', port: '80' }, { type: 'http', port: '81' }] }), zone).error, { field: 'type', index: 1, code: 'http_twice' });
    assert.deepEqual(V.newHostBody(draft({ entries: [{ type: 'tcp', outer: '22', port: '0' }] }), zone).error, { field: 'port', index: 0, code: 'port' });
    assert.deepEqual(V.newHostBody(draft({ entries: [{ type: 'tcp', outer: 'x', port: '22' }] }), zone).error, { field: 'outer', index: 0, code: 'outer' });
    assert.deepEqual(V.newHostBody(draft({ entries: [{ type: 'tcp', outer: '22', port: '22' }, { type: 'tcp', outer: '22', port: '23' }] }), zone).error, { field: 'outer', index: 1, code: 'outer_twice' });
    assert.equal(V.newHostBody(draft({ entries: [{ type: 'tcp', outer: '22', port: '22' }, { type: 'udp', outer: '22', port: '23' }] }), zone).error, undefined, 'TCP and UDP may share a port');
  });

  it('templates, empty rows, preview', () => {
    assert.deepEqual(V.newEntry('udp'), { type: 'udp', outer: '', port: '', backend: false });
    assert.deepEqual(V.newEntry('x'), { type: 'http', outer: '443', port: '', backend: false });
    assert.deepEqual(V.entriesFromTemplate({ entries: [{ type: 'http', target_port: 5001, backend_https: true }, { type: 'tcp', listen_port: 2222, target_port: 22 }] }),
      [{ type: 'http', outer: '443', port: '5001', backend: true }, { type: 'tcp', outer: '2222', port: '22', backend: false }]);
    assert.deepEqual(V.newHostPreview(draft(), zone), [
      { type: 'HTTPS', kind: 'http', from: 'https://nas.example.com', to: '192.168.2.30:5001 (HTTPS)' },
      { type: 'TCP', kind: 'tcp', from: 'nas.example.com:2222', to: '192.168.2.30:22' },
    ]);
  });

  it('listen ports in use, reserved ports and the checks of the aside', () => {
    const zones = [{ hosts: [host([tcp({ id: 2, l4_listen_port: '2222' }), tcp({ id: 3, l4_listen_port: '3000', l4_tls_mode: 'passthrough' }), tcp({ id: 4, l4_listen_port: '4000', enabled: 0 })])] }];
    const used = V.usedListenPorts(zones);
    assert.deepEqual(Array.from(used.keys()), ['tcp|2222'], 'SNI and disabled entries do not block a port');
    assert.equal(V.usedListenPorts(zones, [2]).size, 0);
    assert.equal(V.listenPortState('2222', 'tcp', used, []), 'taken');
    assert.equal(V.listenPortState('2222', 'udp', used, []), 'free');
    assert.equal(V.listenPortState('8080', 'tcp', used, [8080]), 'reserved');
    assert.equal(V.listenPortState('8000-8100', 'tcp', used, [8080]), 'reserved');
    assert.equal(V.listenPortState('99999', 'tcp', used, []), 'invalid');
    const checks = V.newHostChecks(draft(), zone, { used, blocked: [] });
    assert.deepEqual(checks.map((c) => c.id + ':' + c.state), ['dns:ok', 'gateway:ok', 'cert:ok', 'port_taken:warn']);
    const off = V.newHostChecks(draft({ entries: [{ type: 'udp', outer: '5353', port: '53' }] }), Object.assign({}, zone, { verification: 'pending', gateway: { kind: 'gateway', name: 'gw', online: false } }), { used, blocked: [] });
    assert.deepEqual(off.map((c) => c.id + ':' + c.state), ['dns:warn', 'gateway:warn', 'port_free:ok']);
  });
});

describe('entry editor: "Weg der Verbindung"', () => {
  it('entryFlow: outside port → GateControl → (sign-in) → gateway → LAN target', () => {
    const steps = V.entryFlow({ external: true, kind: 'http', fqdn: 'nas.example.com', auth: 'route', target: { kind: 'gateway', name: 'home-gw' }, lanHost: '192.168.2.30', port: '5001' });
    assert.deepEqual(steps.map((s) => s.id), ['in', 'gc', 'auth', 'gw', 'lan']);
    assert.equal(steps[0].value, ':443');
    assert.equal(steps[0].kicker, 'internet');
    assert.equal(steps[4].value, '192.168.2.30 : 5001');
    const l4 = V.entryFlow({ external: false, kind: 'tcp', outer: '2222', auth: 'basic', target: { kind: 'peer' }, lanHost: '10.8.0.5', port: '22' });
    assert.deepEqual(l4.map((s) => s.id), ['in', 'gc', 'lan'], 'no sign-in step for TCP, no gateway step for peers');
    assert.equal(l4[0].kicker, 'vpn');
    assert.equal(l4[2].kicker, 'peer');
  });
});

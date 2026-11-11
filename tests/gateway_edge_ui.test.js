'use strict';

// Gateway detail › tabs "Edge-Plugins" and "MQTT" (public/js/gateway-edge.js +
// the pure helpers in public/js/gateway-edge-kit.js). The helpers mirror rules
// of the server — checked here against the server code itself — and the page
// delivers every text the tabs need. The browser behaviour (tabs in the address,
// all states, capabilities dialog with 409, password exactly once) is
// tests/e2e/scenarios/18-gateway-edge.js.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../public/js/gateway-edge-kit.js');
const edgeManifest = require('../src/services/edge/manifest');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const EDGE_JS = read('public/js/gateway-edge.js');
const KIT_JS = read('public/js/gateway-edge-kit.js');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

describe('gateway-edge-kit: address and states', () => {
  it('#gw/<id>[/edge|/mqtt] ↔ { id, tab }; anything else is not a detail address', () => {
    assert.deepEqual(K.parseHash('#gw/12'), { id: '12', tab: 'overview' });
    assert.deepEqual(K.parseHash('#gw/12/edge'), { id: '12', tab: 'edge' });
    assert.deepEqual(K.parseHash('#gw/12/mqtt'), { id: '12', tab: 'mqtt' });
    assert.deepEqual(K.parseHash('#gw/12/features'), { id: '12', tab: 'features' });
    assert.deepEqual(K.parseHash('#gw/12/nope'), { id: '12', tab: 'overview' });
    assert.equal(K.parseHash('#add'), null);
    assert.equal(K.parseHash('#setup/3'), null);
    assert.equal(K.hashFor(12, 'overview'), '#gw/12');
    assert.equal(K.hashFor(12, 'edge'), '#gw/12/edge');
    assert.equal(K.hashFor('a/b', 'mqtt'), '#gw/a%2Fb/mqtt');
    assert.deepEqual(K.parseHash(K.hashFor('a/b', 'mqtt')), { id: 'a/b', tab: 'mqtt' });
  });

  it('gateways.js keeps #add / #setup/<id> and routes the tabs', () => {
    const src = read('public/js/gateways.js');
    assert.match(src, /h\.match\(\/\^#gw\\\/\(\[\^\/\]\+\)\(\?:\\\/\(\[a-z\]\+\)\)\?\$\/\)/);
    assert.match(src, /var TAB_NAMES = \['features', 'net', 'inet', 'dns', 'cache', 'radio', 'edge', 'mqtt'\];/);
    assert.match(src, /TAB_NAMES\.indexOf\(m\[2\]\) >= 0/);
    // the pool page #pool/<id> (gateway-pool-kit.js parsePoolHash)
    assert.match(src, /PK\.parsePoolHash\(h\)/);
    assert.match(src, /if \(h === '#add'\)/);
    assert.match(src, /h\.match\(\/\^#setup\\\/\(\\d\+\)\$\/\)/);
  });

  const settings = { edgeEnabled: true, allowUnsignedEdge: false };
  const p = (state, extra) => ({ id: 'x', name: 'X', verified: true, edge: { capabilities: [] }, assignment: state ? { state, enabled: true, approved: { capabilities: [] }, newCapabilities: [] } : null, ...extra });

  it('every state the server reports has a tone and a text (de + en)', () => {
    // the states of services/edge/index.js stateOf / state.js evaluate / hub.js STATES
    const server = ['running', 'starting', 'crashed', 'stopped', 'denied', 'update_pending', 'pending', 'offline', 'disabled', 'unsigned',
      'plugin_off', 'gateway_too_old', 'edge_off', 'no_edge'];
    for (const s of server) {
      const v = K.pluginState(p(s), settings);
      assert.equal(v.state, s);
      assert.ok(['green', 'blue', 'red', 'amber', 'grey'].includes(v.tone), s);
      assert.ok(de[v.key] && en[v.key], v.key);
    }
    const hub = /const STATES = new Set\(\[([^\]]+)\]\)/.exec(read('src/services/edge/hub.js'))[1];
    for (const s of hub.match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1))) assert.ok(K.STATES.includes(s), s);
    const reasons = read('src/services/edge/state.js').match(/reason = '([a-z_]+)'/g).map((x) => x.split("'")[1]);
    for (const s of reasons) assert.ok(K.STATES.includes(s), s);
  });

  it('offline with a reason (services/edge/reason.js) shows the reason: tone, label and explanation (de + en)', () => {
    assert.deepEqual(K.REASONS, require('../src/services/edge/reason').REASONS);
    for (const r of K.REASONS) {
      const v = K.pluginState(p('offline', { assignment: { state: 'offline', reason: r, enabled: true, approved: { capabilities: [] }, newCapabilities: [] } }), settings);
      assert.equal(v.state, r);
      assert.ok(['red', 'amber', 'grey'].includes(v.tone), r);
      assert.ok(de['gwe.state.' + r] && en['gwe.state.' + r], r);
      assert.ok(de['gwe.state_d.' + r] && en['gwe.state_d.' + r], r);
    }
    // unknown or no reason (older server, older gateway): the plain offline
    assert.equal(K.pluginState(p('offline'), settings).state, 'offline');
    const odd = p('offline');
    odd.assignment.reason = 'something_new';
    assert.equal(K.pluginState(odd, settings).state, 'offline');
  });

  it('isolation chip: isolated (gateway >= 1.23.0), fence, compose outdated, older gateways', () => {
    assert.deepEqual(K.boundaryState(null), { key: 'gwe.edge.fence_unknown', tone: '', backend: null, composeOutdated: false });
    assert.equal(K.boundaryState({ isolation: { mode: 'isolated', active: true }, fence: { active: true, backend: 'isolated' } }).key, 'gwe.edge.isolated');
    assert.equal(K.boundaryState({ isolation: { mode: 'isolated', active: false }, fence: { active: false } }).key, 'gwe.edge.isolation_off');
    assert.deepEqual(K.boundaryState({ isolation: { mode: 'fence', active: true }, fence: { active: true, backend: 'nft' } }),
      { key: 'gwe.edge.fence_on', tone: 'ok', backend: 'nft', composeOutdated: false });
    assert.deepEqual(K.boundaryState({ isolation: { mode: 'fence', active: false }, fence: { active: false, backend: null } }),
      { key: 'gwe.edge.compose_outdated', tone: 'bad', backend: null, composeOutdated: true });
    // older gateway: only the fence
    assert.equal(K.boundaryState({ fence: { active: false } }).key, 'gwe.edge.fence_off');
    // an edge part with MQTT capability, switched on, broker off → hint with the button
    const mq = { edge: { capabilities: [{ key: 'mqtt:shellies/#', text: 'x' }] }, assignment: { enabled: true } };
    assert.equal(K.needsMqtt(mq, { mqttEnabled: false }), true);
    assert.equal(K.needsMqtt(mq, { mqttEnabled: true }), false);
    assert.equal(K.needsMqtt({ ...mq, assignment: { enabled: false } }, { mqttEnabled: false }), false);
    assert.equal(K.needsMqtt({ edge: { capabilities: [{ key: 'http:lan', text: 'x' }] }, assignment: { enabled: true } }, {}), false);
    // without an isolation report the edge container is older than gateway 1.23.0: update first, then compose
    assert.equal(K.boundaryState({ fence: { active: false } }).updateFirst, true);
    assert.equal(K.boundaryState({ isolation: { mode: 'isolated', active: true }, fence: { active: true } }).updateFirst, undefined);
    assert.equal(K.boundaryState({ fence: { active: true, backend: 'iptables' } }).backend, 'iptables');
    for (const k of ['gwe.edge.isolated', 'gwe.edge.isolation_off', 'gwe.edge.compose_outdated', 'gwe.edge.compose_outdated_text']) assert.ok(de[k] && en[k], k);
  });

  it('the guide for a reason: the user guide in the language of the page, edge_missing per platform', () => {
    const de = 'https://github.com/CallMeTechie/gatecontrol/blob/master/docs/handbuch/';
    const en = 'https://github.com/CallMeTechie/gatecontrol/blob/master/docs/guide/';
    assert.equal(K.reasonDoc('edge_missing', 'synology', 'de'), de + '06-gateway-aktualisieren.md#63-synology-compose-datei-erneuern');
    assert.equal(K.reasonDoc('edge_missing', 'synology', 'en'), en + '06-updating-a-gateway.md#63-synology-renewing-the-compose-file');
    assert.equal(K.reasonDoc('edge_missing', 'linux', 'de'), de + '06-gateway-aktualisieren.md#64-linuxdocker-compose-datei-erneuern');
    assert.equal(K.reasonDoc('edge_missing', 'proxmox', 'de'), de + '03-gateway-einrichten.md#35-proxmox');
    assert.equal(K.reasonDoc('edge_missing', 'rpi', 'en'), en + '04-edge-and-smart-home.md#edge-service-missing');
    assert.equal(K.reasonDoc('edge_missing', null, 'de'), de + '06-gateway-aktualisieren.md#62-warum-die-compose-datei-extra-dran-ist');
    assert.equal(K.reasonDoc('edge_fence', 'synology', 'de'), de + '04-edge-und-smart-home.md#netzgrenze-fehlt');
    assert.equal(K.reasonDoc('compose_outdated', 'synology', 'de'), de + '06-gateway-aktualisieren.md#63-synology-compose-datei-erneuern');
    assert.equal(K.reasonDoc('compose_outdated', 'rpi', 'en'), en + '04-edge-and-smart-home.md#compose-file-outdated');
    assert.equal(K.reasonDoc('compose_outdated', null, 'de'), de + '04-edge-und-smart-home.md#compose-datei-veraltet');
    assert.equal(K.reasonDoc('edge_not_running', 'rpi', 'en'), en + '04-edge-and-smart-home.md#edge-container-not-running');
    assert.equal(K.reasonDoc('edge_not_connected'), de + '04-edge-und-smart-home.md#edge-erreicht-gatecontrol-nicht');
    assert.equal(K.reasonDoc('gateway_offline', 'synology', 'en'), en + '04-edge-and-smart-home.md#gateway-offline');
    assert.equal(K.reasonDoc('offline'), null);
    // the topic itself (public/js/handbook.js) — gateway-edge.js opens it in the handbook inside the app
    assert.equal(K.reasonTopic('edge_missing', 'synology'), 'update.synology');
    assert.equal(K.reasonTopic('edge_missing', 'rpi'), 'edge.edge_missing');
    assert.equal(K.reasonTopic('edge_missing', null), 'update');
    assert.equal(K.reasonTopic('compose_outdated', 'linux'), 'update.linux');
    assert.equal(K.reasonTopic('edge_fence', 'synology'), 'edge.edge_fence');
    assert.equal(K.reasonTopic('offline'), null);
    assert.equal(K.reasonTopic('toString'), null);
    assert.equal(K.reasonDoc('toString'), null);
    for (const r of K.REASONS) assert.ok(K.reasonDoc(r, null, 'de') && K.reasonDoc(r, null, 'en'), r);
  });

  it('a plugin not set up here: edge off → edge_off, unsigned and not allowed → unsigned (blocked switch), else not_set_up', () => {
    assert.equal(K.pluginState(p(null), { edgeEnabled: false }).state, 'edge_off');
    assert.equal(K.pluginState(p(null, { verified: false }), settings).state, 'unsigned');
    assert.equal(K.pluginControl(p(null, { verified: false }), settings), 'blocked');
    assert.equal(K.pluginState(p(null, { verified: false }), { edgeEnabled: true, allowUnsignedEdge: true }).state, 'not_set_up');
    assert.equal(K.pluginState(p(null), settings).state, 'not_set_up');
    assert.equal(K.pluginControl(p(null), settings), 'switch');
    assert.equal(K.pluginControl(p('update_pending'), settings), 'review');
    // switched on before the gateway stopped allowing unsigned parts: it can still be switched off
    assert.equal(K.pluginControl(p('unsigned', { verified: false }), settings), 'switch');
  });

  it('summary: installed, running, needing attention, switched on', () => {
    const s = K.summary([p('running'), p('update_pending'), p('crashed'), p(null), p('disabled', { assignment: { state: 'disabled', enabled: false } })], settings);
    assert.deepEqual(s, { installed: 5, running: 1, attention: 2, enabled: 3 });
  });
});

describe('gateway-edge-kit: capabilities', () => {
  const caps = { mdns: { services: ['_shelly._tcp'] }, http: { lan: true }, tcp: { lan: true } };
  const described = edgeManifest.describe(caps, 'de');

  it('the dialog confirms exactly the server\'s current list (capabilityList)', () => {
    const plugin = { edge: { capabilities: described }, assignment: null };
    assert.deepEqual(K.capabilityKeys(plugin), edgeManifest.capabilityList(caps));
    assert.ok(K.capabilityRows(plugin).every((r) => r.mark === null), 'first approval: no marks');
    assert.ok(K.capabilityRows(plugin).every((r) => r.warning === false), 'no capability carries a warning at the moment');
    // a capability the server marks with `warning` is shown as such (generic, no special case)
    const warned = K.capabilityRows({ edge: { capabilities: [{ key: 'x.y', text: 'X', warning: true }] } });
    assert.equal(warned[0].warning, true);
  });

  it('after an update: new ones marked "neu", approved ones "bisher"', () => {
    const approved = ['mdns:_shelly._tcp'];
    const plugin = { edge: { capabilities: described },
      assignment: { approved: { capabilities: approved }, newCapabilities: described.filter((c) => !approved.includes(c.key)) } };
    const rows = K.capabilityRows(plugin);
    assert.deepEqual(rows.map((r) => [r.key, r.mark]), [['http.lan', 'new'], ['mdns:_shelly._tcp', 'prior'], ['tcp.lan', 'new']]);
  });
});

describe('gateway-edge-kit: RAM hint (a hint, never a ban)', () => {
  it('1 GB: about 4 plugins fit; more is "tight"; unknown RAM → no hint', () => {
    assert.deepEqual(K.memoryHint(1024 ** 3, 2), { memMb: 1024, plugins: 2, max: 4, tight: false });
    assert.equal(K.memoryHint(1024 ** 3, 5).tight, true);
    assert.equal(K.memoryHint(512 * 1024 ** 2, 0).max, 1);
    assert.equal(K.memoryHint(8 * 1024 ** 3, 10).tight, false);
    assert.equal(K.memoryHint(null, 1), null);
    assert.equal(K.ramLabel(1024), '1 GB');
    assert.equal(K.ramLabel(512), '512 MB');
  });
});

describe('gateway-edge-kit: MQTT accounts as the server takes them', () => {
  const mqtt = require('../src/services/edge/mqtt');

  it('user names: the same rule as services/edge/mqtt.js (incl. reserved names)', () => {
    for (const u of ['shelly-flur', 'a1', 'esp.test_2', 'x'.repeat(48), 'A', 'a', '-a', 'a b', 'x'.repeat(49), 'gc-edge', 'admin', 'root', '', 'Shelly']) {
      let server = true;
      try { mqtt.checkUser(u); } catch { server = false; }
      assert.equal(K.usernameProblem(u) === null, server, u);
    }
  });

  it('topic filters: the same rule as services/edge/manifest.js topicFilterOk', () => {
    for (const t of ['shellies/announce', 'a/+/b', 'a/#', '#', '+/a', '$SYS/x', 'a//b', 'a/#/b', 'a/b+', 'x'.repeat(129), 'tasmota/x/#', 'a\nb', 'a']) {
      assert.equal(K.topicOk(t), edgeManifest.topicFilterOk(t), JSON.stringify(t));
    }
  });

  it('device templates: vendor prefixes the server accepts; the body adds devices/<user>/# and extra topics', () => {
    for (const tp of K.TEMPLATES) {
      if (tp.vendorPrefix) assert.match(tp.vendorPrefix, /^[A-Za-z0-9_-]{1,32}$/);
      assert.ok(de['gwe.mqtt.tpl.' + tp.id] && en['gwe.mqtt.tpl_d.' + tp.id], tp.id);
    }
    assert.deepEqual(K.TEMPLATES.map((x) => x.id), ['shelly', 'tasmota', 'esphome', 'homeassistant', 'custom']);
    const body = K.accountBody('shelly', 'shelly-flur', 'Flur', [{ topic: 'shellies/announce', access: 'read' }]);
    assert.deepEqual(body, { username: 'shelly-flur', label: 'Flur', topics: [{ topic: 'devices/shelly-flur/#', access: 'readwrite' }, { topic: 'shellies/announce', access: 'read' }], vendorPrefix: 'shellies' });
    assert.equal(K.accountBody('custom', 'dev1', '', []).vendorPrefix, undefined);
    // what the dialog shows before creating = what the server will store (normaliseAcl + vendor topic)
    const acl = mqtt.normaliseAcl(body.topics);
    acl.push({ access: 'readwrite', topic: `${body.vendorPrefix}/${body.username}/#` });
    const planned = K.plannedTopics('shelly', 'shelly-flur', [{ topic: 'shellies/announce', access: 'read' }]);
    assert.deepEqual(planned.map((x) => x.topic).sort(), acl.map((x) => x.topic).sort());
    assert.equal(K.ACCOUNTS_MAX, mqtt.ACCOUNTS_PER_GATEWAY);
  });

  it('topic prefix for the device, broker address and status', () => {
    assert.equal(K.topicPrefix({ username: 'shelly-flur', acl: [{ topic: 'devices/shelly-flur/#' }, { topic: 'shellies/shelly-flur/#' }] }), 'shellies/shelly-flur');
    assert.equal(K.topicPrefix({ username: 'dev1', acl: [{ topic: 'devices/dev1/#' }] }), 'devices/dev1');
    assert.equal(K.brokerAddress('192.168.1.23', false), '192.168.1.23:1883');
    assert.equal(K.brokerAddress('192.168.1.23', true), '192.168.1.23:8883');
    assert.equal(K.brokerAddress(null), null);
    // TLS on port 8883: the fingerprint as devices show it; an older gateway locks the switch (only while it is off)
    const fp = 'efcc6bcba293fa77e8c2a59f5e8c5dfb3d4673e5174905628a2e201e98e84853';
    assert.equal(K.fingerprintText(fp), 'EF:CC:6B:CB:A2:93:FA:77:E8:C2:A5:9F:5E:8C:5D:FB:3D:46:73:E5:17:49:05:62:8A:2E:20:1E:98:E8:48:53');
    for (const bad of [null, '', 'abc', fp + '00', 'zz'.repeat(32)]) assert.equal(K.fingerprintText(bad), null);
    const can = { mqttTlsSupported: true };
    const old = { mqttTlsSupported: false };
    assert.deepEqual(K.tlsView({ mqttTls: false }, null, can), { key: 'off', locked: false, fingerprint: null, cert: null, validTo: null });
    assert.deepEqual(K.tlsView({ mqttTls: false }, null, null), { key: 'off', locked: false, fingerprint: null, cert: null, validTo: null }, 'a gateway that never connected: nothing locked');
    assert.deepEqual(K.tlsView({ mqttTls: false }, { tls: 'off' }, old), { key: 'update_needed', locked: true, fingerprint: null, cert: null, validTo: null });
    assert.equal(K.tlsView({ mqttTls: true }, { tls: 'missing_cert' }, old).key, 'update_needed');
    assert.equal(K.tlsView({ mqttTls: true }, { tls: 'missing_cert' }, old).locked, false, 'switching it off again always works');
    assert.equal(K.tlsView({ mqttTls: true }, { tls: 'missing_cert' }, can).key, 'missing_cert');
    assert.equal(K.tlsView({ mqttTls: true }, null, can).key, 'pending');
    assert.equal(K.tlsView({ mqttTls: true }, { tls: 'off' }, can).key, 'pending');
    assert.deepEqual(K.tlsView({ mqttTls: true }, { tls: 'on', tlsSha256: fp, tlsCert: 'PEM', tlsValidTo: '2036-11-08T11:16:10.000Z' }, can),
      { key: 'on', locked: false, fingerprint: K.fingerprintText(fp), cert: 'PEM', validTo: '2036-11-08T11:16:10.000Z' });
    assert.deepEqual(K.tlsView({ mqttTls: true }, { tls: 'on' }, can), { key: 'on', locked: false, fingerprint: null, cert: null, validTo: null }, 'an older status without the fingerprint');
    for (const k of ['pending', 'update_needed', 'update_needed_d', 'k_fp', 'copy_fp', 'k_cert', 'cert_self', 'cert_self_until', 'copy_cert', 'fp_hint', 'text', 'cert_note', 'missing_cert_d']) {
      assert.ok(de['gwe.tls.' + k] && en['gwe.tls.' + k], 'gwe.tls.' + k);
    }
    assert.match(de['gwe.tls.text'], /Shelly.*Tasmota/);
    assert.match(de['gwe.tls.text'], /1883 bleibt/);
    assert.match(de['gwe.tls.update_needed'], /Gateway-Update nötig/);
    assert.equal(K.brokerStatus({ mqttEnabled: false }).key, 'off');
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: false }).key, 'waits_edge');
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, null, false).key, 'offline');
    assert.deepEqual(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, null, false, 'edge_missing'), { key: 'offline', tone: 'amber', reason: 'edge_missing' });
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, null, false, 'whatever').reason, undefined);
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, null, true, 'edge_missing').key, 'pending');
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, null, true).key, 'pending');
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, { running: true }, true).key, 'running');
    assert.equal(K.brokerStatus({ mqttEnabled: true, edgeEnabled: true }, { running: false }, true).key, 'stopped');
    const st = { accounts: [{ user: 'a', connected: true }] };
    assert.equal(K.accountStatus({ username: 'a', locked: true }, st).key, 'locked');
    assert.equal(K.accountStatus({ username: 'a', locked: false }, st).key, 'connected');
    assert.equal(K.accountStatus({ username: 'b', locked: false }, st).key, 'idle');
  });
});

describe('gateway-edge: texts and errors', () => {
  it('every error code of the admin API has an understandable text (de + en)', () => {
    const api = read('src/routes/api/edge.js');
    const codes = new Set(['session_required', 'internal']);
    for (const m of /const STATUS = \{([\s\S]*?)\};/.exec(api)[1].matchAll(/([a-z_]+):\s*\d{3}/g)) codes.add(m[1]);
    for (const c of codes) {
      const key = K.errorKey(c, 400);
      if (c !== 'internal') assert.notEqual(key, 'gwe.err.internal', c);
      assert.ok(de[key] && en[key], key);
    }
    assert.equal(K.errorKey('whatever', 500), 'gwe.err.internal');
    assert.equal(K.errorKey(null, 403), 'gwe.err.forbidden');
  });

  it('every gwe.* key the two scripts use exists in de.json and en.json with the same placeholders', () => {
    const used = new Set();
    for (const m of (EDGE_JS + KIT_JS).matchAll(/'(gwe\.[A-Za-z0-9_.]*[A-Za-z0-9])'/g)) used.add(m[1]);
    const families = [...K.TABS.map((x) => 'gwe.tabs.' + x), ...K.ACCESS.map((x) => 'gwe.mqtt.access.' + x), ...K.LOG_FILTERS.map((f) => 'gwe.log.f.' + f.id),
      ...['off', 'waits_edge', 'offline', 'pending', 'running', 'stopped'].map((x) => 'gwe.mqtt.status.' + x),
      ...['locked', 'connected', 'idle'].map((x) => 'gwe.mqtt.acc.' + x), 'gwe.mqtt.new.src_template', 'gwe.mqtt.new.src_always',
      ...['denied', 'unsigned', 'plugin_off', 'offline', 'pending', 'not_set_up', 'disabled', 'stopped'].map((x) => 'gwe.state_d.' + x),
      ...K.REASONS.map((x) => 'gwe.state.' + x), ...K.REASONS.map((x) => 'gwe.state_d.' + x)];
    families.forEach((k) => used.add(k));
    const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join();
    for (const k of used) {
      assert.ok(k in de && k in en, k);
      assert.equal(ph(de[k]), ph(en[k]), k);
    }
    // the typed confirmation word is one the server accepts
    const { CONFIRM_WORDS } = require('../src/services/edge');
    assert.ok(CONFIRM_WORDS.has(de['gwe.uns.word']) && CONFIRM_WORDS.has(en['gwe.uns.word']));
  });

  it('no innerHTML, no browser dialogs, destructive confirmations in red', () => {
    const src = stripComments(EDGE_JS);
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.doesNotMatch(src, /(?<![.\w$])(confirm|alert|prompt)\s*\(/);
    for (const key of ['gwe.edge.off_msg', 'gwe.mqtt.delete_msg', 'gwe.mqtt.pw_msg']) {
      const i = src.indexOf(key);
      assert.ok(i > 0, key);
      assert.match(src.slice(Math.max(0, i - 200), i + 250), /danger: true/, key);
    }
    // switches as the project builds them
    assert.match(src, /class: 'st-switch gwe-switch', role: 'switch', 'aria-checked'/);
  });

  it('the password lives only in the dialog that shows it', () => {
    const src = stripComments(EDGE_JS);
    const i = src.indexOf('function passwordDialog');
    const body = src.slice(i, src.indexOf('// ─── Public', i));
    assert.match(body, /dlg\.promise\.then\(\(\) => \{ pwNode\.textContent = ''; secret = null; \}\)/);
    assert.doesNotMatch(src, /localStorage|sessionStorage/);
    assert.doesNotMatch(src, /setAttribute\([^)]*(password|secret)/i);
  });
});

describe('gateway page', () => {
  let agent;
  before(async () => {
    const { setup } = require('./helpers/setup');
    ({ agent } = await setup());
  });
  after(() => require('./helpers/setup').teardown());

  it('loads the edge scripts after the kit and before gateways.js; the island brings gwe.*', async () => {
    const html = (await agent.get('/gateways').expect(200)).text;
    const at = (s) => html.indexOf(s);
    assert.ok(at('/js/gateway-edge-kit.js') > 0 && at('/js/gateway-edge-kit.js') < at('/js/gateway-edge.js') && at('/js/gateway-edge.js') < at('/js/gateways.js?'));
    const m = /<script type="application\/json" id="gwiz-i18n" data-prefixes="([^"]+)"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'island');
    assert.ok(m[1].split(' ').includes('gwe.'));
    const island = JSON.parse(m[2]);
    assert.ok(island['gwe.tabs.edge'] && island['gwe.caps.read'] && island['gwe.mqtt.new.title'] && island['gwe.uns.word']);
    assert.ok(island['gwiz.add'] && island['common.cancel'], 'the assistant keeps its strings');
  });
});

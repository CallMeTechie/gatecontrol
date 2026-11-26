'use strict';

// Edge parts of plugins on home gateways and the gateways' MQTT brokers —
// the rules (docs/plugins.md "Edge part"). Used by the admin API
// (routes/api/edge.js), the gateway endpoints (routes/api/gateway.js), the
// plugin lifecycle (plugins/index.js) and the host API (gc.edge, gc.mqtt).
//
//   gateway switches     edgeEnabled, mqttEnabled, mqttTls, allowUnsignedEdge (with confirmation)
//   plugin × gateway     enable with the explicit list of capabilities shown, disable;
//                        an update that needs new capabilities leaves it off (update_pending)
//                        until an administrator confirms again
//   optional rights      edge.optionalCapabilities: confirmed or revoked one by one per gateway
//                        (approveOptional / revokeOptional); a plugin asks for one with
//                        gc.edge.requestCapability — one note in the activity log per key and day
//   MQTT accounts        per gateway; the password is shown once, only its hash is kept

const store = require('./store');
const stateLib = require('./state');
const hub = require('./hub');
const mqtt = require('./mqtt');
const edgeManifest = require('./manifest');
const channelReason = require('./reason');
const logger = require('../../utils/logger');

const CONFIRM_WORDS = new Set(['ERLAUBEN', 'ALLOW']);
const METHOD_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONFIGURE_MAX = 48 * 1024;
const PLUGIN_USER_RE = /^[a-z0-9][a-z0-9_.-]{0,23}$/;
// gc.edge.requestCapability: at most one note per plugin × gateway × key in this time
const REQUEST_EVERY_MS = 24 * 60 * 60 * 1000;
const OPTIONAL_KEY_MAX = 200;

class EdgeAdminError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
}

function activity() { return require('../activity'); }
function registry() { return require('../plugins/registry'); }
function loc(text, lang) { return require('../plugins/manifest').loc(text, lang); }

function log(type, message, opts) {
  try { activity().log(type, message, opts); } catch (e) { logger.warn({ err: e.message, type }, 'edge activity not written'); }
}

function needGateway(peerId) {
  const g = store.gatewayPeer(peerId);
  if (!g) throw new EdgeAdminError('not_found', 'gateway not found');
  return g;
}

function edgePlugin(pluginId) {
  const p = typeof pluginId === 'string' ? registry().get(pluginId) : null;
  if (!p) throw new EdgeAdminError('plugin_not_found', 'plugin not installed');
  if (!p.manifest || !p.manifest.edge) throw new EdgeAdminError('no_edge', 'the plugin has no edge part');
  return p;
}

/**
 * What the assignment amounts to right now (for the UI and gc.edge.gateways).
 * 'offline': the edge channel is down — channelOf() says why (reason.js).
 */
function stateOf(a, settings, connected) {
  if (!settings.edgeEnabled) return 'edge_off';
  const v = stateLib.evaluate(a, settings);
  if (!v) return 'no_edge';
  if (v.reason) return v.reason;
  if (!connected) return 'offline';
  return a.status && a.status.state ? a.status.state : 'pending';
}

/** chan: channelOf() — `reason` only goes with state 'offline' (why the channel is down; null = unknown). */
function assignmentView(a, settings, chan, lang) {
  const p = registry().get(a.pluginId);
  const edge = p && p.manifest ? p.manifest.edge : null;
  const state = stateOf(a, settings, chan.online);
  return {
    pluginId: a.pluginId,
    enabled: a.enabled,
    state,
    reason: state === 'offline' ? chan.reason : null,
    approved: { capabilities: a.capsList, version: a.capsVersion, at: a.approvedAt ? new Date(a.approvedAt).toISOString() : null, by: a.approvedBy },
    newCapabilities: edge ? edgeManifest.describe(edge.capabilities, lang).filter((x) => !a.capsList.includes(x.key) && !(a.optCapsList || []).includes(x.key)) : [],
    optional: edge ? optionalView(edge, a, lang, settings) : [],
    status: a.status || null,
  };
}

/**
 * [{ key, text, approved, requestedAt, gatewaySupported, minGateway }] — the plugin's optional capabilities on this gateway
 * („Zusätzliche Rechte (optional)“). gatewaySupported false: the gateway is too old to apply this key (minGateway or newer).
 */
function optionalView(edge, a, lang, settings) {
  const approved = new Set(edgeManifest.approvedOptional(edge, a.optCapsList));
  const req = a.optRequests && typeof a.optRequests === 'object' ? a.optRequests : {};
  const list = edgeManifest.describe(edge.optionalCapabilities, lang);
  const hb = list.length && a.peerId ? heartbeatOf(a.peerId) : { seenAt: null, telemetry: null };
  return list.map((x) => ({
    ...x, approved: approved.has(x.key),
    requestedAt: !approved.has(x.key) && Number.isFinite(req[x.key]) ? new Date(req[x.key]).toISOString() : null,
    gatewaySupported: optionalKeySupported(x.key, settings, hb), minGateway: optionalMinGateway(x.key),
  }));
}

function pluginEdgeView(p, lang) {
  const e = p.manifest.edge;
  return {
    id: p.id, name: loc(p.manifest.name, lang), version: p.version, verified: p.signature === 'trusted', signature: p.signature, enabled: p.enabled,
    edge: { memoryMb: e.memoryMb, minGateway: e.minGateway, capabilities: edgeManifest.describe(e.capabilities, lang),
      optionalCapabilities: edgeManifest.describe(e.optionalCapabilities, lang) },
  };
}

function helloView(s) {
  return s.hello ? { version: s.hello.version || null, edgeHost: s.hello.edgeHost || null, mqttAvailable: !!(s.hello.mqtt && s.hello.mqtt.available),
    // can this gateway offer TLS on port 8883 (it makes the certificate itself)? Older gateways: "Gateway-Update nötig"
    mqttTlsSupported: !!(s.hello.mqtt && s.hello.mqtt.tlsCert),
    fence: s.hello.fence || null, isolation: s.hello.isolation || null, hardware: s.hello.hardware || null, at: s.helloAt ? new Date(s.helloAt).toISOString() : null } : null;
}

// the first gateway release with the edge container and the MQTT broker (gatecontrol-gateway, compose
// services edge + mqtt): older gateways never open the edge channel — the UI offers an update instead
const EDGE_MIN_GATEWAY = '1.19.0';
// the first gateway release whose edge container runs without network (compose network_mode: none, all I/O
// through the gateway socket, no network fence / xt_owner): with an older compose file (edge in the host
// network) and no fence the UI asks for the current compose file (reason compose_outdated)
const EDGE_ISOLATED_MIN_GATEWAY = '1.23.0';
// the first gateway release that reads edge.optionalCapabilities (feature `edge-optional-caps` in the hello's
// gw.features and in telemetry.capabilities): older gateways run the edge part but refuse the confirmed
// optional topics (`denied`) — the page says "Gateway zu alt – bitte aktualisieren" instead
const EDGE_OPTIONAL_FEATURE = edgeManifest.OPTIONAL_FEATURE_MQTT;
const EDGE_OPTIONAL_MIN_GATEWAY = '1.46.0';
// the first gateway release that also applies optional tcp.lan, udp.port:<n> and udp.broadcast (feature
// `edge-optional-lan`, with UDP broadcast and 64 TCP connections per plugin): older ones refuse a package that
// declares them — the page and gc.edge.capabilities say "Gateway zu alt" for these keys
const EDGE_OPTIONAL_LAN_FEATURE = edgeManifest.OPTIONAL_FEATURE_LAN;
const EDGE_OPTIONAL_LAN_MIN_GATEWAY = '1.48.0';

/**
 * Does this gateway name `feature` in its hello (gw.features) or its heartbeat (telemetry.capabilities)?
 * true / false (it reports a hello or a capability list without it: an older gateway) / null (nothing known yet).
 * `s`: store.settings(), `hb`: heartbeatOf().
 */
function featureSupported(feature, s, hb) {
  const feats = s && s.hello && Array.isArray(s.hello.features) ? s.hello.features : null;
  const caps = hb && hb.telemetry && Array.isArray(hb.telemetry.capabilities) ? hb.telemetry.capabilities : null;
  if ((feats && feats.includes(feature)) || (caps && caps.includes(feature))) return true;
  return s && s.hello ? false : (caps ? false : null);
}

/** Does this gateway apply confirmed optional MQTT topics (`edge-optional-caps`)? See featureSupported. */
function optionalCapsSupported(s, hb) { return featureSupported(EDGE_OPTIONAL_FEATURE, s, hb); }

/** Does this gateway apply confirmed optional tcp.lan / udp.port / udp.broadcast (`edge-optional-lan`)? */
function optionalLanSupported(s, hb) { return featureSupported(EDGE_OPTIONAL_LAN_FEATURE, s, hb); }

/** Can this gateway apply the optional key? (true / false / null as featureSupported) */
function optionalKeySupported(key, s, hb) { return featureSupported(edgeManifest.optionalFeature(key), s, hb); }

function optionalMinGateway(key) {
  return edgeManifest.optionalFeature(key) === EDGE_OPTIONAL_LAN_FEATURE ? EDGE_OPTIONAL_LAN_MIN_GATEWAY : EDGE_OPTIONAL_MIN_GATEWAY;
}

/**
 * All of `keys` on this gateway: { supported: true/false/null, unsupported: [keys it is too old for] }.
 * false as soon as one key is not supported; null when nothing is known for one and none is refused.
 */
function optionalKeysSupport(keys, s, hb) {
  let supported = true;
  const unsupported = [];
  for (const k of keys) {
    const v = optionalKeySupported(k, s, hb);
    if (v === false) unsupported.push(k);
    else if (v === null && supported === true) supported = null;
  }
  return { supported: unsupported.length ? false : supported, unsupported };
}

/** The gateway's last heartbeat: { seenAt, telemetry } (gateway_meta). */
function heartbeatOf(peerId) {
  try {
    const row = require('../../db/connection').getDb().prepare('SELECT last_seen_at, last_health FROM gateway_meta WHERE peer_id = ?').get(peerId);
    if (!row) return { seenAt: null, telemetry: null };
    let tel = null;
    try {
      const h = row.last_health ? JSON.parse(row.last_health) : null;
      tel = h && h.telemetry && typeof h.telemetry === 'object' ? h.telemetry : null;
    } catch { tel = null; }
    return { seenAt: row.last_seen_at == null ? null : Number(row.last_seen_at), telemetry: tel };
  } catch { return { seenAt: null, telemetry: null }; }
}

// the same threshold as the gateway's own online/offline (gatewayHealth.js, Einstellungen › Gateways)
function downThresholdMs() {
  let n = NaN;
  try { n = parseInt(require('../settings').get('gateway_down_threshold_s', '90'), 10); } catch { n = NaN; }
  return (Number.isFinite(n) && n > 0 ? n : 90) * 1000;
}

/**
 * The edge channel of a gateway: hub.connectionInfo() plus, while it is down,
 * `reason` and `detail` from the heartbeat (reason.js). `hb`: heartbeatOf().
 */
function channelOf(peerId, hb) {
  const conn = hub.connectionInfo(peerId);
  const d = channelReason.diagnose({ online: conn.online, seenAt: hb.seenAt, thresholdMs: downThresholdMs(), telemetry: hb.telemetry, minGateway: EDGE_MIN_GATEWAY });
  return { ...conn, reason: d.reason, detail: d.detail };
}

/** Version and edge support of a gateway from its last heartbeat (telemetry.gateway_version). `hb`: heartbeatOf(). */
function supportView(s, hb) {
  let version = s.hello && s.hello.version ? s.hello.version : null;
  if (!version) {
    const v = hb.telemetry && hb.telemetry.gateway_version;
    version = typeof v === 'string' && v ? v.slice(0, 32) : null;
  }
  const semver = require('../plugins/semver');
  const supported = s.hello ? true : (version && semver.valid(version) ? semver.compare(version, EDGE_MIN_GATEWAY) >= 0 : null);
  const isolatedSupported = version && semver.valid(version) ? semver.compare(version, EDGE_ISOLATED_MIN_GATEWAY) >= 0 : null;
  const mode = (s.hello && s.hello.isolation && s.hello.isolation.mode) || channelReason.modeOf(hb.telemetry);
  return { gatewayVersion: version, edgeSupported: supported, edgeMinGateway: EDGE_MIN_GATEWAY,
    edgeMode: mode || null, isolatedSupported, isolatedMinGateway: EDGE_ISOLATED_MIN_GATEWAY,
    // „Zusätzliche Rechte (optional)“: false → "Gateway zu alt – bitte aktualisieren" (null: not known yet)
    optionalCaps: optionalCapsSupported(s, hb), optionalCapsMinGateway: EDGE_OPTIONAL_MIN_GATEWAY,
    // optional tcp.lan / udp.port / udp.broadcast (Tuya and others): false → "Gateway zu alt" for these keys
    optionalLan: optionalLanSupported(s, hb), optionalLanMinGateway: EDGE_OPTIONAL_LAN_MIN_GATEWAY };
}

function settingsView(s) {
  return { edgeEnabled: s.edgeEnabled, mqttEnabled: s.mqttEnabled, mqttTls: s.mqttTls, allowUnsignedEdge: s.allowUnsignedEdge };
}

/** Every gateway with its edge summary. */
function gateways() {
  return store.gatewayPeers().map((g) => {
    const s = store.settings(g.id);
    const list = store.assignmentsOfGateway(g.id);
    const hb = heartbeatOf(g.id);
    const conn = channelOf(g.id, hb);
    return {
      id: g.id, name: g.name, ...settingsView(s), connection: conn, gateway: helloView(s), support: supportView(s, hb),
      plugins: { assigned: list.length, enabled: list.filter((a) => a.enabled).length,
        attention: list.filter((a) => { const st = stateOf(a, s, conn.online); return ['update_pending', 'crashed', 'denied', 'unsigned', 'gateway_too_old'].includes(st); }).length },
      mqtt: { accounts: mqtt.list(g.id).length, status: s.mqttStatus },
    };
  });
}

/** One gateway: switches, connection, the plugins with an edge part (assigned or not), MQTT. */
function overview(peerId, lang) {
  const g = needGateway(peerId);
  const s = store.settings(g.id);
  const hb = heartbeatOf(g.id);
  const conn = channelOf(g.id, hb);
  const byPlugin = new Map(store.assignmentsOfGateway(g.id).map((a) => [a.pluginId, a]));
  const pluginsList = registry().list().filter((p) => p.manifest && p.manifest.edge).map((p) => {
    const a = byPlugin.get(p.id);
    return { ...pluginEdgeView(p, lang), assignment: a ? assignmentView(a, s, conn, lang) : null };
  });
  return {
    id: g.id, name: g.name, settings: settingsView(s), connection: conn, gateway: helloView(s), support: supportView(s, hb), plugins: pluginsList,
    mqtt: { status: s.mqttStatus, accounts: mqtt.list(g.id) },
    // "Gerätezertifikat verwenden" in the TLS card (services/gatewayFeatures.js; switched there with
    // PUT /api/v1/gateways/:id/features { mqttVpnCert: { enabled } })
    mqttVpnCert: mqttVpnCertOf(g.id),
  };
}

function mqttVpnCertOf(peerId) {
  try { return require('../gatewayFeatures').mqttVpnCertPart(peerId); } catch { return null; }
}

/** A plugin's edge part on every gateway (plugin area). */
function pluginOverview(pluginId, lang) {
  const p = edgePlugin(pluginId);
  const byPeer = new Map(store.assignmentsOfPlugin(p.id).map((a) => [a.peerId, a]));
  return {
    ...pluginEdgeView(p, lang),
    gateways: store.gatewayPeers().map((g) => {
      const s = store.settings(g.id);
      const conn = channelOf(g.id, heartbeatOf(g.id));
      const a = byPeer.get(g.id);
      return { id: g.id, name: g.name, edgeEnabled: s.edgeEnabled, allowUnsignedEdge: s.allowUnsignedEdge, online: conn.online, reason: conn.reason,
        assignment: a ? assignmentView(a, s, conn, lang) : null };
    }),
  };
}

/**
 * Switches of a gateway. allowUnsignedEdge: true needs `confirm` ERLAUBEN/ALLOW.
 * @param {{edgeEnabled?, mqttEnabled?, mqttTls?, allowUnsignedEdge?}} patch
 */
function setSettings(peerId, patch, { confirm, ip, user } = {}) {
  const g = needGateway(peerId);
  const p = patch && typeof patch === 'object' ? patch : {};
  const keys = ['edgeEnabled', 'mqttEnabled', 'mqttTls', 'allowUnsignedEdge'];
  if (!keys.some((k) => p[k] !== undefined)) throw new EdgeAdminError('invalid', 'nothing to change');
  for (const k of keys) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw new EdgeAdminError('invalid', k + ' must be true or false');
  const before = store.settings(g.id);
  if (p.allowUnsignedEdge === true && !before.allowUnsignedEdge && !CONFIRM_WORDS.has(typeof confirm === 'string' ? confirm.trim() : '')) {
    throw new EdgeAdminError('confirm_mismatch', 'type ERLAUBEN to confirm');
  }
  const after = store.setSettings(g.id, p);
  const changed = (k) => before[k] !== after[k];
  const by = { source: 'admin', ipAddress: ip };
  const details = (extra) => ({ peer_id: g.id, ...(user ? { user } : {}), ...extra });
  if (changed('edgeEnabled')) {
    log(after.edgeEnabled ? 'gateway_edge_enabled' : 'gateway_edge_disabled', `Edge parts ${after.edgeEnabled ? 'enabled' : 'disabled'} on gateway "${g.name}"`,
      { ...by, severity: after.edgeEnabled ? 'info' : 'warning', details: details({}) });
  }
  if (changed('allowUnsignedEdge')) {
    log(after.allowUnsignedEdge ? 'gateway_edge_unsigned_allowed' : 'gateway_edge_unsigned_blocked',
      after.allowUnsignedEdge ? `Unsigned edge parts allowed on gateway "${g.name}"` : `Unsigned edge parts no longer allowed on gateway "${g.name}"`,
      { ...by, severity: after.allowUnsignedEdge ? 'warning' : 'info', details: details({}) });
  }
  if (changed('mqttEnabled') || changed('mqttTls')) {
    log(after.mqttEnabled ? 'gateway_mqtt_enabled' : 'gateway_mqtt_disabled',
      `MQTT broker ${after.mqttEnabled ? 'enabled' : 'disabled'} on gateway "${g.name}"${after.mqttEnabled ? (after.mqttTls ? ' (TLS)' : ' (without TLS)') : ''}`,
      { ...by, severity: 'info', details: details({ tls: after.mqttTls }) });
  }
  const diff = keys.filter(changed).map((k) => `${k}=${after[k]}`);
  if (diff.length) store.addLog(g.id, null, 'system', 'info', 'settings: ' + diff.join(', '));
  hub.refresh(g.id);
  return settingsView(after);
}

/**
 * Switch a plugin's edge part on for a gateway. `capabilities`: the keys the
 * administrator saw and confirmed — exactly the plugin's current list
 * (otherwise caps_mismatch with the current list, nothing changes).
 */
function enablePlugin(peerId, pluginId, { capabilities, ip, user, lang } = {}) {
  const g = needGateway(peerId);
  const p = edgePlugin(pluginId);
  const current = edgeManifest.capabilityList(p.manifest.edge.capabilities);
  const shown = Array.isArray(capabilities) ? [...new Set(capabilities.map(String))].sort() : null;
  if (!shown || shown.length !== current.length || shown.some((k, i) => k !== current[i])) {
    throw new EdgeAdminError('caps_mismatch', 'confirm the current list of capabilities', { capabilities: current });
  }
  const s = store.settings(g.id);
  if (p.signature !== 'trusted' && !s.allowUnsignedEdge) throw new EdgeAdminError('unsigned_blocked', 'unsigned edge parts are not allowed on this gateway');
  const prev = store.assignment(p.id, g.id);
  store.approve(p.id, g.id, { caps: p.manifest.edge.capabilities, capsList: current, version: p.version, by: user || null });
  const fresh = !prev || !prev.enabled;
  const added = prev ? current.filter((k) => !prev.capsList.includes(k)) : current;
  log('gateway_edge_plugin_enabled', `Edge part of plugin "${p.name}" ${fresh ? 'enabled' : 'confirmed again'} on gateway "${g.name}"`, {
    source: 'admin', ipAddress: ip, severity: 'info',
    details: { peer_id: g.id, plugin: p.id, version: p.version, capabilities: current, ...(prev ? { added } : {}), ...(user ? { user } : {}) },
  });
  if (added.length) {
    log('gateway_edge_caps_approved', `Capabilities of plugin "${p.name}" approved on gateway "${g.name}": ${added.join(', ')}`, {
      source: 'admin', ipAddress: ip, severity: 'warning', details: { peer_id: g.id, plugin: p.id, version: p.version, capabilities: added },
    });
  }
  store.addLog(g.id, p.id, 'system', 'info', `enabled (v${p.version}; ${current.length} capabilities)`);
  hub.refresh(g.id);
  return assignmentView(store.assignment(p.id, g.id), store.settings(g.id), channelOf(g.id, heartbeatOf(g.id)), lang);
}

function disablePlugin(peerId, pluginId, { ip, user, lang } = {}) {
  const g = needGateway(peerId);
  const a = store.assignment(String(pluginId), g.id);
  if (!a) throw new EdgeAdminError('not_assigned', 'the plugin is not set up for this gateway');
  if (a.enabled) {
    store.setAssignmentEnabled(a.pluginId, g.id, false);
    const p = registry().get(a.pluginId);
    log('gateway_edge_plugin_disabled', `Edge part of plugin "${p ? p.name : a.pluginId}" disabled on gateway "${g.name}"`, {
      source: 'admin', ipAddress: ip, severity: 'warning', details: { peer_id: g.id, plugin: a.pluginId, ...(user ? { user } : {}) },
    });
    store.addLog(g.id, a.pluginId, 'system', 'info', 'disabled');
    hub.refresh(g.id);
  }
  return assignmentView(store.assignment(a.pluginId, g.id), store.settings(g.id), channelOf(g.id, heartbeatOf(g.id)), lang);
}

// ─── Optional capabilities (edge.optionalCapabilities) ─

function needOptional(peerId, pluginId, key) {
  const g = needGateway(peerId);
  const p = edgePlugin(pluginId);
  const a = store.assignment(p.id, g.id);
  if (!a) throw new EdgeAdminError('not_assigned', 'the plugin is not set up for this gateway');
  const k = typeof key === 'string' ? key : '';
  if (!edgeManifest.optionalList(p.manifest.edge).includes(k)) {
    throw new EdgeAdminError('unknown_capability', 'not an optional capability of this plugin', { capabilities: edgeManifest.optionalList(p.manifest.edge) });
  }
  return { g, p, a, key: k };
}

function capText(edge, key, lang) {
  const x = edgeManifest.describe(edge.optionalCapabilities, lang).find((c) => c.key === key);
  return x ? x.text : key;
}

/** Confirm one optional capability of a plugin on a gateway (it reaches the gateway with the next state). */
function approveOptional(peerId, pluginId, { key, ip, user, lang } = {}) {
  const { g, p, a, key: k } = needOptional(peerId, pluginId, key);
  if (!a.optCapsList.includes(k)) {
    store.setOptional(p.id, g.id, [...a.optCapsList, k]);
    const req = { ...(a.optRequests || {}) };
    delete req[k];
    store.setOptionalRequests(p.id, g.id, req);
    log('gateway_edge_optional_approved', `Optional capability of plugin "${p.name}" approved on gateway "${g.name}": ${k}`, {
      source: 'admin', ipAddress: ip, severity: 'warning', details: { peer_id: g.id, plugin: p.id, version: p.version, capability: k, ...(user ? { user } : {}) },
    });
    store.addLog(g.id, p.id, 'system', 'info', `optional capability approved: ${k}`);
    hub.refresh(g.id);
  }
  return assignmentView(store.assignment(p.id, g.id), store.settings(g.id), channelOf(g.id, heartbeatOf(g.id)), lang);
}

/** Take a confirmed optional capability back: the next state leaves it out (the gateway ends its subscriptions). */
function revokeOptional(peerId, pluginId, { key, ip, user, lang } = {}) {
  const g = needGateway(peerId);
  const id = String(pluginId);
  const a = store.assignment(id, g.id);
  if (!a) throw new EdgeAdminError('not_assigned', 'the plugin is not set up for this gateway');
  const k = typeof key === 'string' ? key : '';
  const p = registry().get(id);
  // also a key the installed version no longer declares: an approval must always be revocable
  if (a.optCapsList.includes(k)) {
    store.setOptional(id, g.id, a.optCapsList.filter((x) => x !== k));
    log('gateway_edge_optional_revoked', `Optional capability of plugin "${p ? p.name : id}" revoked on gateway "${g.name}": ${k}`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, plugin: id, capability: k, ...(user ? { user } : {}) },
    });
    store.addLog(g.id, id, 'system', 'info', `optional capability revoked: ${k}`);
    hub.refresh(g.id);
  } else if (!(p && p.manifest && edgeManifest.optionalList(p.manifest.edge).includes(k))) {
    throw new EdgeAdminError('unknown_capability', 'not an optional capability of this plugin');
  }
  return assignmentView(store.assignment(id, g.id), store.settings(g.id), channelOf(g.id, heartbeatOf(g.id)), lang);
}

function logs(peerId, opts = {}) {
  const g = needGateway(peerId);
  const pluginId = opts.plugin === undefined ? undefined : (opts.plugin === '' || opts.plugin === null ? null : String(opts.plugin));
  return store.logs(g.id, { pluginId, limit: opts.limit, before: opts.before, kind: opts.kind });
}

// ─── MQTT accounts (admin) ──────────────────────

function mqttCall(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof mqtt.MqttError) throw new EdgeAdminError(e.code === 'exists' ? 'exists' : (e.code === 'limit' ? 'limit' : 'invalid'), e.message);
    throw e;
  }
}

function mqttAccounts(peerId) { return mqtt.list(needGateway(peerId).id); }

function mqttCreate(peerId, body, { ip, user } = {}) {
  const g = needGateway(peerId);
  const b = body && typeof body === 'object' ? body : {};
  const r = mqttCall(() => mqtt.create(g.id, { username: b.username, label: b.label, topics: b.topics, vendorPrefix: b.vendorPrefix, by: user || 'admin' }));
  log('gateway_mqtt_account_created', `MQTT account "${r.account.username}" created on gateway "${g.name}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, username: r.account.username, topics: r.account.acl.map((x) => x.topic) },
  });
  hub.refresh(g.id);
  return r;
}

function needAccount(g, id) {
  const a = mqtt.get(g.id, id);
  if (!a) throw new EdgeAdminError('account_not_found', 'account not found');
  return a;
}

function mqttSetLocked(peerId, id, locked, { ip } = {}) {
  const g = needGateway(peerId);
  const a = needAccount(g, id);
  if (typeof locked !== 'boolean') throw new EdgeAdminError('invalid', 'locked must be true or false');
  if (a.locked !== locked) {
    mqtt.setLocked(g.id, a.id, locked);
    log(locked ? 'gateway_mqtt_account_locked' : 'gateway_mqtt_account_unlocked', `MQTT account "${a.username}" ${locked ? 'locked' : 'unlocked'} on gateway "${g.name}"`, {
      source: 'admin', ipAddress: ip, severity: locked ? 'warning' : 'info', details: { peer_id: g.id, username: a.username },
    });
    hub.refresh(g.id);
  }
  return mqtt.get(g.id, a.id);
}

function mqttResetPassword(peerId, id, { ip } = {}) {
  const g = needGateway(peerId);
  const a = needAccount(g, id);
  const password = mqtt.resetPassword(g.id, a.id);
  log('gateway_mqtt_account_password', `New password for MQTT account "${a.username}" on gateway "${g.name}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, username: a.username },
  });
  hub.refresh(g.id);
  return { account: mqtt.get(g.id, a.id), password };
}

function mqttRemove(peerId, id, { ip } = {}) {
  const g = needGateway(peerId);
  const a = needAccount(g, id);
  mqtt.remove(g.id, a.id);
  log('gateway_mqtt_account_deleted', `MQTT account "${a.username}" deleted on gateway "${g.name}"`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { peer_id: g.id, username: a.username },
  });
  hub.refresh(g.id);
}

// ─── Plugin lifecycle ───────────────────────────

/**
 * After an install or update: assignments whose approval does not cover the
 * new version's capabilities stay off (update_pending) — note that once per
 * assignment and version. Every connected gateway gets its new state.
 */
function onPluginInstalled(manifest) {
  try {
    if (manifest && manifest.edge) {
      for (const a of store.assignmentsOfPlugin(manifest.id)) {
        if (!a.enabled) continue;
        const added = edgeManifest.newCapabilities(manifest.edge.capabilities, [...a.capsList, ...(a.optCapsList || [])]);
        if (!added.length) continue;
        const g = store.gatewayPeer(a.peerId);
        store.addLog(a.peerId, manifest.id, 'system', 'warn', `update to v${manifest.version} needs new capabilities (${added.join(', ')}) — off until confirmed`);
        log('gateway_edge_update_pending', `Edge part of plugin "${manifest.id}" ${manifest.version} needs new capabilities on gateway "${g ? g.name : a.peerId}" — off until an administrator confirms`, {
          source: 'system', severity: 'warning', details: { peer_id: a.peerId, plugin: manifest.id, version: manifest.version, capabilities: added },
        });
      }
    }
  } catch (e) { logger.warn({ err: e.message }, 'edge update check failed'); }
  hub.refreshSoon();
}

/** Uninstall: 'wipe' forgets the approvals, logs and the plugin's MQTT accounts; 'keep' keeps them for a reinstall. */
function onPluginRemoved(pluginId, mode) {
  try {
    if (mode === 'wipe') {
      store.removePlugin(pluginId);
      mqtt.removePlugin(pluginId);
    }
  } catch (e) { logger.warn({ err: e.message }, 'edge clean-up failed'); }
  hub.refreshSoon();
}

// ─── Host API (gc.edge, gc.mqtt.accounts) ───────

function hostError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function needEdge(plugin) {
  if (!plugin.manifest || !plugin.manifest.edge) throw hostError('denied', 'this plugin has no edge part (plugin.json edge)');
}

function gatewayIdOf(v) {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) throw hostError('ERR_INVALID', 'invalid gateway id');
  return id;
}

/** The gateway may be used by the plugin now, else not_enabled. */
function needEffective(plugin, peerId) {
  const eff = stateLib.effective(plugin.id, peerId);
  if (!eff.ok) throw hostError('not_enabled', `the edge part is not switched on for this gateway (${eff.reason})`);
}

/**
 * gc.edge.gateways() → [{ id, name, state, online, version, reason }] — gateways this plugin is set up for.
 * `reason` (with state 'offline' only, else null): why the edge channel is down — reason.js REASONS, null = unknown.
 */
function hostGateways(plugin) {
  needEdge(plugin);
  return store.assignmentsOfPlugin(plugin.id).map((a) => {
    const g = store.gatewayPeer(a.peerId);
    if (!g) return null;
    const s = store.settings(g.id);
    const on = hub.online(g.id);
    const state = stateOf(a, s, on);
    const reason = state === 'offline' ? channelOf(g.id, heartbeatOf(g.id)).reason : null;
    return { id: g.id, name: g.name, state, online: on, version: s.hello && s.hello.version ? s.hello.version : null, reason };
  }).filter(Boolean);
}

/**
 * gc.edge.capabilities(gatewayId) → { gatewayId, optional, approved, requested, gatewaySupported, unsupported } — the plugin's
 * optional capabilities (edge.optionalCapabilities) on that gateway: declared, confirmed by an administrator,
 * asked for and not confirmed yet. Keys as in capabilityList ("mqtt.topic:zigbee2mqtt/#", "tcp.lan", "udp.port:6667",
 * "udp.broadcast"). gatewaySupported: false when the gateway is too old for one of them (listed in `unsupported`).
 */
function hostCapabilities(plugin, args) {
  needEdge(plugin);
  const a0 = args && typeof args === 'object' ? args : {};
  const peerId = gatewayIdOf(a0.gatewayId);
  const a = store.assignment(plugin.id, peerId);
  if (!a || !store.gatewayPeer(peerId)) throw hostError('not_enabled', 'the edge part is not set up for this gateway (not_assigned)');
  const edge = plugin.manifest.edge;
  const optional = edgeManifest.optionalList(edge);
  const approved = edgeManifest.approvedOptional(edge, a.optCapsList);
  const req = a.optRequests || {};
  // false: the gateway is too old for (some of) the optional capabilities (refuses them), null: not known yet
  const sup = optionalKeysSupport(optional, store.settings(peerId), heartbeatOf(peerId));
  return { gatewayId: peerId, optional, approved, requested: optional.filter((k) => !approved.includes(k) && Number.isFinite(req[k])),
    gatewaySupported: sup.supported, unsupported: sup.unsupported };
}

/**
 * gc.edge.requestCapability(gatewayId, key) → { status: 'approved' | 'requested', notified, gatewaySupported } — asks an
 * administrator for one optional capability: a note in the activity log with the way to the
 * confirmation (Gateways › Gateway › Edge-Plugins). One note per gateway and key per day; asking
 * again meanwhile only answers 'requested' (notified: false).
 */
function hostRequestCapability(plugin, args) {
  needEdge(plugin);
  const a0 = args && typeof args === 'object' ? args : {};
  const peerId = gatewayIdOf(a0.gatewayId);
  const key = typeof a0.key === 'string' && a0.key.length <= OPTIONAL_KEY_MAX ? a0.key : null;
  const edge = plugin.manifest.edge;
  if (!key || !edgeManifest.optionalList(edge).includes(key)) throw hostError('ERR_INVALID', 'not an optional capability of this plugin (plugin.json edge.optionalCapabilities)');
  const g = store.gatewayPeer(peerId);
  const a = g ? store.assignment(plugin.id, peerId) : null;
  if (!a) throw hostError('not_enabled', 'the edge part is not set up for this gateway (not_assigned)');
  const gatewaySupported = optionalKeySupported(key, store.settings(peerId), heartbeatOf(peerId));
  const minGateway = optionalMinGateway(key);
  if (edgeManifest.approvedOptional(edge, a.optCapsList).includes(key)) return { status: 'approved', notified: false, gatewaySupported };
  const now = Date.now();
  const req = { ...(a.optRequests || {}) };
  if (Number.isFinite(req[key]) && now - req[key] < REQUEST_EVERY_MS) return { status: 'requested', notified: false, gatewaySupported };
  req[key] = now;
  store.setOptionalRequests(plugin.id, peerId, req);
  const name = loc(plugin.manifest.name, 'en') || plugin.id;
  const link = '/gateways#gw/' + peerId + '/edge';
  // an older gateway would refuse the capability even once confirmed: say so instead of a silent `denied`
  const tooOld = gatewaySupported === false
    ? ` — gateway too old for this capability, update it (needs ${minGateway} or newer)` : '';
  log('gateway_edge_capability_requested',
    `Plugin "${name}" asks for an additional capability on gateway "${g.name}": ${capText(edge, key, 'en')} — confirm under Gateways › ${g.name} › Edge-Plugins (${link})${tooOld}`, {
      source: 'system', severity: 'warning',
      details: { peer_id: peerId, plugin: plugin.id, version: plugin.version, capability: key, link, ...(gatewaySupported === false ? { gateway_too_old: true, min_gateway: minGateway } : {}) },
    });
  store.addLog(peerId, plugin.id, 'system', 'warn', `asks for optional capability ${key} — confirm under Edge-Plugins${tooOld}`);
  return { status: 'requested', notified: true, gatewaySupported };
}

async function hostCall(plugin, args) {
  needEdge(plugin);
  const a = args && typeof args === 'object' ? args : {};
  const peerId = gatewayIdOf(a.gatewayId);
  if (typeof a.method !== 'string' || !METHOD_RE.test(a.method)) throw hostError('ERR_INVALID', 'invalid method name');
  needEffective(plugin, peerId);
  return hub.call(plugin.id, peerId, a.method, a.params === undefined ? null : a.params, a.timeoutMs);
}

function hostConfigure(plugin, args) {
  needEdge(plugin);
  const a = args && typeof args === 'object' ? args : {};
  const peerId = gatewayIdOf(a.gatewayId);
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(a.data === undefined ? null : a.data)); } catch { throw hostError('ERR_INVALID', 'data must be JSON'); }
  if (size > CONFIGURE_MAX) throw hostError('ERR_INVALID', 'configuration larger than 48 KB');
  needEffective(plugin, peerId);
  hub.configure(plugin.id, peerId, a.data === undefined ? null : a.data);
  return { sent: true };
}

/**
 * gc.mqtt.accounts.create(gatewayId, { label, topics }) — an account for one of the plugin's devices,
 * topics only below its plugin.json edge mqtt topics. User name <plugin id>-<name or random>.
 * list(gatewayId) / remove(gatewayId, username) — only the plugin's own accounts.
 */
function hostMqtt(plugin, op, args) {
  needEdge(plugin);
  const edge = plugin.manifest.edge;
  const own = edge.capabilities && edge.capabilities.mqtt ? edge.capabilities.mqtt.topics : [];
  const optional = edge.optionalCapabilities && edge.optionalCapabilities.mqtt ? edge.optionalCapabilities.mqtt.topics : [];
  if (!own.length && !optional.length) throw hostError('denied', 'this plugin declares no MQTT topics (edge.capabilities.mqtt)');
  const a = args && typeof args === 'object' ? args : {};
  const peerId = gatewayIdOf(a.gatewayId);
  needEffective(plugin, peerId);
  // the declared topics plus the optional ones confirmed on this gateway
  const asg = store.assignment(plugin.id, peerId);
  const topics = edgeManifest.withOptional(edge.capabilities, edgeManifest.approvedOptional(edge, asg ? asg.optCapsList : [])).mqtt;
  if (!topics || !topics.topics.length) throw hostError('denied', 'no MQTT topics approved for this plugin on this gateway');
  const g = store.gatewayPeer(peerId);
  if (op === 'list') return mqtt.list(peerId, { pluginId: plugin.id }).map(({ id: _id, gatewayId: _g, createdBy: _c, ...rest }) => rest);
  if (op === 'remove') {
    const acc = mqtt.list(peerId, { pluginId: plugin.id }).find((x) => x.username === a.username);
    if (!acc) return false;
    mqtt.remove(peerId, acc.id);
    log('gateway_mqtt_account_deleted', `MQTT account "${acc.username}" deleted by plugin "${plugin.id}" on gateway "${g.name}"`, {
      source: 'system', severity: 'info', details: { peer_id: peerId, plugin: plugin.id, username: acc.username },
    });
    hub.refresh(peerId);
    return true;
  }
  if (op !== 'create') throw hostError('ERR_UNKNOWN_API', 'unknown host API');
  const o = a.opts && typeof a.opts === 'object' ? a.opts : {};
  let acl;
  try { acl = mqtt.normaliseAcl(o.topics == null ? [] : o.topics); } catch (e) { throw hostError('ERR_INVALID', e.message); }
  if (!acl.length) throw hostError('ERR_INVALID', 'topics: at least one');
  if (!mqtt.topicsAllowed(topics.topics, acl)) throw hostError('denied', 'topics outside the plugin\'s MQTT topics');
  const name = o.name == null ? require('node:crypto').randomBytes(4).toString('hex') : String(o.name).toLowerCase();
  if (!PLUGIN_USER_RE.test(name)) throw hostError('ERR_INVALID', 'invalid name');
  let r;
  try { r = mqtt.create(peerId, { username: `${plugin.id}-${name}`.slice(0, 48), label: o.label, topics: acl, pluginId: plugin.id, by: 'plugin:' + plugin.id }); } catch (e) {
    if (e instanceof mqtt.MqttError) throw hostError(e.code === 'limit' ? 'ERR_RATE_LIMIT' : 'ERR_INVALID', e.message);
    throw e;
  }
  log('gateway_mqtt_account_created', `MQTT account "${r.account.username}" created by plugin "${plugin.id}" on gateway "${g.name}"`, {
    source: 'system', severity: 'info', details: { peer_id: peerId, plugin: plugin.id, username: r.account.username, topics: acl.map((x) => x.topic) },
  });
  hub.refresh(peerId);
  return { username: r.account.username, password: r.password, acl: r.account.acl, label: r.account.label };
}

module.exports = {
  gateways, overview, pluginOverview, setSettings, enablePlugin, disablePlugin, approveOptional, revokeOptional, logs,
  mqttAccounts, mqttCreate, mqttSetLocked, mqttResetPassword, mqttRemove,
  onPluginInstalled, onPluginRemoved, hostGateways, hostCapabilities, hostRequestCapability, hostCall, hostConfigure, hostMqtt, stateOf, channelOf, heartbeatOf,
  EdgeAdminError, CONFIRM_WORDS, REQUEST_EVERY_MS, EDGE_MIN_GATEWAY, EDGE_ISOLATED_MIN_GATEWAY, EDGE_OPTIONAL_MIN_GATEWAY, EDGE_OPTIONAL_LAN_MIN_GATEWAY, optionalCapsSupported, optionalLanSupported, optionalKeySupported,
};

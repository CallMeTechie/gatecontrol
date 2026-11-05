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
//   MQTT accounts        per gateway; the password is shown once, only its hash is kept

const store = require('./store');
const stateLib = require('./state');
const hub = require('./hub');
const mqtt = require('./mqtt');
const edgeManifest = require('./manifest');
const logger = require('../../utils/logger');

const CONFIRM_WORDS = new Set(['ERLAUBEN', 'ALLOW']);
const METHOD_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CONFIGURE_MAX = 48 * 1024;
const PLUGIN_USER_RE = /^[a-z0-9][a-z0-9_.-]{0,23}$/;

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

/** What the assignment amounts to right now (for the UI and gc.edge.gateways). */
function stateOf(a, settings, connected) {
  if (!settings.edgeEnabled) return 'edge_off';
  const v = stateLib.evaluate(a, settings);
  if (!v) return 'no_edge';
  if (v.reason) return v.reason;
  if (!connected) return 'offline';
  return a.status && a.status.state ? a.status.state : 'pending';
}

function assignmentView(a, settings, connected, lang) {
  const p = registry().get(a.pluginId);
  const edge = p && p.manifest ? p.manifest.edge : null;
  return {
    pluginId: a.pluginId,
    enabled: a.enabled,
    state: stateOf(a, settings, connected),
    approved: { capabilities: a.capsList, version: a.capsVersion, at: a.approvedAt ? new Date(a.approvedAt).toISOString() : null, by: a.approvedBy },
    newCapabilities: edge ? edgeManifest.describe(edge.capabilities, lang).filter((x) => !a.capsList.includes(x.key)) : [],
    status: a.status || null,
  };
}

function pluginEdgeView(p, lang) {
  const e = p.manifest.edge;
  return {
    id: p.id, name: loc(p.manifest.name, lang), version: p.version, verified: p.signature === 'trusted', signature: p.signature, enabled: p.enabled,
    edge: { memoryMb: e.memoryMb, minGateway: e.minGateway, capabilities: edgeManifest.describe(e.capabilities, lang) },
  };
}

function helloView(s) {
  return s.hello ? { version: s.hello.version || null, edgeHost: s.hello.edgeHost || null, mqttAvailable: !!(s.hello.mqtt && s.hello.mqtt.available),
    fence: s.hello.fence || null, hardware: s.hello.hardware || null, at: s.helloAt ? new Date(s.helloAt).toISOString() : null } : null;
}

function settingsView(s) {
  return { edgeEnabled: s.edgeEnabled, mqttEnabled: s.mqttEnabled, mqttTls: s.mqttTls, allowUnsignedEdge: s.allowUnsignedEdge };
}

/** Every gateway with its edge summary. */
function gateways() {
  return store.gatewayPeers().map((g) => {
    const s = store.settings(g.id);
    const list = store.assignmentsOfGateway(g.id);
    const conn = hub.connectionInfo(g.id);
    return {
      id: g.id, name: g.name, ...settingsView(s), connection: conn, gateway: helloView(s),
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
  const conn = hub.connectionInfo(g.id);
  const byPlugin = new Map(store.assignmentsOfGateway(g.id).map((a) => [a.pluginId, a]));
  const pluginsList = registry().list().filter((p) => p.manifest && p.manifest.edge).map((p) => {
    const a = byPlugin.get(p.id);
    return { ...pluginEdgeView(p, lang), assignment: a ? assignmentView(a, s, conn.online, lang) : null };
  });
  return {
    id: g.id, name: g.name, settings: settingsView(s), connection: conn, gateway: helloView(s), plugins: pluginsList,
    mqtt: { status: s.mqttStatus, accounts: mqtt.list(g.id) },
  };
}

/** A plugin's edge part on every gateway (plugin area). */
function pluginOverview(pluginId, lang) {
  const p = edgePlugin(pluginId);
  const byPeer = new Map(store.assignmentsOfPlugin(p.id).map((a) => [a.peerId, a]));
  return {
    ...pluginEdgeView(p, lang),
    gateways: store.gatewayPeers().map((g) => {
      const s = store.settings(g.id);
      const conn = hub.connectionInfo(g.id);
      const a = byPeer.get(g.id);
      return { id: g.id, name: g.name, edgeEnabled: s.edgeEnabled, allowUnsignedEdge: s.allowUnsignedEdge, online: conn.online,
        assignment: a ? assignmentView(a, s, conn.online, lang) : null };
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
  return assignmentView(store.assignment(p.id, g.id), store.settings(g.id), hub.online(g.id), lang);
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
  return assignmentView(store.assignment(a.pluginId, g.id), store.settings(g.id), hub.online(g.id), lang);
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
        const added = edgeManifest.newCapabilities(manifest.edge.capabilities, a.capsList);
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

/** gc.edge.gateways() → [{ id, name, state, online, version }] — gateways this plugin is set up for */
function hostGateways(plugin) {
  needEdge(plugin);
  return store.assignmentsOfPlugin(plugin.id).map((a) => {
    const g = store.gatewayPeer(a.peerId);
    if (!g) return null;
    const s = store.settings(g.id);
    const on = hub.online(g.id);
    return { id: g.id, name: g.name, state: stateOf(a, s, on), online: on, version: s.hello && s.hello.version ? s.hello.version : null };
  }).filter(Boolean);
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
  const topics = plugin.manifest.edge.capabilities && plugin.manifest.edge.capabilities.mqtt ? plugin.manifest.edge.capabilities.mqtt.topics : null;
  if (!topics) throw hostError('denied', 'this plugin declares no MQTT topics (edge.capabilities.mqtt)');
  const a = args && typeof args === 'object' ? args : {};
  const peerId = gatewayIdOf(a.gatewayId);
  needEffective(plugin, peerId);
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
  if (!mqtt.topicsAllowed(topics, acl)) throw hostError('denied', 'topics outside the plugin\'s MQTT topics');
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
  gateways, overview, pluginOverview, setSettings, enablePlugin, disablePlugin, logs,
  mqttAccounts, mqttCreate, mqttSetLocked, mqttResetPassword, mqttRemove,
  onPluginInstalled, onPluginRemoved, hostGateways, hostCall, hostConfigure, hostMqtt, stateOf,
  EdgeAdminError, CONFIRM_WORDS,
};

'use strict';

// What a gateway should run: the `state` frame of the edge protocol (docs/
// plugins.md "Edge part" › "Protocol"). Always the complete target state —
// the gateway applies it idempotently — computed from the gateway's
// switches, the plugin × gateway assignments and the installed plugins.
//
// Per assigned plugin the gateway gets { id, version, sha256, caps, memoryMb,
// enabled } and, when it must not run, `reason`:
//   disabled         switched off for this gateway by an administrator
//   update_pending   the installed version needs capabilities nobody approved yet
//   unsigned         not signed by a trusted publisher and the gateway does not allow that
//   plugin_off       the plugin itself does not run on the server (disabled, licence, …)
//   gateway_too_old  the gateway is older than edge.minGateway

const store = require('./store');
const mqtt = require('./mqtt');
const packages = require('./packages');
const edgeManifest = require('./manifest');
const semver = require('../plugins/semver');

function registry() { return require('../plugins/registry'); }
function plugins() { return require('../plugins'); }

function serverRuns(plugin) {
  try { return plugins().evaluate(plugin).run === true; } catch { return false; }
}

/**
 * The verdict for one assignment.
 * @returns {{ plugin, edge, reason: string|null, newCaps: string[] } | null}  null: the plugin has no edge part (any more)
 */
function evaluate(a, settings) {
  const plugin = registry().get(a.pluginId);
  const edge = plugin && plugin.manifest ? plugin.manifest.edge : null;
  if (!edge) return null;
  const newCaps = edgeManifest.newCapabilities(edge.capabilities, a.capsList);
  let reason = null;
  if (!a.enabled) reason = 'disabled';
  else if (newCaps.length) reason = 'update_pending';
  else if (plugin.signature !== 'trusted' && !settings.allowUnsignedEdge) reason = 'unsigned';
  else if (!serverRuns(plugin)) reason = 'plugin_off';
  else if (edge.minGateway && settings.hello && typeof settings.hello.version === 'string' && semver.valid(settings.hello.version)
    && semver.compare(settings.hello.version, edge.minGateway) < 0) reason = 'gateway_too_old';
  return { plugin, edge, reason, newCaps };
}

/** May `pluginId` use the gateway right now (calls, configure, events, packages)? */
function effective(pluginId, peerId) {
  const a = store.assignment(pluginId, peerId);
  if (!a) return { ok: false, reason: 'not_assigned' };
  const s = store.settings(peerId);
  if (!s.edgeEnabled) return { ok: false, reason: 'edge_off' };
  const v = evaluate(a, s);
  if (!v) return { ok: false, reason: 'no_edge' };
  return v.reason ? { ok: false, reason: v.reason } : { ok: true, reason: null, plugin: v.plugin, edge: v.edge };
}

/** The `state` frame for gateway `peerId`. */
function compute(peerId) {
  const s = store.settings(peerId);
  const list = [];
  const pluginTopics = {};
  if (s.edgeEnabled) {
    for (const a of store.assignmentsOfGateway(peerId)) {
      const v = evaluate(a, s);
      if (!v) continue;
      const pk = packages.info(v.plugin.id, v.plugin.version);
      if (!pk) continue;
      const on = v.reason === null;
      // switched on: what the installed version declares (⊆ what was approved); otherwise the approved snapshot
      const caps = on ? (v.edge.capabilities || {}) : (a.caps || {});
      list.push({
        id: v.plugin.id, version: v.plugin.version, sha256: pk.sha256, caps, memoryMb: v.edge.memoryMb, enabled: on,
        ...(on ? {} : { reason: v.reason }),
      });
      if (on && caps.mqtt && caps.mqtt.topics.length) pluginTopics[v.plugin.id] = caps.mqtt.topics.slice();
    }
  }
  // the edge host on the gateway runs the broker (password_file / acl_file from this state): MQTT needs the edge switch too
  const mqttOn = s.edgeEnabled && s.mqttEnabled;
  return {
    t: 'state',
    edgeEnabled: s.edgeEnabled,
    allowUnsigned: s.allowUnsignedEdge,
    plugins: list,
    mqtt: {
      enabled: mqttOn,
      tls: s.mqttTls,
      accounts: mqttOn ? mqtt.forState(peerId) : [],
      pluginTopics: mqttOn ? pluginTopics : {},
    },
  };
}

module.exports = { compute, evaluate, effective };

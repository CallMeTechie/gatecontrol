'use strict';

// Gateway assistant "Gateway hinzufügen" (docs/feature-gateway-wizard.md):
//
//   setupStatus(id)        the live status of step 4 from data the server
//                          already has — created (gateway_meta.created_at) →
//                          first contact (first_seen_at / WireGuard handshake)
//                          → hardware (telemetry.hardware, gateway ≥ 1.17.0)
//                          → Zigbee radio (hardware.radios) → deCONZ (the
//                          route_reachability the gateway reports for its
//                          127.0.0.1:8090 route, when there is one)
//   connectSmarthome(id)   "Im Smart Home einbinden": an internal HTTP route to
//                          the gateway itself (127.0.0.1:8090, deCONZ/Phoscon)
//                          assigned to the Smart Home plugin's access target
//                          "gateway" — both idempotent. The deCONZ API key is
//                          then fetched by the plugin (Phoscon "Gateway
//                          entsperren").
//
// Nothing here returns tokens or the gateway.env.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const kit = require('../../public/js/gateway-kit');

const SMARTHOME_PLUGIN = 'gatecontrol-smarthome';
const SMARTHOME_TARGET = 'gateway';
const HARDWARE_MIN_VERSION = '1.17.0';
const TUNNEL_FRESH_S = 180;

class WizardError extends Error {
  constructor(code, status = 400, extra = {}) { super(code); this.code = code; this.status = status; Object.assign(this, extra); }
}

function gatewayRow(peerId) {
  return getDb().prepare(`
    SELECT p.id, p.name, p.hostname, p.allowed_ips, p.latest_handshake, p.enabled, p.peer_type,
           gm.platform, gm.created_at, gm.first_seen_at, gm.last_seen_at, gm.last_health, gm.lan_ip, gm.location_id
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id = ? AND p.peer_type = 'gateway'
  `).get(peerId) || null;
}

function parseHealth(raw) {
  if (!raw) return {};
  try { const h = JSON.parse(raw); return h && typeof h === 'object' ? h : {}; } catch { return {}; }
}

const str = (v, max = 120) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** The deCONZ/Phoscon route of a gateway: HTTP via this gateway to itself on :8090. */
function findDeconzRoute(peerId, lanIp) {
  const hosts = ['127.0.0.1', 'localhost'];
  if (lanIp) hosts.push(String(lanIp));
  const ph = hosts.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id, domain, https_enabled, enabled, external_enabled FROM routes
    WHERE target_kind = 'gateway' AND target_peer_id = ? AND (route_type = 'http' OR route_type IS NULL)
      AND target_lan_port = ? AND target_lan_host IN (${ph})
    ORDER BY enabled DESC, id LIMIT 1
  `).get(peerId, kit.DECONZ_PORT, ...hosts) || null;
}

function smarthomePlugin() {
  let plugin = null;
  try { plugin = require('./plugins/registry').get(SMARTHOME_PLUGIN); } catch { plugin = null; }
  if (!plugin) return { plugin: null, decl: null };
  const targets = require('./plugins/targets');
  const decl = targets.declared(plugin).find((t) => t.id === SMARTHOME_TARGET) || null;
  return { plugin, decl };
}

function smarthomeAssignment(pluginId, routeId) {
  if (!routeId) return -1;
  const list = require('./plugins/targets').assignments(pluginId)[SMARTHOME_TARGET] || [];
  return list.findIndex((a) => a && a.kind === 'route' && a.routeId === routeId);
}

function radioLabel(r) {
  const t = r.type || '';
  if (t === 'raspbee2-conbee2') return r.device && /ttyAMA|serial0|ttyS/.test(r.device) ? 'RaspBee II' : 'ConBee II';
  if (t === 'conbee3') return 'ConBee III';
  if (t === 'raspbee-conbee-1') return r.device && /ttyAMA|serial0|ttyS/.test(r.device) ? 'RaspBee' : 'ConBee';
  if (t === 'conbee-usb') return 'ConBee (USB)';
  return null;
}

/**
 * Step 4 of the assistant (and the "waiting for first start" card).
 * @returns {object|null} null when the id is no gateway
 */
function setupStatus(peerId) {
  const row = gatewayRow(peerId);
  if (!row) return null;
  const health = parseHealth(row.last_health);
  const tel = health.telemetry && typeof health.telemetry === 'object' ? health.telemetry : {};
  const hsS = Number(row.latest_handshake) || 0;
  const firstSeen = row.first_seen_at || row.last_seen_at || null;
  const version = str(tel.gateway_version, 32);

  let hardware = null;
  const hw = tel.hardware && typeof tel.hardware === 'object' ? tel.hardware : null;
  if (hw) {
    hardware = {
      model: str(hw.model),
      arch: str(hw.arch, 32),
      cpu_cores: num(hw.cpu_cores),
      mem_total: num(hw.mem_total),
      storage_free: hw.storage && typeof hw.storage === 'object' ? num(hw.storage.free) : null,
      platform: str(hw.platform, 32),
      image_version: str(hw.image_version, 32),
    };
  }
  const radios = (hw && Array.isArray(hw.radios) ? hw.radios : []).slice(0, 8)
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ kind: str(r.kind, 32), type: str(r.type, 32), device: str(r.device, 128), detected: r.detected === true, enabled: r.enabled === true }))
    .map((r) => ({ ...r, label: radioLabel(r) }));
  const zigbee = radios.find((r) => r.kind === 'zigbee' && (r.detected || r.enabled)) || null;

  const route = findDeconzRoute(row.id, row.lan_ip);
  let deconz = null;
  if (route) {
    const rr = Array.isArray(health.route_reachability) ? health.route_reachability.find((x) => x && x.route_id === route.id) : null;
    deconz = {
      route_id: route.id,
      domain: route.domain || null,
      enabled: route.enabled === 1,
      url: route.enabled === 1 && route.domain ? `${route.https_enabled ? 'https' : 'http'}://${route.domain}/` : null,
      reachable: rr ? rr.reachable === true : null,
    };
  }

  const { plugin, decl } = smarthomePlugin();
  const idx = plugin && decl && route ? smarthomeAssignment(plugin.id, route.id) : -1;

  // the live state (services/gatewayLiveState.js): online with the first
  // heartbeat, not only after the sliding window has seen four of them
  let status = 'unknown';
  let liveStateName = 'unknown';
  try {
    const gws = require('./gateways');
    const liveState = require('./gatewayLiveState');
    const live = liveState.forPeer(row.id) || liveState.derive({}, {});
    liveStateName = live.state;
    status = liveState.legacyStatus(live, gws.getHealthStatus(row.id), gws._isHeartbeatHealthy(health));
  } catch { /* unknown */ }

  return {
    peer_id: row.id,
    name: row.name,
    platform: row.platform || null,
    // Gateway-Standort (services/gatewayLocations.js): shown in step 1 when the set-up is continued
    location_id: row.location_id || null,
    enabled: row.enabled === 1,
    created_at: row.created_at || null,
    first_seen_at: firstSeen,
    last_seen_at: row.last_seen_at || null,
    connected: !!(firstSeen || hsS),
    tunnel_up: hsS > 0 && (Date.now() / 1000 - hsS) < TUNNEL_FRESH_S,
    status,
    state: liveStateName,
    gateway_version: version,
    hostname: str(health.hostname, 253),
    lan_ip: str(row.lan_ip, 64),
    hardware,
    // null = not known yet (no heartbeat); false = gateway too old to report it
    hardware_supported: version ? kit.versionAtLeast(version, HARDWARE_MIN_VERSION) : null,
    radios,
    zigbee,
    deconz,
    smarthome: {
      installed: !!plugin,
      target_declared: !!decl,
      assigned: idx >= 0,
      index: idx >= 0 ? idx : null,
      plugin_url: plugin ? `/plugins/${SMARTHOME_PLUGIN}` : null,
    },
  };
}

function suggestDeconzDomain(row) {
  const config = require('../../config/default');
  const zone = String((config.dns && config.dns.domain) || 'gc.internal').toLowerCase();
  const base = kit.suggestHostname(row.name).replace(/^gc-/, '');
  return `phoscon-${base}`.slice(0, 63).replace(/-+$/, '') + '.' + zone;
}

/**
 * "Im Smart Home einbinden" — idempotent: an existing route of this gateway to
 * 127.0.0.1:8090 is reused, an existing assignment kept.
 * @param {number} peerId
 * @param {{domain?: string, ip?: string}} opts
 */
async function connectSmarthome(peerId, opts = {}) {
  const row = gatewayRow(peerId);
  if (!row || row.enabled !== 1) throw new WizardError('not_found', 404);
  const { plugin, decl } = smarthomePlugin();
  if (!plugin) throw new WizardError('plugin_missing', 409);
  if (!decl) throw new WizardError('plugin_no_target', 409);

  const license = require('./license');
  const db = getDb();
  let route = findDeconzRoute(row.id, row.lan_ip);
  let created = false;
  if (!route) {
    const httpCount = db.prepare("SELECT COUNT(*) AS n FROM routes WHERE route_type = 'http' OR route_type IS NULL").get().n;
    if (!license.isWithinLimit('http_routes', httpCount)) throw new WizardError('limit_http_routes', 403, { feature: 'http_routes' });
    const gwLimit = license.getFeatureLimit('gateway_http_targets');
    if (gwLimit !== -1) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM routes WHERE target_peer_id = ? AND target_kind = 'gateway' AND route_type = 'http'").get(row.id).n;
      if (n >= gwLimit) throw new WizardError('limit_gateway_http_targets', 403, { feature: 'gateway_http_targets' });
    }
    const domain = String(opts.domain || suggestDeconzDomain(row)).trim().toLowerCase();
    const { validateDomain } = require('../utils/validate');
    if (validateDomain(domain)) throw new WizardError('domain_invalid', 400);
    const pol = require('./routeDomainPolicy').checkDomainPolicy(domain, { routeType: 'http' });
    if (pol.error) throw new WizardError('domain_' + pol.error, 400);
    if (db.prepare('SELECT 1 FROM routes WHERE domain = ? AND (route_type = \'http\' OR route_type IS NULL)').get(domain)) {
      throw new WizardError('domain_taken', 409);
    }
    const r = await require('./routes').create({
      domain,
      route_type: 'http',
      target_kind: 'gateway',
      target_peer_id: row.id,
      target_lan_host: '127.0.0.1',
      target_lan_port: kit.DECONZ_PORT,
      target_port: kit.DECONZ_PORT,
      external_enabled: false,
      description: `Phoscon/deCONZ – ${row.name}`.slice(0, 200),
    });
    route = findDeconzRoute(row.id, row.lan_ip) || { id: r.id, domain: r.domain };
    created = true;
  }

  const targets = require('./plugins/targets');
  const list = (targets.assignments(plugin.id)[SMARTHOME_TARGET] || []).slice();
  let index = list.findIndex((a) => a && a.kind === 'route' && a.routeId === route.id);
  let assignedNow = false;
  if (index < 0) {
    if (list.length >= (decl.multiple ? 32 : 1)) throw new WizardError('plugin_targets_full', 409, { route_id: route.id });
    list.push({ kind: 'route', routeId: route.id });
    const out = targets.assign(plugin, SMARTHOME_TARGET, list);
    index = out.length - 1;
    assignedNow = true;
    try {
      require('./plugins/registry').addLog(plugin.id, 'info', `access target "${SMARTHOME_TARGET}" set by an administrator (gateway assistant): ${out.map(targets.display).join(', ')}`);
    } catch (err) { logger.debug({ err: err.message }, 'plugin log write failed'); }
    require('./activity').log('plugin_target_changed', `Plugin "${plugin.name}": access target "${SMARTHOME_TARGET}" assigned`, {
      source: 'admin', ipAddress: opts.ip || null, severity: 'info',
      details: { plugin: plugin.id, target: SMARTHOME_TARGET, assigned: out, gateway: row.id, via: 'gateway_wizard' },
    });
  }
  return {
    route: { id: route.id, domain: route.domain || null, created },
    target: { id: SMARTHOME_TARGET, index, assigned_now: assignedNow },
    plugin_url: `/plugins/${SMARTHOME_PLUGIN}`,
  };
}

/** Whether the gateway ever reported (for the client: a re-download then breaks a running gateway). */
function everConnected(peerId) {
  const row = gatewayRow(peerId);
  return !!(row && (row.first_seen_at || row.last_seen_at || Number(row.latest_handshake) > 0));
}

module.exports = {
  SMARTHOME_PLUGIN, SMARTHOME_TARGET, HARDWARE_MIN_VERSION, WizardError,
  setupStatus, connectSmarthome, findDeconzRoute, suggestDeconzDomain, everConnected, gatewayRow,
};

'use strict';

// Built-in → plugin migration (docs/plugins.md "Übernahme eingebauter Daten").
//
// While a built-in integration moves out of the server into a first-party
// plugin, two things are needed until the built-in code is removed:
//
//   1. a ONE-TIME DATA IMPORT: the plugin whose id is listed in DATASETS
//      below may receive a JSON snapshot of exactly the mapped built-in
//      tables (secrets decrypted for this hand-over only, never logged). The
//      administrator starts it from the plugin's detail page (offered as soon
//      as the plugin runs, re-runnable while the built-in data exists). The
//      host pushes the snapshot into the plugin's `legacyImport(snapshot, gc)`
//      hook, which writes it into the plugin's own storage. GateControl
//      routes and LAN addresses the built-in rows referenced are turned into
//      assignments of the plugin's home target first, so the administrator
//      does not have to assign them again. Every run is recorded
//      (plugin_legacy_imports).
//
//   2. COEXISTENCE: while the mapped plugin may run (installed, switched on,
//      licensed, signature/compatibility ok), the built-in feature is
//      replaced(): its sidebar entry, pages, API, portal part and background
//      jobs are off, so nothing runs twice. When the plugin is switched off
//      or uninstalled the built-in feature is back. Built-in data is never
//      deleted here.
//
// Only a plugin with a TRUSTED signature (built-in CallMeTechie key or a key
// the operator trusts via GC_PLUGIN_PUBKEYS) receives the snapshot. For
// testing an unsigned development build the operator can set
// GC_PLUGIN_LEGACY_UNSIGNED=1 (the plugin still only runs with
// "Unsignierte Plugins erlauben").

const { getDb } = require('../../db/connection');
const registry = require('./registry');
const runtime = require('./runtime');
const targets = require('./targets');
const signature = require('./signature');
const { TIMEOUTS } = require('./constants');

class LegacyError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ─── Built-in datasets ──────────────────────────

function parseJson(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : fallback; } catch { return fallback; }
}

function tableExists(name) {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const smarthome = {
  /** Row counts of the built-in tables (no secrets). */
  counts() {
    if (!tableExists('smarthome_gateways')) return { gateways: 0, resources: 0, owners: 0, rules: 0 };
    const db = getDb();
    const n = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    return { gateways: n('smarthome_gateways'), resources: n('smarthome_resources'), owners: n('smarthome_resource_owners'), rules: n('smarthome_rules') };
  },
  /**
   * Snapshot of smarthome_gateways / _resources / _resource_owners / _rules.
   * api_key is decrypted here — the snapshot only ever goes to the plugin process.
   */
  export() {
    const { decrypt } = require('../../utils/crypto');
    const db = getDb();
    const gateways = db.prepare('SELECT * FROM smarthome_gateways ORDER BY id').all().map((g) => {
      let apiKey = null;
      if (g.api_key_enc) { try { apiKey = decrypt(g.api_key_enc); } catch { apiKey = null; } }
      return {
        id: g.id, name: g.name, enabled: g.enabled === 1, api_key: apiKey, route_id: g.route_id == null ? null : Number(g.route_id),
        last_seen_at: g.last_seen_at || null, created_at: g.created_at || null, updated_at: g.updated_at || null,
      };
    });
    const resources = db.prepare('SELECT * FROM smarthome_resources ORDER BY id').all().map((r) => ({
      id: r.id, gateway_id: r.gateway_id, deconz_id: String(r.deconz_id), deconz_type: r.deconz_type, uniqueid: r.uniqueid || null,
      kind: r.kind, name: r.name, capabilities: parseJson(r.capabilities_json, {}), state: parseJson(r.state_json, {}),
      enabled: r.enabled === 1, created_at: r.created_at || null, updated_at: r.updated_at || null,
    }));
    const owners = db.prepare('SELECT resource_id, user_id, created_at FROM smarthome_resource_owners ORDER BY resource_id, user_id').all()
      .map((o) => ({ resource_id: o.resource_id, user_id: o.user_id, created_at: o.created_at || null }));
    const rules = db.prepare('SELECT * FROM smarthome_rules ORDER BY id').all().map((r) => ({
      id: r.id, gateway_id: r.gateway_id, name: r.name, enabled: r.enabled === 1, definition: parseJson(r.definition_json, {}),
      deconz_rule_id: r.deconz_rule_id || null, deconz_schedule_id: r.deconz_schedule_id || null, deconz_clip_sensor_id: r.deconz_clip_sensor_id || null,
      created_at: r.created_at || null, updated_at: r.updated_at || null,
    }));
    return { gateways, resources, owners, rules };
  },
  /** Each gateway's GateControl route becomes an assignment of the home target (route ids stay in the host). */
  targetRefs(data) {
    return data.gateways.map((gw) => {
      const rid = gw.route_id;
      delete gw.route_id; // the plugin only knows its targets
      return { item: gw, ref: Number.isInteger(rid) && rid > 0 ? { kind: 'route', routeId: rid } : null };
    });
  },
};

const MIDEA_LAN_PORT = 6444;

const midea = {
  /** Row counts of the built-in data (no secrets); `cloud` = 1 with a configured Midea account. */
  counts() {
    const db = getDb();
    const devices = tableExists('midea_devices') ? db.prepare('SELECT COUNT(*) AS c FROM midea_devices').get().c : 0;
    const owners = tableExists('midea_device_owners') ? db.prepare('SELECT COUNT(*) AS c FROM midea_device_owners').get().c : 0;
    const cfg = parseJson(require('../settings').get('midea_config'), null);
    return { cloud: cfg && typeof cfg.email === 'string' && cfg.email ? 1 : 0, devices, owners };
  },
  /**
   * The Midea cloud account (settings key midea_config) with password and
   * session decrypted, or null when none is configured.
   */
  cloudConfig() {
    const { decrypt } = require('../../utils/crypto');
    const cfg = parseJson(require('../settings').get('midea_config'), null);
    if (!cfg || typeof cfg.email !== 'string' || !cfg.email) return null;
    let password = null;
    if (cfg.password) { try { password = decrypt(cfg.password); } catch { password = null; } }
    let session = null;
    if (cfg.session) { try { session = parseJson(decrypt(cfg.session), null); } catch { session = null; } }
    return { app: cfg.app === 'nethome' ? 'nethome' : 'msmarthome', email: cfg.email, password, session };
  },
  /**
   * Snapshot of the Midea account, midea_devices and midea_device_owners.
   * The cloud password/session and the LAN token/key (protocol V3) are
   * decrypted here — the snapshot only ever goes to the plugin process.
   */
  export() {
    const { decrypt } = require('../../utils/crypto');
    const db = getDb();
    const dec = (v) => { if (!v) return null; try { return decrypt(v); } catch { return null; } };
    const cfg = midea.cloudConfig();
    const devices = tableExists('midea_devices') ? db.prepare('SELECT * FROM midea_devices ORDER BY id').all().map((d) => ({
      id: d.id, name: d.name, device_sn: d.device_sn, device_id: d.device_id == null ? null : String(d.device_id),
      ip: d.ip || null, port: Number(d.port) || MIDEA_LAN_PORT, protocol_version: Number(d.protocol_version) || 3, model: d.model || null,
      enabled: d.enabled === 1, transport: d.transport === 'cloud' ? 'cloud' : 'lan',
      cloud_appliance_id: d.cloud_appliance_id == null ? null : String(d.cloud_appliance_id),
      token: dec(d.token_enc), key: dec(d.key_enc),
      last_seen_at: d.last_seen_at || null, created_at: d.created_at || null, updated_at: d.updated_at || null,
    })) : [];
    const owners = tableExists('midea_device_owners')
      ? db.prepare('SELECT midea_device_id, user_id, created_at FROM midea_device_owners ORDER BY midea_device_id, user_id').all()
        .map((o) => ({ device_id: o.midea_device_id, user_id: o.user_id, created_at: o.created_at || null }))
      : [];
    return { cloud: cfg ? [cfg] : [], devices, owners };
  },
  /** Each LAN device's address becomes an assignment of the home target "ac" (the address stays in the host). */
  targetRefs(data) {
    return data.devices.map((d) => {
      const host = d.ip;
      const port = d.port;
      delete d.ip;
      delete d.port;
      if (d.transport !== 'lan' || typeof host !== 'string' || !host) return { item: d, ref: null };
      return { item: d, ref: { kind: 'host', host, port: port && port !== MIDEA_LAN_PORT ? port : null } };
    });
  },
};

/**
 * Fixed mapping: plugin id → the built-in dataset it may import and the
 * built-in feature it replaces. `target` is the plugin's home target that
 * the GateControl routes / LAN addresses referenced by the data become (one
 * per gateway / LAN air conditioner; source.targetRefs).
 */
const DATASETS = new Map([
  ['gatecontrol-smarthome', Object.freeze({ dataset: 'smarthome', feature: 'smarthome', target: 'gateway', source: smarthome })],
  ['gatecontrol-midea', Object.freeze({ dataset: 'midea', feature: 'midea', target: 'ac', source: midea })],
]);

function defOf(pluginId) {
  return typeof pluginId === 'string' && DATASETS.has(pluginId) ? DATASETS.get(pluginId) : null;
}

// ─── Coexistence ────────────────────────────────

/** Is the built-in `feature` replaced by a plugin that may run right now? */
function replaced(feature) {
  for (const [id, def] of DATASETS) {
    if (def.feature !== feature) continue;
    try {
      const p = registry.get(id);
      if (p && require('./index').evaluate(p).run) return true;
    } catch { /* registry not ready → built-in stays */ }
  }
  return false;
}

/** { feature: true } for every replaced built-in feature (template locals). */
function replacedMap() {
  const out = {};
  for (const def of DATASETS.values()) if (replaced(def.feature)) out[def.feature] = true;
  return out;
}

/** Express middleware for a built-in API: 409 while a plugin replaces it. */
function guardApi(feature, pluginId) {
  return (req, res, next) => {
    if (!replaced(feature)) return next();
    return res.status(409).json({ ok: false, code: 'replaced_by_plugin', plugin: pluginId,
      error: req.t ? req.t('plugins.legacy.replaced_api', { plugin: pluginId }) : 'Replaced by a plugin' });
  };
}

// ─── Import ─────────────────────────────────────

function eligibility(plugin) {
  if (!defOf(plugin.id)) return 'not_mapped';
  const signed = plugin.signature === 'trusted' && !!plugin.signerKey && signature.trustedKeys().includes(plugin.signerKey);
  if (!signed && process.env.GC_PLUGIN_LEGACY_UNSIGNED !== '1') return 'unsigned';
  return null;
}

function record(pluginId) {
  const r = getDb().prepare('SELECT dataset, imported_at, counts, runs FROM plugin_legacy_imports WHERE plugin_id = ?').get(pluginId);
  return r ? { dataset: r.dataset, at: r.imported_at, counts: parseJson(r.counts, {}), runs: r.runs } : null;
}

function forget(pluginId) {
  try { getDb().prepare('DELETE FROM plugin_legacy_imports WHERE plugin_id = ?').run(pluginId); } catch { /* table missing */ }
}

/**
 * What the detail page shows; null for plugins without a mapped dataset.
 * @returns {null|{dataset, eligible, reason, available, counts, imported, running}}
 */
function status(plugin) {
  const def = defOf(plugin && plugin.id);
  if (!def) return null;
  const counts = def.source.counts();
  const reason = eligibility(plugin);
  return {
    dataset: def.dataset,
    eligible: !reason,
    reason,
    available: Object.values(counts).some((n) => n > 0),
    counts,
    imported: record(plugin.id),
    running: runtime.info(plugin.id).state === 'running',
  };
}

/** Does an existing assignment already point where `ref` points? */
function sameTarget(a, ref) {
  if (!a || a.kind !== ref.kind) return false;
  if (ref.kind === 'route') return a.routeId === ref.routeId;
  return a.host === ref.host; // one air conditioner per address
}

/** A reference of the built-in data → a valid assignment, or null (unknown route, blocked address …). */
function refToAssignment(ref) {
  if (!ref) return null;
  try { return targets.normalise(ref); } catch { return null; }
}

/**
 * Turn the GateControl routes / LAN addresses the snapshot references
 * (source.targetRefs) into assignments of the plugin's home target (existing
 * assignments are kept; one already pointing there is reused). Sets
 * item.target = { id, index, label } or null.
 */
function assignTargets(plugin, def, refs) {
  const decl = targets.declared(plugin).find((t) => t.id === def.target);
  const current = decl ? (targets.assignments(plugin.id)[def.target] || []) : [];
  const list = current.slice();
  const max = decl && decl.multiple ? 32 : 1;
  let changed = false;
  for (const { item, ref } of refs) {
    item.target = null;
    const want = decl ? refToAssignment(ref) : null;
    if (!want) continue;
    let idx = list.findIndex((a) => sameTarget(a, want));
    if (idx < 0) {
      if (list.length >= max) continue;
      list.push(want);
      idx = list.length - 1;
      changed = true;
    }
    item.target = { id: def.target, index: idx, label: targets.display(list[idx]) };
  }
  if (changed) targets.assign(plugin, def.target, list);
  return changed ? list.length - current.length : 0;
}

const busy = new Set();

/**
 * Run the import: export → assign targets → plugin.legacyImport(snapshot).
 * @returns {Promise<{counts:object, targetsAdded:number, imported:object}>}
 */
async function runImport(pluginId, { ip } = {}) {
  const plugin = registry.get(pluginId);
  const def = defOf(pluginId);
  if (!plugin || !def) throw new LegacyError('not_found', 'no built-in data for this plugin');
  const reason = eligibility(plugin);
  if (reason) throw new LegacyError('legacy_' + reason, 'this plugin may not import built-in data');
  if (runtime.info(plugin.id).state !== 'running') throw new LegacyError('legacy_not_running', 'the plugin is not running');
  if (busy.has(plugin.id)) throw new LegacyError('legacy_busy', 'an import is already running');
  busy.add(plugin.id);
  try {
    const data = def.source.export();
    const total = Object.values(data).reduce((n, list) => n + list.length, 0);
    if (!total) throw new LegacyError('legacy_empty', 'there is no built-in data');
    const targetsAdded = assignTargets(plugin, def, def.source.targetRefs(data)); // the plugin only knows its targets
    const snapshot = { schema: 1, dataset: def.dataset, exportedAt: new Date().toISOString(), ...data };
    let out;
    try {
      out = await runtime.call(plugin.id, 'legacyImport', snapshot, TIMEOUTS.request * 4);
    } catch (e) {
      registry.addLog(plugin.id, 'warn', 'import of the built-in data failed: ' + String((e && e.code) || 'error'));
      throw new LegacyError('legacy_failed', 'the plugin could not import the data');
    }
    if (!out || out.ok === false) {
      registry.addLog(plugin.id, 'warn', 'import of the built-in data refused by the plugin');
      throw new LegacyError('legacy_failed', 'the plugin could not import the data');
    }
    const counts = {};
    for (const [k, list] of Object.entries(data)) counts[k] = list.length;
    getDb().prepare(`INSERT INTO plugin_legacy_imports (plugin_id, dataset, imported_at, counts, runs) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(plugin_id) DO UPDATE SET dataset = excluded.dataset, imported_at = excluded.imported_at, counts = excluded.counts, runs = runs + 1`)
      .run(plugin.id, def.dataset, new Date().toISOString(), JSON.stringify(counts));
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
    registry.addLog(plugin.id, 'info', `built-in data imported (${def.dataset}): ${summary}`);
    require('../activity').log('plugin_legacy_imported', `Plugin "${plugin.name}": built-in ${def.dataset} data imported (${summary})`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { plugin: plugin.id, dataset: def.dataset, counts, targetsAdded },
    });
    return { counts, targetsAdded, imported: record(plugin.id) };
  } finally {
    busy.delete(plugin.id);
  }
}

module.exports = { LegacyError, DATASETS, defOf, replaced, replacedMap, guardApi, status, runImport, forget, eligibility };

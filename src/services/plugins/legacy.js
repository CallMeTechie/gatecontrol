'use strict';

// Built-in → plugin migration (docs/plugins.md "Built-in data import").
//
// Smart Home (deCONZ), Klimaanlage (Midea), Fahrzeuge (Škoda) and Remote
// Desktops (→ "Fernzugriff", see `remote` below) used to be built into
// GateControl. Their code is gone — the features are the
// first-party plugins listed in DATASETS below — but their tables and
// settings are kept (never dropped, still in backups) so an existing
// installation can bring its data into the plugin:
//
//   1. a ONE-TIME DATA IMPORT: the plugin whose id is listed in DATASETS
//      may receive a JSON snapshot of exactly the mapped built-in tables
//      (read here directly, secrets decrypted for this hand-over only, never
//      logged). The administrator starts it from the plugin's detail page
//      (offered as soon as the plugin runs, re-runnable while the built-in
//      data exists). The host pushes the snapshot into the plugin's
//      `legacyImport(snapshot, gc)` hook, which writes it into the plugin's
//      own storage. GateControl routes and LAN addresses the built-in rows
//      referenced are turned into assignments of the plugin's home target
//      first, so the administrator does not have to assign them again. Every
//      run is recorded (plugin_legacy_imports).
//
//   2. an UPGRADE NOTICE (pendingMoves): while built-in data exists, the
//      mapped plugin is not installed and the data was never imported,
//      Settings → Plugins and the dashboard say that the feature is a plugin
//      now and offer it (official catalogue: "Jetzt installieren"; the
//      plugin's releases as a fallback). A successful import sets a marker
//      per dataset (settings key plugins.legacy_imported.<dataset>) that
//      survives an uninstall — the built-in tables are never dropped, so
//      without it the notice would come back for good. The former pages
//      (/smarthome, /midea, /skoda) lead to the plugin's page when it is
//      installed, otherwise to Settings → Plugins (movedPage).
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

/** 'YYYY-MM-DD HH:MM:SS' (SQLite, UTC) or an ISO string → ms; 0 when unreadable. */
function sqliteMs(v) {
  if (typeof v !== 'string' || !v) return 0;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  return Number.isFinite(t) ? t : 0;
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

const skoda = {
  /** Row counts of the built-in tables (no secrets). */
  counts() {
    if (!tableExists('skoda_accounts')) return { accounts: 0, vehicles: 0, owners: 0 };
    const db = getDb();
    const n = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    return { accounts: n('skoda_accounts'), vehicles: n('skoda_vehicles'), owners: n('skoda_vehicle_owners') };
  },
  /**
   * Snapshot of skoda_accounts / _vehicles / _vehicle_owners. The MySkoda
   * password, S-PIN and session tokens are decrypted here — the snapshot only
   * ever goes to the plugin process. The render image travels as base64.
   */
  export() {
    const { decrypt } = require('../../utils/crypto');
    const db = getDb();
    const plain = (enc) => { if (!enc) return null; try { return decrypt(enc); } catch { return null; } };
    const accounts = db.prepare('SELECT * FROM skoda_accounts ORDER BY id').all().map((a) => {
      let session = null;
      const raw = plain(a.session_enc);
      if (raw) {
        const s = parseJson(raw, null);
        if (s && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string') session = { accessToken: s.accessToken, refreshToken: s.refreshToken };
      }
      return {
        id: a.id, email: a.email, password: plain(a.password_enc), spin: plain(a.spin_enc), session,
        status: a.status || 'ok', status_detail: a.status_detail || null, backoff_min: Number(a.backoff_min) || 0, next_retry_at: a.next_retry_at || null,
        created_at: a.created_at || null, updated_at: a.updated_at || null,
      };
    });
    const vehicles = db.prepare('SELECT * FROM skoda_vehicles ORDER BY id').all().map((v) => ({
      id: v.id, account_id: v.account_id, vin: v.vin, name: v.name || null, model: v.model || null, state: parseJson(v.state_json, null),
      image: v.image ? Buffer.from(v.image).toString('base64') : null, image_url: v.image_url || null,
      fetched_at: v.fetched_at || null, created_at: v.created_at || null,
    }));
    const owners = db.prepare('SELECT skoda_vehicle_id, user_id, created_at FROM skoda_vehicle_owners ORDER BY skoda_vehicle_id, user_id').all()
      .map((o) => ({ vehicle_id: o.skoda_vehicle_id, user_id: o.user_id, created_at: o.created_at || null }));
    return { accounts, vehicles, owners };
  },
  /** A cloud integration: nothing in the home network becomes a target. */
  targetRefs() {
    return [];
  },
};

// Remote Desktops → the shop plugin "Fernzugriff" (gatecontrol-remote, gc.remote). Like the three above
// the built-in feature is gone (docs/feature-remote-access.md "Remote Desktops removed"): no page, no admin
// API, the old app API is answered by the plugin only (services/remote/facade.js). The tables rdp_routes and
// rdp_sessions stay as the old stock ("Altbestand": never dropped, still in backups, a restore of an old
// backup puts its rows back) until the plugin took them over; while rows are there that the installed
// plugin has not got yet — never imported, changed or restored after the last import (pendingImport) —
// the dashboard, the plugin area and the plugin's page say "Alte Remote Desktops noch nicht übernommen".
// Secrets never go into the snapshot: every credential
// set of a route becomes an entry of the core's key vault (services/remote/vault.js) and the snapshot
// carries its handle — idempotent per route (source "rdp_route:<id>"), so "Erneut übernehmen" refreshes
// the same handles. Ids stay (routes[].id = rdp_routes.id, sessions[].route_id), so the plugin's rights and
// history keep matching; the tables stay and keep going into backups.
const REMOTE_SESSIONS_MAX = 20000;

const remote = {
  /** The latest change of a row (rdp_routes.updated_at, SQLite UTC) as ms, or 0. */
  changedAt() {
    if (!tableExists('rdp_routes')) return 0;
    const r = getDb().prepare('SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM rdp_routes').get();
    return sqliteMs(r && r.t);
  },
  counts() {
    if (!tableExists('rdp_routes')) return { routes: 0, sessions: 0, maintenance: 0 };
    const db = getDb();
    return {
      routes: db.prepare('SELECT COUNT(*) AS c FROM rdp_routes').get().c,
      sessions: tableExists('rdp_sessions') ? db.prepare('SELECT COUNT(*) AS c FROM rdp_sessions').get().c : 0,
      maintenance: db.prepare('SELECT COUNT(*) AS c FROM rdp_routes WHERE maintenance_enabled = 1').get().c,
    };
  },
  /**
   * Snapshot of rdp_routes (with vault handles instead of credentials), rdp_sessions (the newest
   * REMOTE_SESSIONS_MAX) and the maintenance windows. `plugin` owns the vault entries.
   */
  export(plugin) {
    if (!tableExists('rdp_routes')) return { routes: [], sessions: [], maintenance: [] };
    const db = getDb();
    const vault = require('../remote/vault');
    const rdpCreds = require('../rdpCredentials');
    const ids = (v) => { const a = parseJson(v, null); return Array.isArray(a) ? a.filter((x) => Number.isSafeInteger(x)) : null; };
    const list = (v) => { const a = parseJson(v, null); return Array.isArray(a) ? a : (typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []); };
    const bool = (v) => v === 1 || v === true;
    const SECRET = new Set(['username_encrypted', 'password_encrypted', 'ssh_private_key_encrypted', 'ssh_passphrase_encrypted',
      'sftp_password_encrypted', 'sftp_private_key_encrypted', 'sftp_passphrase_encrypted', 'screenshot_data']);
    const BOOLS = ['enabled', 'multi_monitor', 'redirect_clipboard', 'redirect_printers', 'redirect_drives', 'redirect_usb', 'redirect_smartcard',
      'nla_enabled', 'disable_wallpaper', 'disable_themes', 'disable_animations', 'admin_session', 'wol_enabled', 'maintenance_enabled',
      'sharing_enabled', 'sharing_require_consent', 'screenshot_enabled', 'credential_rotation_enabled', 'health_check_enabled',
      'browser_enabled', 'browser_enable_sftp', 'sftp_disable_download', 'sftp_disable_upload', 'browser_enable_audio', 'browser_clipboard'];
    const routes = db.prepare('SELECT * FROM rdp_routes ORDER BY id').all().map((r) => {
      const c = rdpCreds.decryptCredentials(r);
      const out = {};
      for (const [k, v] of Object.entries(r)) if (!SECRET.has(k)) out[k] = v === undefined ? null : v;
      for (const k of BOOLS) if (k in out) out[k] = bool(out[k]);
      out.user_ids = ids(r.user_ids);
      out.group_ids = ids(r.group_ids);
      out.token_ids = ids(r.token_ids);
      out.tags = list(r.tags);
      out.protocol = r.protocol || 'rdp';
      // the credentials of the route → one vault entry (none when nothing is stored); the SFTP ones → a second
      const main = { username: c.username, password: c.password, domain: r.domain || null, privateKey: c.ssh_private_key, passphrase: c.ssh_passphrase };
      const has = Object.values(main).some((v) => v);
      out.credential = has ? vault.put(plugin.id, { ...main, label: String(r.name || '').slice(0, 120) || null }, { source: `rdp_route:${r.id}` }).handle : null;
      const sftp = { password: c.sftp_password, privateKey: c.sftp_private_key, passphrase: c.sftp_passphrase, username: r.sftp_username || null };
      out.sftp_credential = (sftp.password || sftp.privateKey)
        ? vault.put(plugin.id, { ...sftp, label: (String(r.name || '').slice(0, 110) + ' (SFTP)') }, { source: `rdp_route:${r.id}:sftp` }).handle : null;
      // a field that could not be decrypted (another server key): the plugin asks for it again
      out.credential_unreadable = !!c.decrypt_failed || c.decrypt_failed_fields.size > 0;
      return out;
    });
    const sessions = tableExists('rdp_sessions')
      ? db.prepare(`SELECT * FROM rdp_sessions ORDER BY id DESC LIMIT ${REMOTE_SESSIONS_MAX}`).all().reverse().map((x) => ({
        id: x.id, route_id: x.rdp_route_id, token_id: x.token_id ?? null, token_name: x.token_name || null, peer_id: x.peer_id ?? null,
        status: x.status, started_at: x.started_at || null, last_heartbeat: x.last_heartbeat || null, ended_at: x.ended_at || null,
        duration_seconds: x.duration_seconds ?? null, end_reason: x.end_reason || null, client_ip: x.client_ip || null,
        via: x.via || 'native', protocol: x.protocol || 'rdp',
      }))
      : [];
    const maintenance = routes.filter((r) => r.maintenance_enabled || r.maintenance_schedule).map((r) => ({
      route_id: r.id, enabled: r.maintenance_enabled, schedule: r.maintenance_schedule || null,
    }));
    return { routes, sessions, maintenance };
  },
  /** Targets of a gateway become gc.remote listeners of the plugin (it reuses the routes' L4 ports), no home target. */
  targetRefs() {
    return [];
  },
};

/**
 * Fixed mapping: plugin id → the built-in dataset it may import. `target` is
 * the plugin's home target that the GateControl routes / LAN addresses
 * referenced by the data become (one per gateway / LAN air conditioner;
 * source.targetRefs); null for a cloud integration without a home target
 * (skoda).
 */
const DATASETS = new Map([
  ['gatecontrol-smarthome', Object.freeze({ dataset: 'smarthome', target: 'gateway', source: smarthome })],
  ['gatecontrol-midea', Object.freeze({ dataset: 'midea', target: 'ac', source: midea })],
  ['gatecontrol-skoda', Object.freeze({ dataset: 'skoda', target: null, source: skoda })],
  // the upgrade notice ("Remote Desktops ist jetzt das Plugin „Fernzugriff“", i18n plugins.moved.remote); `installedNotice`:
  // also while the installed plugin has not got the old rows yet (pendingImport, i18n plugins.moved.remote_pending)
  ['gatecontrol-remote', Object.freeze({ dataset: 'remote', target: null, source: remote, installedNotice: true })],
]);

function defOf(pluginId) {
  if (typeof pluginId !== 'string') return null;
  if (DATASETS.has(pluginId)) return DATASETS.get(pluginId);
  // a first-party plugin that replaced a listed one (plugin.json `replaces`) imports its dataset
  let p = null;
  try { p = registry.get(pluginId); } catch { p = null; }
  const old = p && p.signature === 'trusted' && Array.isArray(p.manifest.replaces) ? p.manifest.replaces.find((id) => DATASETS.has(id)) : null;
  return old ? DATASETS.get(old) : null;
}

// ─── Upgrade notice and former pages ───────────

// Releases of the first-party plugins (one tag per plugin: <id>-v<version>).
const RELEASES_URL = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases';

/** The release list of one plugin (newest first). */
function releaseUrl(pluginId) {
  return `${RELEASES_URL}?q=${encodeURIComponent(pluginId)}&expanded=true`;
}

/** Is the plugin installed (on or off, any state)? */
/** Installed — under this id or as the plugin that replaced it. */
function installed(pluginId) {
  try { return !!registry.resolve(pluginId); } catch { return false; }
}

// ─── "imported once" marker ────────────────────
// Set by every successful import; never removed by an uninstall (also not by
// "Alles löschen", which only forgets the plugin's import record). Its only
// job is to keep the upgrade notice away once the data reached a plugin.

const MARKER_PREFIX = 'plugins.legacy_imported.';

// A restore that put built-in rows back (backup.js): they may be rows the plugin has not got.
const RESTORED_PREFIX = 'plugins.legacy_restored.';

function markRestored(dataset) {
  try { require('../settings').set(RESTORED_PREFIX + dataset, new Date().toISOString()); } catch { /* best-effort */ }
}

function markImported(dataset) {
  try { require('../settings').set(MARKER_PREFIX + dataset, new Date().toISOString()); } catch { /* the record stays the source of truth */ }
}

/** Was this dataset's built-in data ever imported into its plugin? */
function everImported(pluginId) {
  const def = defOf(pluginId);
  if (!def) return false;
  try { if (require('../settings').get(MARKER_PREFIX + def.dataset)) return true; } catch { /* fall through */ }
  // installations that imported before the marker existed: their record (kept by "Daten behalten")
  try { return !!getDb().prepare('SELECT 1 FROM plugin_legacy_imports WHERE plugin_id = ?').get(pluginId); } catch { return false; }
}

/**
 * Built-in datasets that still hold data while their plugin is not installed
 * and was never given that data: [{ pluginId, dataset, counts, url }] (the
 * upgrade notice). Never throws.
 */
function pendingMoves() {
  const out = [];
  for (const [id, def] of DATASETS) {
    if (def.notice === false) continue;
    if (def.installedNotice && installed(id)) {
      let pend = null;
      try { pend = pendingImport(registry.resolve(id)); } catch { pend = null; }
      if (pend) out.push({ pluginId: id, dataset: def.dataset, counts: pend.counts, installed: true, reason: pend.reason, manageUrl: pend.manageUrl });
      continue;
    }
    if (installed(id) || everImported(id)) continue;
    let counts;
    try { counts = def.source.counts(); } catch { continue; }
    if (!Object.values(counts).some((n) => n > 0)) continue;
    out.push({ pluginId: id, dataset: def.dataset, counts, url: releaseUrl(id), catalog: catalogEnabled() });
  }
  return out;
}

function catalogEnabled() {
  try { return require('./catalog').enabled(); } catch { return false; }
}

/**
 * Built-in rows the INSTALLED plugin `plugin` has not got yet (datasets with
 * `installedNotice`): null, or { dataset, counts, reason: never | changed,
 * manageUrl } — never: this plugin never imported (also after "Alles
 * löschen": its record went with its data); changed: a row changed or a
 * restore put rows back after its last import. Never throws.
 */
function pendingImport(plugin) {
  try {
    if (!plugin || !plugin.id) return null;
    const def = defOf(plugin.id);
    if (!def || !def.installedNotice) return null;
    const counts = def.source.counts();
    if (!Object.values(counts).some((n) => n > 0)) return null;
    const manageUrl = `/settings/plugins/manage/${encodeURIComponent(plugin.id)}`;
    const rec = record(plugin.id);
    const at = rec ? sqliteMs(rec.at) : 0;
    if (!at) return { dataset: def.dataset, counts, reason: 'never', manageUrl };
    let restored = 0;
    try { restored = sqliteMs(require('../settings').get(RESTORED_PREFIX + def.dataset)); } catch { restored = 0; }
    const changed = typeof def.source.changedAt === 'function' ? def.source.changedAt() : 0;
    if (Math.max(restored, changed) > at) return { dataset: def.dataset, counts, reason: 'changed', manageUrl };
    return null;
  } catch { return null; }
}

/**
 * Where a former built-in page leads: the plugin's page (`sub` = its sub
 * page, e.g. "/rules") when the plugin is installed, else its catalogue page
 * (the plugin area's start page when the catalogue is switched off).
 * Fixed paths only, never request data.
 */
function movedPage(pluginId, sub = '') {
  if (defOf(pluginId) && installed(pluginId)) return `/plugins/${registry.resolve(pluginId).id}${sub}`;
  return catalogEnabled() ? `/settings/plugins/catalog/${pluginId}` : '/settings/plugins';
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

/**
 * "Alles löschen": the plugin's import record goes, so a reinstall shows the
 * import as not done yet (offered again, "Daten übernehmen"). The marker of
 * the dataset stays (see everImported).
 */
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
    const data = def.source.export(plugin);
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
    markImported(def.dataset);
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

module.exports = { LegacyError, DATASETS, defOf, status, runImport, forget, eligibility, pendingMoves, pendingImport, markRestored, everImported, movedPage, releaseUrl };

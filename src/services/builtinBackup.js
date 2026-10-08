'use strict';

// Backup part of the former built-in integrations (Smart Home, Klimaanlage,
// Fahrzeuge). Their code is gone — they are first-party plugins now — but
// their tables stay until the administrator imports the data into the plugin
// (docs/plugins.md "Built-in data import", services/plugins/legacy.js). So a
// backup carries them, and a restore brings them back, until then.
//
// Rows travel as they are stored: ids kept (rules and owner rows reference
// them), secrets still encrypted (an off-site re-key converts them like every
// other secret). The references to GateControl data whose ids change on a
// restore travel by name: user_id → user_name, a gateway's route_id →
// route_domain. A backup without this part (older ones) leaves the tables
// untouched.

const logger = require('../utils/logger');

const TABLES = Object.freeze([
  { name: 'smarthome_gateways', route: 'route_id' },
  { name: 'smarthome_resources' },
  { name: 'smarthome_resource_owners', user: 'user_id' },
  { name: 'smarthome_rules' },
  { name: 'midea_devices' },
  { name: 'midea_device_owners', user: 'user_id' },
  { name: 'skoda_accounts' },
  { name: 'skoda_vehicles', blob: 'image' },
  { name: 'skoda_vehicle_owners', user: 'user_id' },
]);
const NAMES = new Set(TABLES.map((t) => t.name));
const MAX_ROWS = 100000;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/** { <table>: [rows] } of every built-in table present (empty object when none). */
function exportAll(db) {
  const out = {};
  const userName = new Map(db.prepare('SELECT id, username FROM users').all().map((u) => [u.id, u.username]));
  const routeDomain = new Map(db.prepare('SELECT id, domain FROM routes').all().map((r) => [r.id, r.domain]));
  for (const t of TABLES) {
    if (!tableExists(db, t.name)) continue;
    out[t.name] = db.prepare(`SELECT * FROM ${t.name}`).all().map((row) => {
      const r = { ...row };
      if (t.user) { r.user_name = userName.get(r[t.user]) || null; delete r[t.user]; }
      if (t.route) { r.route_domain = r[t.route] == null ? null : (routeDomain.get(r[t.route]) || null); delete r[t.route]; }
      if (t.blob) { r[t.blob + '_base64'] = r[t.blob] ? Buffer.from(r[t.blob]).toString('base64') : null; delete r[t.blob]; }
      return r;
    });
  }
  return out;
}

/** Structure check of a backup's built-in part (absent = fine). */
function validate(part) {
  if (part === undefined || part === null) return [];
  if (typeof part !== 'object' || Array.isArray(part)) return ['Invalid backup: builtin_integrations must be an object'];
  const errors = [];
  for (const [name, rows] of Object.entries(part)) {
    if (!NAMES.has(name)) errors.push(`Invalid backup: builtin_integrations.${String(name).slice(0, 40)} is unknown`);
    else if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
      errors.push(`Invalid backup: builtin_integrations.${name} must be a list of rows`);
    }
  }
  return errors;
}

/**
 * Replace the built-in tables named in the backup with its rows. Runs inside
 * the restore transaction, after users and routes (references by name).
 * @returns {number} rows restored
 */
function restoreAll(db, part, { userIdByName }) {
  if (!part || typeof part !== 'object') return 0;
  const routeByDomain = db.prepare("SELECT id FROM routes WHERE domain = ? ORDER BY (route_type = 'http') DESC, id LIMIT 1");
  let n = 0;
  for (const t of TABLES) {
    const rows = part[t.name];
    if (!Array.isArray(rows) || !tableExists(db, t.name)) continue;
    db.prepare(`DELETE FROM ${t.name}`).run();
    const cols = columnsOf(db, t.name);
    for (const src of rows) {
      const row = { ...src };
      if (t.user) {
        const uid = row.user_name ? userIdByName.get(row.user_name) : null;
        if (!uid) continue; // the owner is not on this server
        row[t.user] = uid;
      }
      if (t.route) {
        const hit = row.route_domain ? routeByDomain.get(row.route_domain) : null;
        row[t.route] = hit ? hit.id : null;
      }
      if (t.blob) row[t.blob] = typeof row[t.blob + '_base64'] === 'string' ? Buffer.from(row[t.blob + '_base64'], 'base64') : null;
      const use = cols.filter((c) => row[c] !== undefined);
      try {
        db.prepare(`INSERT INTO ${t.name} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((c) => row[c]));
        n++;
      } catch (e) {
        logger.warn({ err: e.message, table: t.name }, 'built-in integration row restore skipped');
      }
    }
  }
  return n;
}

module.exports = { exportAll, validate, restoreAll, TABLES };

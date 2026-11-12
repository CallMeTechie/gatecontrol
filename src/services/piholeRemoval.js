'use strict';

// The Pi-hole integration is gone (replaced by the DNS protection, a plugin
// with permissions.vpnDns). What an installation that had it still carries is
// taken out here — by migration 147, again at every start of the server and
// after a restore (a backup from before the removal brings it all back):
//   settings   pihole_config (URLs and the instances' app passwords),
//              pihole_blocking_desired, portal.widget.pihole
//   api_tokens, client_enrollment_codes   the scopes `pihole` / `pihole:control`
// Statistics were only ever held in memory — there is no table to drop.
// dnsmasq is not this module's business: services/dnsChain.js puts it on the
// default upstreams (or on the DNS protection) at every start.
//
// Installations that had Pi-hole set up get one activity entry and a notice
// on the dashboard (NOTICE_KEY, gone once an administrator closes it).

const SETTINGS = ['pihole_config', 'pihole_blocking_desired', 'portal.widget.pihole'];
const SCOPES = ['pihole', 'pihole:control'];
const NOTICE_KEY = 'pihole_removed.notice';
const EVENT = 'pihole_integration_removed';
const MESSAGE = 'The Pi-hole integration was removed from GateControl — its settings and stored credentials were deleted. Replacement: the DNS protection plugin';
// The plugin the notice leads to when none with permissions.vpnDns is installed.
const CATALOG_PLUGIN = 'gatecontrol-dns';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Was Pi-hole set up? (switched on, or at least one instance entered) */
function wasConfigured(raw) {
  if (!raw) return false;
  try {
    const c = JSON.parse(raw);
    return !!(c && (c.enabled || (Array.isArray(c.instances) && c.instances.length > 0)));
  } catch {
    return true; // a row that cannot be read was still put there by somebody
  }
}

function stripScopes(db, table, idColumn) {
  if (!tableExists(db, table)) return 0;
  const set = db.prepare(`UPDATE ${table} SET scopes = ? WHERE ${idColumn} = ?`);
  let changed = 0;
  for (const row of db.prepare(`SELECT ${idColumn} AS id, scopes FROM ${table} WHERE scopes LIKE '%pihole%'`).all()) {
    let list;
    try { list = JSON.parse(row.scopes); } catch { continue; }
    if (!Array.isArray(list)) continue;
    const kept = list.filter((s) => !SCOPES.includes(s));
    if (kept.length === list.length) continue;
    set.run(JSON.stringify(kept), row.id);
    changed += 1;
  }
  return changed;
}

/**
 * Take the leftovers out of the database. Idempotent; cheap when there is
 * nothing (two small reads). Uses nothing but `db`, so the migration runner
 * can call it inside its transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {{ notice?: boolean }} [opts] notice: false = no activity entry
 *   and no dashboard notice, whatever is found
 * @returns {{ configured: boolean, settings: number, tokens: number }}
 */
function purge(db, { notice = true } = {}) {
  if (!tableExists(db, 'settings')) return { configured: false, settings: 0, tokens: 0 };
  const row = db.prepare("SELECT value FROM settings WHERE key = 'pihole_config'").get();
  const configured = wasConfigured(row && row.value);
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  let settings = 0;
  for (const key of SETTINGS) settings += del.run(key).changes;
  const tokens = stripScopes(db, 'api_tokens', 'id') + stripScopes(db, 'client_enrollment_codes', 'code_hash');
  if (configured && notice) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`).run(NOTICE_KEY);
    if (tableExists(db, 'activity_log')) {
      db.prepare(`INSERT INTO activity_log (event_type, message, details, source, severity) VALUES (?, ?, ?, 'system', 'warning')`)
        .run(EVENT, MESSAGE, JSON.stringify({ replacement: CATALOG_PLUGIN }));
    }
  }
  return { configured, settings, tokens };
}

/** At every start of the server (after the migrations). Never throws. */
function atStart() {
  try {
    const r = purge(require('../db/connection').getDb());
    if (r.settings || r.tokens) require('../utils/logger').info(r, 'Pi-hole integration: leftovers removed');
    return r;
  } catch (err) {
    require('../utils/logger').warn({ err: err.message }, 'Pi-hole integration: leftovers not removed');
    return null;
  }
}

/**
 * The notice on the dashboard: null, or where its button leads —
 * the installed plugin with permissions.vpnDns, else the catalogue entry.
 */
function notice() {
  let pending = false;
  try { pending = require('./settings').get(NOTICE_KEY) === '1'; } catch { pending = false; }
  if (!pending) return null;
  let plugin = null;
  try { plugin = require('./vpnDns').installedPlugin(); } catch { plugin = null; }
  return plugin
    ? { installed: true, href: `/settings/plugins/manage/${encodeURIComponent(plugin.id)}` }
    : { installed: false, href: `/settings/plugins/catalog/${CATALOG_PLUGIN}` };
}

/** An administrator closed the notice. */
function dismiss() {
  const db = require('../db/connection').getDb();
  return db.prepare('DELETE FROM settings WHERE key = ?').run(NOTICE_KEY).changes > 0;
}

module.exports = { purge, atStart, notice, dismiss, wasConfigured, SETTINGS, SCOPES, NOTICE_KEY, EVENT, CATALOG_PLUGIN };

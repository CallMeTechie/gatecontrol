'use strict';

/**
 * Directory connections (table `directories`, docs/groups.md
 * "Verzeichnis-Abgleich und Anmeldung"): create / change / delete, the
 * validated configuration per kind and the encrypted secret.
 *
 *   KINDS = ['ad', 'entra', 'ldap']
 *   list() / get(id) → public shape (never the secret; `hasSecret` and a
 *       mask instead; `needsSecret` when none is stored — a backup restored
 *       on a server with another GC_ENCRYPTION_KEY drops it)
 *   load(id) → internal { ...row, config, selectedGroups } | null
 *   secretOf(row) → decrypted secret or ''
 *   create(input, { actor, ip }) / update(id, patch, { actor, ip })
 *       input: { kind, name, config, secret, enabled, loginEnabled,
 *       provision, deprovision, intervalMin, parentGroupId, selectedGroups,
 *       selfEnroll } — selfEnroll: the accounts of this directory may set
 *       up own devices (services/users.js mayEnroll), default off
 *       secret: undefined / '' = keep, string = replace, null = clear
 *   remove(id, { confirmName, actor, ip }) — the imported groups are
 *       archived (access through them ends), links, conflicts and runs go;
 *       the accounts stay (as local accounts without password).
 *   cleanConfig(kind, config) — validation per kind (throws err.code)
 */

const { getDb } = require('../../db/connection');
const { encrypt, decrypt } = require('../../utils/crypto');
const activity = require('../activity');
const logger = require('../../utils/logger');

const KINDS = Object.freeze(['ad', 'entra', 'ldap']);
const INTERVAL_MIN = 5;
const INTERVAL_MAX = 1440;
const INTERVAL_DEFAULT = 15;
const MASK = '••••••••';
const MAX_SELECTED = 200;

function codedError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function toId(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

function str(v, max, field) {
  if (v == null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw codedError('INVALID', `${field} must be text`, { field });
  const s = String(v).trim();
  if (s.length > max) throw codedError('INVALID', `${field} is too long`, { field });
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw codedError('INVALID', `${field} contains control characters`, { field });
  return s;
}

function cleanCa(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > 20000) throw codedError('INVALID_CA', 'the CA certificate must be PEM text', { field: 'caCert' });
  const s = v.trim();
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(s)) throw codedError('INVALID_CA', 'the CA certificate must be PEM text', { field: 'caCert' });
  try {
    // eslint-disable-next-line no-new
    new (require('node:crypto').X509Certificate)(s);
  } catch {
    throw codedError('INVALID_CA', 'the CA certificate cannot be read', { field: 'caCert' });
  }
  return s;
}

/** Validated, normalised configuration for `kind` (no secret in here). */
function cleanConfig(kind, input) {
  const c = input && typeof input === 'object' ? input : {};
  if (kind === 'entra') {
    const { tenantId, clientId } = require('./entra').checkConfig(c);
    return { tenantId, clientId };
  }
  const conn = require('./ldapConn');
  const { host, port, security } = conn.checkServer(c);
  const out = {
    host, port, security,
    tlsServerName: str(c.tlsServerName, 253, 'tlsServerName'),
    caCert: cleanCa(c.caCert),
    baseDn: str(c.baseDn, 500, 'baseDn'),
    userBaseDn: str(c.userBaseDn, 500, 'userBaseDn'),
    groupBaseDn: str(c.groupBaseDn, 500, 'groupBaseDn'),
    bindDn: str(c.bindDn, 500, 'bindDn'),
  };
  if (!out.baseDn) throw codedError('INVALID_BASE_DN', 'base DN is required', { field: 'baseDn' });
  if (!out.bindDn) throw codedError('INVALID_BIND_DN', 'service account is required', { field: 'bindDn' });
  if (kind === 'ldap') {
    const ldap = require('./ldap');
    out.userFilter = str(c.userFilter, 500, 'userFilter');
    out.groupFilter = str(c.groupFilter, 500, 'groupFilter');
    out.attrs = { ...(c.attrs && typeof c.attrs === 'object' ? c.attrs : {}) };
    const s = ldap.settings(out); // validates filters and attribute names
    out.attrs = s.attrs;
    out.userFilter = out.userFilter || '';
    out.groupFilter = out.groupFilter || '';
  }
  return out;
}

function cleanSelected(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw codedError('INVALID', 'selectedGroups must be a list', { field: 'selectedGroups' });
  if (list.length > MAX_SELECTED) throw codedError('INVALID', `at most ${MAX_SELECTED} groups`, { field: 'selectedGroups' });
  const seen = new Set();
  const out = [];
  for (const g of list) {
    if (!g || typeof g !== 'object') throw codedError('INVALID', 'invalid group', { field: 'selectedGroups' });
    const externalId = str(g.externalId, 200, 'externalId');
    const name = str(g.name, 200, 'name');
    if (!externalId || !name) throw codedError('INVALID', 'a group needs externalId and name', { field: 'selectedGroups' });
    if (seen.has(externalId.toLowerCase())) continue;
    seen.add(externalId.toLowerCase());
    out.push({ externalId, name, dn: str(g.dn, 1000, 'dn') || null });
  }
  return out;
}

function cleanInterval(v) {
  if (v == null || v === '') return INTERVAL_DEFAULT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) throw codedError('INVALID_INTERVAL', `interval must be ${INTERVAL_MIN}–${INTERVAL_MAX} minutes`, { field: 'intervalMin' });
  return n;
}

function cleanName(v) {
  const s = str(v, 100, 'name');
  if (!s) throw codedError('INVALID_NAME', 'name is required', { field: 'name' });
  return s;
}

function cleanParent(db, v) {
  if (v == null || v === '') return null;
  const id = toId(v);
  const g = id && db.prepare('SELECT id, source, kind, parent_id FROM groups WHERE id = ?').get(id);
  if (!g) throw codedError('INVALID_PARENT', 'parent group not found', { field: 'parentGroupId' });
  if (g.source !== 'local') throw codedError('INVALID_PARENT', 'the parent must be a local group', { field: 'parentGroupId' });
  if (g.kind === 'family') throw codedError('INVALID_PARENT', 'a family cannot have subgroups', { field: 'parentGroupId' });
  return id;
}

function bool(v, dflt) { return v == null ? dflt : (v === true || v === 1 || v === '1' || v === 'true'); }

function load(id) {
  const rid = toId(id);
  if (!rid) return null;
  const row = getDb().prepare('SELECT * FROM directories WHERE id = ?').get(rid);
  if (!row) return null;
  return { ...row, config: parseJson(row.config_json, {}), selectedGroups: parseJson(row.selected_groups, []) };
}

function secretOf(row) {
  if (!row || !row.secret_enc) return '';
  try { return decrypt(row.secret_enc); } catch (err) {
    logger.warn({ directoryId: row.id, err: err.message }, 'directory secret cannot be decrypted');
    return '';
  }
}

function redirectUri(id) {
  let base = '';
  try { base = new URL(require('../../../config/default').app.baseUrl).origin; } catch { base = ''; }
  return `${base}/auth/oidc/${id}/callback`;
}

function stats(db, id) {
  const r = db.prepare(`SELECT COUNT(*) AS linked,
      SUM(CASE WHEN u.enabled = 1 THEN 1 ELSE 0 END) AS active
    FROM directory_links l JOIN users u ON u.id = l.user_id WHERE l.directory_id = ?`).get(id);
  const groups = db.prepare("SELECT COUNT(*) AS c FROM groups WHERE source = ? AND archived_at IS NULL").get(`directory:${id}`).c;
  const conflicts = db.prepare("SELECT COUNT(*) AS c FROM directory_conflicts WHERE directory_id = ? AND status = 'open'").get(id).c;
  return { linked: r.linked || 0, active: r.active || 0, disabled: (r.linked || 0) - (r.active || 0), groups, openConflicts: conflicts };
}

function shape(row) {
  if (!row) return null;
  const db = getDb();
  const config = { ...row.config };
  const pending = db.prepare("SELECT id, started_at, guard_reason, summary_json FROM directory_runs WHERE directory_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(row.id);
  const out = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled === 1,
    loginEnabled: row.login_enabled === 1,
    provision: row.provision === 1,
    deprovision: row.deprovision === 1,
    selfEnroll: row.self_enroll === 1,
    intervalMin: row.interval_min,
    parentGroupId: row.parent_group_id,
    config,
    hasSecret: !!row.secret_enc,
    // no secret stored (e.g. restored from a backup made with another
    // GC_ENCRYPTION_KEY): enter it again; the schedule skips the directory
    needsSecret: !row.secret_enc,
    secret: row.secret_enc ? MASK : '',
    selectedGroups: row.selectedGroups,
    lastSyncAt: row.last_sync_at,
    lastFullSyncAt: row.last_full_sync_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    stats: stats(db, row.id),
    pendingRun: pending ? { id: pending.id, startedAt: pending.started_at, reason: pending.guard_reason, summary: parseJson(pending.summary_json, {}) } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === 'entra') out.redirectUri = redirectUri(row.id);
  return out;
}

function list() {
  const rows = getDb().prepare('SELECT id FROM directories ORDER BY id').all();
  return rows.map((r) => shape(load(r.id)));
}

function get(id) { return shape(load(id)); }

function secretValue(v) {
  if (v === undefined || v === '' || v === MASK) return undefined; // keep
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 1024) throw codedError('INVALID_SECRET', 'secret must be text (≤ 1024 characters)', { field: 'secret' });
  return v;
}

function create(input = {}, { actor = null, ip = null } = {}) {
  const db = getDb();
  const kind = input.kind;
  if (!KINDS.includes(kind)) throw codedError('INVALID_KIND', 'kind must be ad, entra or ldap', { field: 'kind' });
  const name = cleanName(input.name);
  const config = cleanConfig(kind, input.config);
  const secret = secretValue(input.secret);
  if (!secret) throw codedError('INVALID_SECRET', kind === 'entra' ? 'client secret is required' : 'service account password is required', { field: 'secret' });
  const info = db.prepare(`INSERT INTO directories (kind, name, config_json, secret_enc, selected_groups, parent_group_id, enabled,
      login_enabled, provision, deprovision, interval_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    kind, name, JSON.stringify(config), encrypt(secret), JSON.stringify(cleanSelected(input.selectedGroups)),
    cleanParent(db, input.parentGroupId), bool(input.enabled, true) ? 1 : 0, bool(input.loginEnabled, false) ? 1 : 0,
    bool(input.provision, true) ? 1 : 0, bool(input.deprovision, true) ? 1 : 0, cleanInterval(input.intervalMin),
  );
  const id = Number(info.lastInsertRowid);
  if (bool(input.selfEnroll, false)) db.prepare('UPDATE directories SET self_enroll = 1 WHERE id = ?').run(id);
  activity.log('directory_created', `Directory "${name}" (${kind}) connected`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { directoryId: id, kind, actorId: actor },
  });
  return get(id);
}

function update(id, patch = {}, { actor = null, ip = null } = {}) {
  const db = getDb();
  const row = load(id);
  if (!row) throw codedError('NOT_FOUND', 'directory not found');
  const p = patch || {};
  const sets = [];
  const vals = [];
  const changed = [];
  const put = (col, val, label) => { sets.push(`${col} = ?`); vals.push(val); changed.push(label || col); };
  if (p.name !== undefined) put('name', cleanName(p.name));
  if (p.config !== undefined) {
    // Fields left out keep their value (the form may send only what changed).
    const merged = { ...row.config, ...(p.config || {}) };
    if (p.config && p.config.attrs && row.config.attrs) merged.attrs = { ...row.config.attrs, ...p.config.attrs };
    put('config_json', JSON.stringify(cleanConfig(row.kind, merged)), 'config');
  }
  const secret = secretValue(p.secret);
  if (secret === null) throw codedError('INVALID_SECRET', 'the secret cannot be removed', { field: 'secret' });
  if (secret !== undefined) put('secret_enc', encrypt(secret), 'secret');
  if (p.selectedGroups !== undefined) put('selected_groups', JSON.stringify(cleanSelected(p.selectedGroups)), 'selectedGroups');
  if (p.parentGroupId !== undefined) put('parent_group_id', cleanParent(db, p.parentGroupId), 'parentGroupId');
  if (p.enabled !== undefined) put('enabled', bool(p.enabled, true) ? 1 : 0, 'enabled');
  if (p.loginEnabled !== undefined) put('login_enabled', bool(p.loginEnabled, false) ? 1 : 0, 'loginEnabled');
  if (p.provision !== undefined) put('provision', bool(p.provision, true) ? 1 : 0, 'provision');
  if (p.deprovision !== undefined) put('deprovision', bool(p.deprovision, true) ? 1 : 0, 'deprovision');
  if (p.intervalMin !== undefined) put('interval_min', cleanInterval(p.intervalMin), 'intervalMin');
  if (p.selfEnroll !== undefined) put('self_enroll', bool(p.selfEnroll, false) ? 1 : 0, 'selfEnroll');
  if (!sets.length) return get(row.id);
  db.prepare(`UPDATE directories SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, row.id);
  activity.log('directory_updated', `Directory "${row.name}" changed (${changed.join(', ')})`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { directoryId: row.id, fields: changed, actorId: actor },
  });
  return get(row.id);
}

function remove(id, { confirmName, actor = null, ip = null } = {}) {
  const db = getDb();
  const row = load(id);
  if (!row) throw codedError('NOT_FOUND', 'directory not found');
  if (typeof confirmName !== 'string' || confirmName.trim() !== row.name) throw codedError('CONFIRM_MISMATCH', 'type the name to confirm');
  const groups = require('../groups');
  const source = `directory:${row.id}`;
  // Archive leaf-first (archive includes the subgroups anyway).
  for (const g of db.prepare('SELECT id FROM groups WHERE source = ? AND archived_at IS NULL ORDER BY id').all(source)) {
    try { groups.archive(g.id, { actor, ip, owner: source, reason: 'directory_removed' }); } catch (err) {
      logger.warn({ groupId: g.id, err: err.message }, 'directory group could not be archived');
    }
  }
  // Without their directory the archived groups become local groups (so an
  // admin can delete or restore them); their members are kept as local ones.
  db.transaction(() => {
    db.prepare("UPDATE group_members SET source = 'local' WHERE source = ?").run(source);
    db.prepare("UPDATE groups SET source = 'local', external_id = NULL, updated_at = datetime('now') WHERE source = ?").run(source);
    db.prepare('DELETE FROM directories WHERE id = ?').run(row.id);
  })();
  activity.log('directory_deleted', `Directory "${row.name}" removed — its groups were archived as local groups, the accounts stay`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { directoryId: row.id, actorId: actor },
  });
  return true;
}

module.exports = {
  KINDS, MASK, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_DEFAULT,
  list, get, load, secretOf, create, update, remove, cleanConfig, cleanSelected, redirectUri, shape, toId,
};

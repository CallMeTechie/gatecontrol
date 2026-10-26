'use strict';

/**
 * Sign-in with the company account — the password form (routes/auth.js).
 *
 *   resolveLogin(login) → users row | null
 *       finds a DIRECTORY account by what people type on the login page:
 *       the Windows login name (sAMAccountName / uid), DOMAIN\name, the UPN
 *       or the e-mail address. Only linked accounts with role 'user' are
 *       considered (local accounts are still found by their exact user name
 *       only, as before). An ambiguous e-mail address matches nothing.
 *   loginRoute(user) → { link, directory } | null
 *       whether the password of this account is checked by its directory:
 *       linked, role 'user' (administrators ALWAYS sign in locally, even
 *       when the directory is down), directory enabled with "Anmeldung"
 *       switched on.
 *   async verifyPassword(user, password) → 'ok' | 'invalid' | 'disabled' |
 *       'unavailable' | 'oidc_only'
 *       an empty password is refused BEFORE the directory is contacted (an
 *       empty bind counts as anonymous and "successful" on some servers);
 *       the password is passed to the LDAP bind and never stored.
 */

const { getDb } = require('../../db/connection');
const store = require('./store');
const adapters = require('./adapters');
const { loginNameOk } = require('./ldapUtil');
const logger = require('../../utils/logger');

const MAX_PASSWORD = 1024;

function resolveLogin(login) {
  if (!loginNameOk(login)) return null;
  const db = getDb();
  const q = login.trim();
  const base = `SELECT u.* FROM directory_links l JOIN users u ON u.id = l.user_id
    JOIN directories d ON d.id = l.directory_id WHERE u.role = 'user' AND `;
  let rows = db.prepare(`${base}(lower(l.login_name) = lower(?) OR lower(l.upn) = lower(?))`).all(q, q);
  if (!rows.length && q.includes('\\')) {
    const name = q.split('\\').pop();
    rows = db.prepare(`${base}d.kind = 'ad' AND lower(l.login_name) = lower(?)`).all(name);
  }
  if (!rows.length && q.includes('@')) {
    rows = db.prepare(`${base}u.email IS NOT NULL AND lower(u.email) = lower(?)`).all(q);
  }
  return rows.length === 1 ? rows[0] : null;
}

function loginRoute(user) {
  if (!user || user.role !== 'user') return null;
  const db = getDb();
  const link = db.prepare('SELECT * FROM directory_links WHERE user_id = ?').get(user.id);
  if (!link) return null;
  const directory = store.load(link.directory_id);
  if (!directory || directory.enabled !== 1 || directory.login_enabled !== 1) return null;
  return { link, directory };
}

async function verifyPassword(user, password) {
  // Refused before anything is sent anywhere.
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD) return 'invalid';
  const route = loginRoute(user);
  if (!route) return 'invalid';
  if (route.directory.kind === 'entra') return 'oidc_only';
  let result;
  try {
    result = await adapters.adapterFor(route.directory).authenticate(route.link, password);
  } catch (err) {
    logger.warn({ directoryId: route.directory.id, err: err && err.message }, 'directory login: directory unreachable');
    return 'unavailable';
  }
  if (result && result.ok) {
    try {
      getDb().prepare('UPDATE directory_links SET last_seen_at = ? WHERE user_id = ?').run(new Date().toISOString(), user.id);
    } catch { /* not important */ }
    return 'ok';
  }
  if (result && result.reason === 'disabled') return 'disabled';
  if (result && result.reason === 'oidc_only') return 'oidc_only';
  return 'invalid';
}

/**
 * What the login page shows: a "Mit Microsoft anmelden" button per Entra
 * directory with sign-in on, and whether an AD/LDAP directory accepts the
 * Windows password (the user-name label then mentions it).
 */
function loginPageInfo() {
  try {
    const rows = getDb().prepare('SELECT id, kind, name FROM directories WHERE enabled = 1 AND login_enabled = 1 ORDER BY id').all();
    return {
      microsoft: rows.filter((r) => r.kind === 'entra').map((r) => ({ id: r.id, name: r.name })),
      password: rows.some((r) => r.kind === 'ad' || r.kind === 'ldap'),
    };
  } catch {
    return { microsoft: [], password: false };
  }
}

module.exports = { resolveLogin, loginRoute, verifyPassword, loginPageInfo, MAX_PASSWORD };

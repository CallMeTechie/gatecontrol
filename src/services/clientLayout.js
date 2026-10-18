'use strict';

/**
 * Order of the apps' Start and Familie tabs, shared by the account
 * (docs/feature-client-layout.md, GET/PUT /api/v1/client/layout).
 *
 * The administrator picks where a layout applies (setting
 * client_layout_scope, Settings › Client-Richtlinien):
 *   device  every device keeps its own order (the apps store it locally,
 *           the server stores nothing — the behaviour before 1.181.0)
 *   user    one order per account, the same on all of its devices (default)
 *   global  one order for everybody; only administrators change it
 *
 * A layout is four lists of entry ids the apps define themselves
 * ('tile:vpn', 'widget:gatecontrol-klima/room:3', 'card:shopping', …):
 *   { start, startHidden, familie, familieHidden }
 * Each list ≤ 100 entries, each entry 1–120 characters [A-Za-z0-9:_./@-],
 * duplicates are removed (the first one stays). The server does not know the
 * ids — it only stores and returns them.
 *
 * A save tells the person's other open push streams (scope user) or every
 * open stream (scope global) with the control event `layout`
 * (services/notify/control.js); a change of the scope tells every open stream.
 */

const { getDb } = require('../db/connection');
const settings = require('./settings');

const SCOPES = Object.freeze(['device', 'user', 'global']);
const DEFAULT_SCOPE = 'user';
const KEY_SCOPE = 'client_layout_scope';
const LISTS = Object.freeze(['start', 'startHidden', 'familie', 'familieHidden']);
const MAX_ENTRIES = 100;
const ENTRY_RE = /^[A-Za-z0-9:_./@-]{1,120}$/;

/** The configured scope ('device' | 'user' | 'global'); anything unknown → the default. */
function getScope() {
  const v = settings.get(KEY_SCOPE, DEFAULT_SCOPE);
  return SCOPES.includes(v) ? v : DEFAULT_SCOPE;
}

/** Store the scope. false for an unknown value (nothing stored). */
function setScope(scope) {
  if (!SCOPES.includes(scope)) return false;
  settings.set(KEY_SCOPE, scope);
  return true;
}

/**
 * A layout sent by an app → { layout } (clean, every list present) or
 * { error: 'invalid_layout' }. Unknown keys are ignored (newer apps), a
 * missing list becomes []; a list that is no array, has more than 100
 * entries or an entry that is no valid id makes the whole layout invalid.
 */
function validate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_layout' };
  const layout = {};
  for (const name of LISTS) {
    const list = raw[name] == null ? [] : raw[name];
    if (!Array.isArray(list) || list.length > MAX_ENTRIES) return { error: 'invalid_layout' };
    if (!list.every((e) => typeof e === 'string' && ENTRY_RE.test(e))) return { error: 'invalid_layout' };
    layout[name] = [...new Set(list)];
  }
  return { layout };
}

function keyFor(scope, userId) {
  return scope === 'global' ? 'global' : `user:${userId}`;
}

/** A stored row's layout, cleaned again (never trusts the column blindly). */
function parse(row) {
  if (!row) return null;
  let raw;
  try { raw = JSON.parse(row.layout); } catch { return null; }
  const v = validate(raw);
  return v.layout || null;
}

/**
 * What GET /api/v1/client/layout answers for one person:
 * { scope, editable, layout | null, updatedAt | null }.
 *   device  layout null, editable true (the app keeps its own)
 *   user    that person's layout (null until saved), editable true
 *   global  the shared layout (null until saved), editable for administrators
 * @param {{ id: number, role: string }} user
 */
function read(user) {
  const scope = getScope();
  if (scope === 'device') return { scope, editable: true, layout: null, updatedAt: null };
  const row = getDb().prepare('SELECT layout, updated_at FROM client_layouts WHERE key = ?').get(keyFor(scope, user.id));
  const layout = parse(row);
  return {
    scope,
    editable: scope === 'user' || user.role === 'admin',
    layout,
    updatedAt: layout ? row.updated_at : null,
  };
}

/**
 * Store a layout for one person in the current scope (validated by the
 * caller with validate(); null removes the stored one — back to the apps'
 * default order). → { updatedAt } or { error: 'device_scope' | 'forbidden' }.
 */
function save(user, layout) {
  const scope = getScope();
  if (scope === 'device') return { error: 'device_scope' };
  if (scope === 'global' && user.role !== 'admin') return { error: 'forbidden' };
  const key = keyFor(scope, user.id);
  const db = getDb();
  if (layout === null) {
    db.prepare('DELETE FROM client_layouts WHERE key = ?').run(key);
    return { scope, updatedAt: null };
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO client_layouts (key, user_id, layout, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(key, scope === 'global' ? null : user.id, JSON.stringify(layout), updatedAt, user.id);
  return { scope, updatedAt };
}

module.exports = { SCOPES, DEFAULT_SCOPE, KEY_SCOPE, LISTS, MAX_ENTRIES, ENTRY_RE, getScope, setScope, validate, read, save };

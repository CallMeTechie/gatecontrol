'use strict';

/**
 * The adapter of a directory row. Every adapter has the same interface (the
 * sync engine and the sign-in only talk to this):
 *
 *   test() → { ok: true, details }                      throws when unreachable / refused
 *   searchGroups(query, { limit }) → [{ externalId, name, dn, description }]
 *   fetch(selectedGroups) → {
 *       groups: [{ externalId, name, dn, found, members: [userExternalId] }],
 *       users:  [{ externalId, loginName, upn, dn, email, displayName, enabled }] }
 *     members are resolved transitively (nested groups count); throws when
 *     the directory cannot be read — the engine then changes nothing.
 *   authenticate(link, password) → { ok, reason?: 'invalid' | 'disabled' |
 *       'not_found' | 'oidc_only', profile? }           throws when unreachable
 *
 * Tests install fakes with _setFactory(fn(row) → adapter).
 */

const store = require('./store');

const CREATORS = {
  ad: (row, opts) => require('./ad').create(row, opts),
  ldap: (row, opts) => require('./ldap').create(row, opts),
  entra: (row, opts) => require('./entra').create(row, opts),
};

let factory = null;

function adapterFor(row) {
  if (factory) return factory(row);
  const create = CREATORS[row && row.kind];
  if (!create) throw new Error(`unknown directory kind ${row && row.kind}`);
  return create(row, { secret: store.secretOf(row) });
}

/** A temporary adapter for unsaved form values (connection test, group search). */
function adapterForDraft(row, secret) {
  if (factory) return factory(row);
  const create = CREATORS[row && row.kind];
  if (!create) throw new Error(`unknown directory kind ${row && row.kind}`);
  return create(row, { secret });
}

function _setFactory(fn) { factory = fn || null; }

module.exports = { adapterFor, adapterForDraft, _setFactory };

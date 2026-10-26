'use strict';

/**
 * Token / user access-check for RDP routes. Pure logic — no DB.
 *
 * The priority order is the same across all entry points (list endpoint
 * via getForToken, direct-by-id endpoints via /client/rdp/:id/*).
 * Keeping the order identical here means a user who cannot SEE a route
 * in the list also cannot REACH it through a known id.
 *
 *   1. route.user_ids or route.group_ids is set → person-level access
 *      (priority): the listed persons ∪ the effective members of the listed
 *      groups (docs/groups.md "Zugriff per Gruppe"). A stale id keeps the
 *      entry closed — it matches nobody.
 *   2. route.token_ids is set → legacy token-level access.
 *   3. neither set            → visible to all.
 *
 * All columns store a JSON-encoded array; bad JSON falls through as
 * "no restriction" (consistent with the pre-refactor behaviour).
 *
 * Group membership comes from the caller (this module stays pure):
 *   opts.userGroups  Set/array of the groups the user effectively belongs to
 *   opts.groupsOf    (userId) → Set/array, called only when the entry lists
 *                    groups (services/rdp.js passes groupAccess.userGroupSet)
 * Without either, a listed group never matches (fail closed).
 */
function idList(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch { return []; /* malformed JSON → treated as "no restriction" (documented above) */ }
}

function canAccessRoute(route, tokenId, userId, opts = {}) {
  if (!route) return false;

  const persons = idList(route.user_ids);
  const groups = idList(route.group_ids).map(Number);
  if (persons.length > 0 || groups.length > 0) {
    if (!userId) return false;
    if (persons.includes(userId)) return true;
    if (!groups.length) return false;
    let mine = opts.userGroups;
    if (!mine && typeof opts.groupsOf === 'function') mine = opts.groupsOf(userId);
    if (!mine) return false;
    const set = mine instanceof Set ? mine : new Set(mine);
    return groups.some((g) => set.has(g));
  }

  const tokens = idList(route.token_ids);
  if (tokens.length > 0) {
    return tokenId ? tokens.includes(tokenId) : false;
  }

  return true;
}

module.exports = { canAccessRoute };

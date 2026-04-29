'use strict';

/**
 * Token / user access-check for RDP routes. Pure logic — no DB.
 *
 * The priority order is the same across all entry points (list endpoint
 * via getForToken, direct-by-id endpoints via /client/rdp/:id/*).
 * Keeping the order identical here means a user who cannot SEE a route
 * in the list also cannot REACH it through a known id.
 *
 *   1. route.user_ids is set  → user-level access (priority).
 *   2. route.token_ids is set → legacy token-level access.
 *   3. neither set            → visible to all.
 *
 * Both columns store a JSON-encoded array; bad JSON falls through as
 * "no restriction" (consistent with the pre-refactor behaviour).
 */
function canAccessRoute(route, tokenId, userId) {
  if (!route) return false;

  if (route.user_ids) {
    try {
      const allowed = JSON.parse(route.user_ids);
      if (Array.isArray(allowed) && allowed.length > 0) {
        return userId ? allowed.includes(userId) : false;
      }
    } catch {}
  }

  if (route.token_ids) {
    try {
      const allowed = JSON.parse(route.token_ids);
      if (Array.isArray(allowed) && allowed.length > 0) {
        return tokenId ? allowed.includes(tokenId) : false;
      }
    } catch {}
  }

  return true;
}

module.exports = { canAccessRoute };

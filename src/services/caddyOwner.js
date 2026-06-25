'use strict';

// ─── Caddy ownership guard ──────────────────────────────────────────────
//
// The deployed container runs with `network_mode: host`, so the Caddy admin
// API on 127.0.0.1:2019 is NOT isolated — every process on the host can POST
// /load and overwrite the live production config. On 2026-06-25 a dev run in
// a `.claude` worktree (no NODE_ENV=test) did exactly that, replacing the 18
// real routes with test-seed routes (x*.0.example.com) for ~90s and breaking
// TLS for domaincaster.com (ERR_SSL_PROTOCOL_ERROR).
//
// The NODE_ENV==='test' guard in caddyAdminClient/caddyConfig only protects
// processes that remember to set it. This module adds a stronger, config-
// driven defence: every config the production instance pushes carries a
// marker route tagged with a persistent per-instance id. Before a full
// /load, the pusher reads the live config's owner; if it belongs to a
// DIFFERENT instance, the push is refused. A foreign process (different data
// dir → different id) therefore cannot clobber production even without
// NODE_ENV=test.
//
// The marker is a ROUTE (not a server-level @id) because Caddy only echoes
// route-level @ids back in GET /config/ — a server-level @id is addressable
// via /id/ but absent from the body, so the foreign owner could not be read.
// Its @id uses the `gc_owner_` prefix; caddyReconciler counts only
// `gc_route_` ids, so the marker never triggers a divergence/repair loop.
//
// Scope: this is an ADVISORY guard against ACCIDENTAL clobbering (a dev/test
// run that forgot NODE_ENV=test), NOT a security boundary. The owner id is
// visible in plaintext over the shared GET /config/, and any host process can
// POST /load directly; a malicious local actor is not in scope (the real fix
// for that is not sharing the admin API via network_mode: host). There is also
// a benign TOCTOU window — two instances that BOTH boot against a fresh
// (unowned) Caddy each read null and claim it, last-write-wins — which is
// acceptable because production runs a single instance and the loser is just a
// transient dev process the reconciler/next sync corrects.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../config/default');
const logger = require('../utils/logger');

const OWNER_ID_PREFIX = 'gc_owner_';
const OWNER_FILE = '.caddy-owner';
// Host that can never appear on the wire (RFC 6761 reserved TLD). The marker
// route matches only this host, so it never serves or shadows a real route.
const MARKER_HOST = 'gc-owner.invalid';

let _cachedOwnerId = null;

// Resolved at call time (not module load) so the persisted owner file follows
// GC_CADDY_DATA_DIR and tests can point it at a temp dir.
function _ownerDataDir() {
  return process.env.GC_CADDY_DATA_DIR
    || (config.caddy && config.caddy.dataDir)
    || '/data/caddy';
}

// This instance's owner id. Persisted under the Caddy data dir so it is
// STABLE across container/process restarts (the prod container always uses
// the same /data/caddy volume). If the file is missing it is created; if it
// cannot be persisted (e.g. a foreign process without write access to the
// dir) an ephemeral id is used — which, being different from prod's persisted
// id, makes that process refuse to clobber prod. Memoised per process.
function getOwnerId() {
  if (_cachedOwnerId) return _cachedOwnerId;

  const file = path.join(_ownerDataDir(), OWNER_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      _cachedOwnerId = existing;
      return _cachedOwnerId;
    }
  } catch { /* missing / unreadable → create below */ }

  const id = crypto.randomBytes(8).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err: err.message, file }, 'Could not persist Caddy owner id — using ephemeral id');
  }
  _cachedOwnerId = id;
  return _cachedOwnerId;
}

// The marker route that stamps ownership into a Caddy config. Appended LAST in
// srv0.routes; the impossible host match means it is never reached.
function ownerMarkerRoute(ownerId) {
  return {
    '@id': OWNER_ID_PREFIX + ownerId,
    match: [{ host: [MARKER_HOST] }],
    handle: [{ handler: 'static_response', status_code: 421 }],
    terminal: true,
  };
}

// Walk a routes array (recursing into subroute handlers, mirroring
// caddyReconciler) looking for the owner marker. Returns the bare owner id
// (without prefix) or null.
function _findOwnerInRoutes(routes) {
  if (!Array.isArray(routes)) return null;
  for (const r of routes) {
    const id = r && r['@id'];
    if (typeof id === 'string' && id.startsWith(OWNER_ID_PREFIX)) {
      return id.slice(OWNER_ID_PREFIX.length);
    }
    const handlers = r && Array.isArray(r.handle) ? r.handle : [];
    for (const h of handlers) {
      if (h && Array.isArray(h.routes)) {
        const found = _findOwnerInRoutes(h.routes);
        if (found) return found;
      }
    }
  }
  return null;
}

// Read the owning instance id from a live Caddy /config/ response, or null if
// the config carries no owner marker (fresh Caddy, or pre-guard version).
function extractOwner(caddyConfig) {
  const servers = caddyConfig && caddyConfig.apps
    && caddyConfig.apps.http && caddyConfig.apps.http.servers;
  if (!servers) return null;
  for (const name of Object.keys(servers)) {
    const found = _findOwnerInRoutes(servers[name] && servers[name].routes);
    if (found) return found;
  }
  return null;
}

// Decision for the sync guard: true ⇒ the live Caddy is owned by a DIFFERENT
// instance and must not be overwritten. An unowned/fresh Caddy (null) is
// claimable, so it is NOT foreign.
function isForeignOwner(liveConfig, myOwnerId) {
  const liveOwner = extractOwner(liveConfig);
  return liveOwner !== null && liveOwner !== myOwnerId;
}

// Full pre-/load ownership decision, given the live config read result.
//   'read-error' — the live config could NOT be read (a thrown error, not the
//                  null "Caddy not running" signal). Ownership is unverifiable,
//                  so fail CLOSED: skip the sync rather than risk clobbering a
//                  foreign-owned Caddy during a transient read glitch.
//   'foreign'    — live config is owned by a different instance → refuse.
//   'proceed'    — claimable (null/fresh) or our own → go ahead.
// Pure (no I/O) so the guard is unit-testable despite _syncToCaddyInner's
// NODE_ENV=test early return.
function ownershipDecision(liveConfig, readError, myOwnerId) {
  if (readError) return 'read-error';
  if (isForeignOwner(liveConfig, myOwnerId)) return 'foreign';
  return 'proceed';
}

function _resetOwnerCache() {
  _cachedOwnerId = null;
}

module.exports = {
  OWNER_ID_PREFIX,
  getOwnerId,
  ownerMarkerRoute,
  extractOwner,
  isForeignOwner,
  ownershipDecision,
  _resetOwnerCache,
};

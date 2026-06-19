// src/services/guacSessions.js
'use strict';
const config = require('../../config/default');
const rdpSessions = require('./rdpSessions');
const { getDb } = require('../db/connection');

// Enumerate INDIVIDUAL active sessions (rdpSessions.getActiveSession* return
// grouped aggregates without id/last_heartbeat — unusable for reclaim/caps).
function listActiveSessions() {
  return getDb().prepare(
    "SELECT id, rdp_route_id, last_heartbeat, peer_id, token_id FROM rdp_sessions WHERE status = 'active'"
  ).all();
}

// Reclaim-before-cap (spec §4, Concern A): free heartbeat-overdue slots, then
// enforce caps (global + per-route + per-user) against the LIVE remainder.
function admitSession({ routeId, tokenId = null, peerId = null, isStale }) {
  const { maxGlobal, maxPerRoute, maxPerUser } = config.guac;

  // 1. Reclaim stale sessions (never touches provably-live ones).
  for (const s of listActiveSessions()) {
    if (typeof isStale === 'function' && isStale(s)) {
      rdpSessions.endSession(s.id, 'reclaimed');
    }
  }

  // 2. Cap checks against the live remainder.
  const live = listActiveSessions();
  if (live.length >= maxGlobal) return { ok: false, reason: 'global_limit' };
  const forRoute = live.filter((s) => s.rdp_route_id === routeId).length;
  if (forRoute >= maxPerRoute) return { ok: false, reason: 'route_limit' };
  if (peerId != null) {
    const forUser = live.filter((s) => s.peer_id === peerId).length;
    if (forUser >= maxPerUser) return { ok: false, reason: 'user_limit' };
  }
  return { ok: true };
}

module.exports = { admitSession, listActiveSessions };

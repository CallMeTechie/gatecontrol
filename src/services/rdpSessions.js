'use strict';

const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');
const config = require('../../config/default');

function startSession(rdpRouteId, { tokenId, tokenName, peerId, clientIp }) {
  const db = getDb();
  const route = db.prepare('SELECT id, name FROM rdp_routes WHERE id = ?').get(rdpRouteId);
  if (!route) throw new Error('RDP route not found');
  const result = db.prepare(`
    INSERT INTO rdp_sessions (rdp_route_id, token_id, token_name, peer_id, status, client_ip)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(rdpRouteId, tokenId || null, tokenName || null, peerId || null, clientIp || null);
  const sessionId = result.lastInsertRowid;
  activity.log('rdp_session_start', `RDP session started: "${route.name}"`, {
    source: 'api', severity: 'info',
    details: { sessionId, routeId: rdpRouteId, tokenId, tokenName },
    ipAddress: clientIp,
  });
  logger.info({ sessionId, routeId: rdpRouteId, tokenName }, 'RDP session started');
  return { id: sessionId, status: 'active', started_at: new Date().toISOString() };
}

function heartbeatSession(sessionId, ownerCheck = null) {
  const db = getDb();
  const session = db.prepare('SELECT id, status, token_id, peer_id FROM rdp_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  if (ownerCheck && !_sessionOwnedBy(session, ownerCheck)) throw new Error('Session not owned by caller');
  if (session.status !== 'active') throw new Error('Session is not active');
  db.prepare("UPDATE rdp_sessions SET last_heartbeat = datetime('now') WHERE id = ?").run(sessionId);
  return true;
}

function _sessionOwnedBy(session, { tokenId, peerId }) {
  if (tokenId != null && session.token_id != null && session.token_id === tokenId) return true;
  if (peerId != null && session.peer_id != null && session.peer_id === peerId) return true;
  return false;
}

function endSession(sessionId, endReason = 'normal', ownerCheck = null) {
  const db = getDb();
  const session = db.prepare(`
    SELECT s.id, s.rdp_route_id, s.token_id, s.peer_id, s.token_name, s.started_at, r.name as route_name
    FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id WHERE s.id = ?
  `).get(sessionId);
  if (!session) throw new Error('Session not found');
  if (ownerCheck && !_sessionOwnedBy(session, ownerCheck)) throw new Error('Session not owned by caller');
  const startedAt = new Date(session.started_at + 'Z');
  const durationSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  db.prepare(`UPDATE rdp_sessions SET status = 'ended', ended_at = datetime('now'), duration_seconds = ?, end_reason = ? WHERE id = ?`).run(durationSeconds, endReason, sessionId);
  activity.log('rdp_session_end', `RDP session ended: "${session.route_name}" (${durationSeconds}s, ${endReason})`, {
    source: 'api', severity: 'info',
    details: { sessionId, routeId: session.rdp_route_id, durationSeconds, endReason },
  });
  logger.info({ sessionId, durationSeconds, endReason }, 'RDP session ended');
  return { id: sessionId, duration_seconds: durationSeconds, end_reason: endReason };
}

function getHistory(rdpRouteId, { limit = 50, offset = 0 } = {}) {
  const db = getDb();
  return db.prepare('SELECT * FROM rdp_sessions WHERE rdp_route_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?').all(rdpRouteId, limit, offset);
}

function getGlobalHistory({ limit = 50, offset = 0, status, since, until } = {}) {
  const db = getDb();
  let query = `SELECT s.*, r.name as route_name, r.host as route_host, r.port as route_port, p.name as peer_name, u.display_name as user_display_name FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id LEFT JOIN peers p ON s.peer_id = p.id LEFT JOIN api_tokens t ON s.token_id = t.id LEFT JOIN users u ON t.user_id = u.id`;
  const conditions = [];
  const params = [];
  if (status) { conditions.push('s.status = ?'); params.push(status); }
  if (since) { conditions.push('s.started_at >= ?'); params.push(since); }
  if (until) { conditions.push('s.started_at <= ?'); params.push(until); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.started_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}

function getGlobalHistoryCount({ status, since, until } = {}) {
  const db = getDb();
  let query = 'SELECT COUNT(*) as count FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id';
  const conditions = [];
  const params = [];
  if (status) { conditions.push('s.status = ?'); params.push(status); }
  if (since) { conditions.push('s.started_at >= ?'); params.push(since); }
  if (until) { conditions.push('s.started_at <= ?'); params.push(until); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  return db.prepare(query).get(...params).count;
}

function findActiveSession(routeId, { tokenId = null, peerId = null } = {}) {
  const db = getDb();
  if (tokenId != null) {
    return db.prepare("SELECT * FROM rdp_sessions WHERE rdp_route_id = ? AND token_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(routeId, tokenId);
  }
  if (peerId != null) {
    return db.prepare("SELECT * FROM rdp_sessions WHERE rdp_route_id = ? AND peer_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(routeId, peerId);
  }
  // Intentionally no owner-less fallback: callers that need to pick any
  // active session must pass { admin: true } (not implemented here) —
  // unauthenticated scope-wide lookup would otherwise allow cross-user
  // session kills. Returning null forces the caller to supply owner info.
  return null;
}

function getActiveSessionCounts() {
  const db = getDb();
  return db.prepare("SELECT rdp_route_id, COUNT(*) as count FROM rdp_sessions WHERE status = 'active' GROUP BY rdp_route_id").all();
}

function getActiveSessionDetails() {
  const db = getDb();
  return db.prepare(`
    SELECT rdp_route_id,
           COUNT(*) as count,
           GROUP_CONCAT(token_name, ', ') as user_names
    FROM rdp_sessions
    WHERE status = 'active'
    GROUP BY rdp_route_id
  `).all();
}

function getLastAccess() {
  const db = getDb();
  return db.prepare(`
    SELECT rdp_route_id, MAX(started_at) as last_access
    FROM rdp_sessions
    GROUP BY rdp_route_id
  `).all();
}

function cleanupStaleSessions() {
  const db = getDb();
  const timeoutSeconds = config.rdp.sessionHeartbeatTimeout;

  // 1. Sessions with heartbeat that stopped responding
  const staleHeartbeat = db.prepare(`SELECT id FROM rdp_sessions WHERE status = 'active' AND last_heartbeat IS NOT NULL AND last_heartbeat < datetime('now', '-' || ? || ' seconds')`).all(timeoutSeconds);

  // 2. Sessions without any heartbeat that have been active too long (client
  //    crashed or never implemented heartbeat — e.g. Android FreeRDP client).
  //    Use 5 minutes as timeout for sessions that never sent a heartbeat.
  const noHeartbeatTimeout = 300;
  const staleNoHeartbeat = db.prepare(`SELECT id FROM rdp_sessions WHERE status = 'active' AND last_heartbeat IS NULL AND started_at < datetime('now', '-' || ? || ' seconds')`).all(noHeartbeatTimeout);

  const stale = [...staleHeartbeat, ...staleNoHeartbeat];
  for (const session of stale) {
    try { endSession(session.id, 'timeout'); } catch (err) {
      logger.warn({ sessionId: session.id, error: err.message }, 'Failed to cleanup stale RDP session');
    }
  }
  if (stale.length > 0) logger.info({ count: stale.length }, 'Cleaned up stale RDP sessions');
  return stale.length;
}

function exportCsv({ since, until, routeId } = {}) {
  const db = getDb();
  let query = `SELECT s.*, r.name as route_name, r.host as route_host, r.port as route_port FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id`;
  const conditions = [];
  const params = [];
  if (routeId) { conditions.push('s.rdp_route_id = ?'); params.push(routeId); }
  if (since) { conditions.push('s.started_at >= ?'); params.push(since); }
  if (until) { conditions.push('s.started_at <= ?'); params.push(until); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.started_at DESC';
  const rows = db.prepare(query).all(...params);
  // Quote every field, neutralize Excel formula-injection. route_name /
  // token_name / end_reason are user-controlled — admin may paste anything
  // into them, and client_ip could theoretically be a spoofed X-Forwarded
  // value on some setups. Treat every cell as potentially hostile.
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const header = 'id,route_name,route_host,route_port,token_name,status,started_at,ended_at,duration_seconds,end_reason,client_ip\n';
  const lines = rows.map(r => [r.id, r.route_name, r.route_host, r.route_port, r.token_name, r.status, r.started_at, r.ended_at, r.duration_seconds, r.end_reason, r.client_ip].map(esc).join(','));
  return header + lines.join('\n');
}

module.exports = { startSession, heartbeatSession, endSession, findActiveSession, getHistory, getGlobalHistory, getGlobalHistoryCount, getActiveSessionCounts, getActiveSessionDetails, getLastAccess, cleanupStaleSessions, exportCsv };

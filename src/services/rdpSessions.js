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

function heartbeatSession(sessionId) {
  const db = getDb();
  const session = db.prepare('SELECT id, status FROM rdp_sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  if (session.status !== 'active') throw new Error('Session is not active');
  db.prepare("UPDATE rdp_sessions SET last_heartbeat = datetime('now') WHERE id = ?").run(sessionId);
  return true;
}

function endSession(sessionId, endReason = 'normal') {
  const db = getDb();
  const session = db.prepare(`
    SELECT s.id, s.rdp_route_id, s.token_name, s.started_at, r.name as route_name
    FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id WHERE s.id = ?
  `).get(sessionId);
  if (!session) throw new Error('Session not found');
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
  let query = `SELECT s.*, r.name as route_name, r.host, r.port FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id`;
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

function getActiveSessionCounts() {
  const db = getDb();
  return db.prepare("SELECT rdp_route_id, COUNT(*) as count FROM rdp_sessions WHERE status = 'active' GROUP BY rdp_route_id").all();
}

function cleanupStaleSessions() {
  const db = getDb();
  const timeoutSeconds = config.rdp.sessionHeartbeatTimeout;
  const stale = db.prepare(`SELECT id FROM rdp_sessions WHERE status = 'active' AND last_heartbeat IS NOT NULL AND last_heartbeat < datetime('now', '-' || ? || ' seconds')`).all(timeoutSeconds);
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
  let query = `SELECT s.*, r.name as route_name, r.host, r.port FROM rdp_sessions s JOIN rdp_routes r ON r.id = s.rdp_route_id`;
  const conditions = [];
  const params = [];
  if (routeId) { conditions.push('s.rdp_route_id = ?'); params.push(routeId); }
  if (since) { conditions.push('s.started_at >= ?'); params.push(since); }
  if (until) { conditions.push('s.started_at <= ?'); params.push(until); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.started_at DESC';
  const rows = db.prepare(query).all(...params);
  const header = 'id,route_name,host,port,token_name,status,started_at,ended_at,duration_seconds,end_reason,client_ip\n';
  const lines = rows.map(r => `${r.id},${r.route_name},${r.host},${r.port},${r.token_name || ''},${r.status},${r.started_at},${r.ended_at || ''},${r.duration_seconds || ''},${r.end_reason || ''},${r.client_ip || ''}`);
  return header + lines.join('\n');
}

module.exports = { startSession, heartbeatSession, endSession, getHistory, getGlobalHistory, getActiveSessionCounts, cleanupStaleSessions, exportCsv };
